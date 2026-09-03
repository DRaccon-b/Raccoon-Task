/* ==========================================================================
   Couples Quest — application logic
   Two roles share one Supabase project: the game master writes quests and
   shop items, the player completes them. Every change is pushed live to the
   other device over Postgres realtime.
   ========================================================================== */
'use strict';

/**
 * Bump on every deploy, and change the ?v= on the styles.css and app.js
 * tags in index.html to match — that pair is what forces phones to drop
 * the cached copies instead of quietly running the old build.
 */
const APP_VERSION = '1.2.1';

const SUPABASE_URL = 'https://acyyszsjixqbzucssfud.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjeXlzenNqaXhxYnp1Y3NzZnVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NTAzMjcsImV4cCI6MjEwNDAyNjMyN30.HIn7-kJX_Hh0l71kbiGiYrgOEUnoGSXk8mNt1ZMj59Q';

const ROLE_KEY = 'cq_role';
const HISTORY_LIMIT = 50;
const DEFAULT_ICON = '🎁';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Quest tiers, from everyday to rarest. `rank` orders the active list so
 * urgent work sits on top; `exp`/`tokens` only prefill the form, the game
 * master can always override them.
 */
const CATEGORIES = {
  rapid_fire: {
    label: 'Rapid Fire', icon: '🔥', rank: 0, exp: 40, tokens: 10,
    hint: 'Dringend — sollte heute noch erledigt werden.',
  },
  divine: {
    label: 'Divine', icon: '⭐', rank: 1, exp: 150, tokens: 40,
    hint: 'Die härteste Stufe. Große Aufgabe, große Belohnung.',
  },
  special: {
    label: 'Special', icon: '💎', rank: 2, exp: 60, tokens: 15,
    hint: 'Seltener als Basic — etwas, das nicht jede Woche ansteht.',
  },
  basic: {
    label: 'Basic', icon: '🪵', rank: 3, exp: 25, tokens: 5,
    hint: 'Alltagsaufgabe. Taucht eine Woche nach dem Abhaken wieder auf.',
  },
};

const DEFAULT_CATEGORY = 'basic';
const categoryOf = (quest) => CATEGORIES[quest.category] ? quest.category : DEFAULT_CATEGORY;

/* --- State --------------------------------------------------------------- */

const state = {
  role: null,          // 'player' | 'gm' | null
  gmTab: 'quests',     // 'quests' | 'shop' | 'history'
  stats: { level: 1, exp: 0, tokens: 0 },
  quests: [],
  shopItems: [],
  history: [],
  // Quest form: which tier is picked, and the quest being edited (null = new).
  formCategory: DEFAULT_CATEGORY,
  editingQuestId: null,
};

/** Supabase client, or null when the library failed to load. */
let sb = null;
/** Active realtime channel, so we can tear it down before re-subscribing. */
let channel = null;

/* --- Small helpers ------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

/** Escape text before it goes into an innerHTML template. */
function esc(value) {
  const el = document.createElement('div');
  el.textContent = value == null ? '' : String(value);
  return el.innerHTML;
}

/** EXP needed to advance from `level` to the next one. */
const expForLevel = (level) => 50 + level * 50;

/**
 * Add EXP and carry over into as many levels as it covers.
 * Returns the new level and the EXP left over inside it.
 */
function applyExp(stats, gain) {
  let level = stats.level;
  let exp = stats.exp + gain;
  while (exp >= expForLevel(level)) {
    exp -= expForLevel(level);
    level += 1;
  }
  return { level, exp };
}

function formatRelativeTime(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const ms = Date.now() - then.getTime();
  if (ms < 60_000) return 'Gerade eben';
  if (ms < 3_600_000) return `vor ${Math.floor(ms / 60_000)} Min.`;
  if (ms < 86_400_000) return `vor ${Math.floor(ms / 3_600_000)} Std.`;
  return then.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}

function emptyState(icon, text) {
  return `<div class="empty-state">
    <div class="empty-state__icon" aria-hidden="true">${icon}</div>
    <p class="empty-state__text">${esc(text)}</p>
  </div>`;
}

/* --- Notifications ------------------------------------------------------- */

let toastTimer = null;

function showToast(message, kind = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast toast--${kind} is-visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}

function showBanner(message) {
  const el = $('banner');
  el.textContent = message;
  el.classList.add('show');
}

function hideBanner() {
  $('banner').classList.remove('show');
}

/* --- Database access ----------------------------------------------------- */

/**
 * Guard every write. Without a client the UI still renders, but changes
 * cannot be saved — say so rather than throwing on a button press.
 */
function requireDb() {
  if (!sb) {
    showToast('Keine Verbindung zur Datenbank', 'error');
    return false;
  }
  return true;
}

/** Report a failed query once, in the user's language. */
function reportError(error, fallback) {
  console.error(fallback, error);
  showToast(error?.message ? `Fehler: ${error.message}` : fallback, 'error');
}

/**
 * Put recurring quests back on the board once their week is up. The filter
 * does the deciding, so both devices can run this and the second one is a
 * no-op rather than a double reset.
 */
async function reviveDueQuests() {
  if (!sb) return;
  const { error } = await sb.from('quests')
    .update({ status: 'active', completed_at: null, resets_at: null })
    .eq('status', 'done')
    .not('resets_at', 'is', null)
    .lte('resets_at', new Date().toISOString());

  if (error) console.error('Wiederkehrende Quests konnten nicht erneuert werden:', error);
}

async function loadAll() {
  if (!sb) return;
  await reviveDueQuests();

  const [stats, quests, shop, history] = await Promise.all([
    sb.from('player_stats').select('*').eq('id', 1).maybeSingle(),
    sb.from('quests').select('*').order('created_at', { ascending: false }),
    sb.from('shop_items').select('*').order('created_at', { ascending: false }),
    sb.from('history').select('*').order('timestamp', { ascending: false }).limit(HISTORY_LIMIT),
  ]);

  const failure = [stats, quests, shop, history].find((r) => r.error);
  if (failure) {
    showBanner('Daten konnten nicht geladen werden. Prüfe deine Verbindung.');
    console.error('Laden fehlgeschlagen:', failure.error);
    return;
  }

  hideBanner();
  if (stats.data) state.stats = stats.data;
  state.quests = quests.data ?? [];
  state.shopItems = shop.data ?? [];
  state.history = history.data ?? [];
  renderAll();
}

/** Re-fetch one table and re-render the parts that depend on it. */
async function refresh(table) {
  if (!sb) return;

  if (table === 'player_stats') {
    const { data } = await sb.from('player_stats').select('*').eq('id', 1).maybeSingle();
    if (data) state.stats = data;
    // Affordability lives in the shop buttons, so the shop redraws too.
    renderHeader();
    renderShop();
    renderRaccoon();
    return;
  }

  if (table === 'quests') {
    const { data } = await sb.from('quests').select('*').order('created_at', { ascending: false });
    state.quests = data ?? [];
    // The header's "open" counter is derived from the quest list.
    renderHeader();
    renderQuests();
    renderRaccoon();
    return;
  }

  if (table === 'shop_items') {
    const { data } = await sb.from('shop_items').select('*').order('created_at', { ascending: false });
    state.shopItems = data ?? [];
    renderShop();
    return;
  }

  if (table === 'history') {
    const { data } = await sb
      .from('history').select('*')
      .order('timestamp', { ascending: false }).limit(HISTORY_LIMIT);
    state.history = data ?? [];
    renderHistory();
  }
}

function subscribeRealtime() {
  if (!sb) return;
  if (channel) sb.removeChannel(channel);

  const tables = ['player_stats', 'quests', 'shop_items', 'history'];
  channel = sb.channel('couples-quest');

  for (const table of tables) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => refresh(table));
  }

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') hideBanner();
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      showBanner('Live-Verbindung unterbrochen. Ziehe zum Aktualisieren.');
    }
  });
}

/* --- Rendering ----------------------------------------------------------- */

function renderAll() {
  renderHeader();
  renderQuests();
  renderShop();
  renderHistory();
  renderRaccoon();
}

function renderHeader() {
  const { level, exp, tokens } = state.stats;
  const needed = expForLevel(level);
  const pct = Math.min(100, Math.round((exp / needed) * 100));

  $('playerLevel').textContent = level;
  $('expFill').style.width = `${pct}%`;
  $('expText').textContent = `${exp} / ${needed}`;
  $('playerTokens').textContent = tokens;

  $('gmLevel').textContent = level;
  $('gmTokens').textContent = tokens;
  $('gmOpen').textContent = state.quests.filter((q) => q.status !== 'done').length;
}

/**
 * The raccoon reflects what the player actually has to do, so the home
 * screen tells you something instead of just idling.
 */
function renderRaccoon() {
  const active = state.quests.filter((q) => q.status === 'active').length;
  const pending = state.quests.filter((q) => q.status === 'pending_confirm').length;

  let mood = '😴';
  let status = 'Keine Quests offen. Zeit zum Chillen.';

  if (pending > 0) {
    mood = '🤞';
    status = pending === 1
      ? 'Eine Quest wartet auf Bestätigung.'
      : `${pending} Quests warten auf Bestätigung.`;
  } else if (active > 0) {
    mood = '💪';
    status = active === 1
      ? 'Eine Quest wartet auf dich!'
      : `${active} Quests warten auf dich!`;
  }

  $('raccoonMood').textContent = mood;
  $('raccoonStatus').textContent = status;
}

function questCard(quest, { forGameMaster }) {
  const labels = { active: 'Aktiv', pending_confirm: 'Warten', done: 'Fertig' };
  const modifier = { active: 'active', pending_confirm: 'pending', done: 'done' }[quest.status];
  const cat = categoryOf(quest);
  const tier = CATEGORIES[cat];

  let actions = '';
  if (forGameMaster && quest.status === 'pending_confirm') {
    actions = `<div class="action-row">
      <button class="btn btn--sm btn--confirm" data-action="confirm-quest" data-id="${quest.id}">✓ Bestätigen</button>
      <button class="btn btn--sm btn--neutral" data-action="deny-quest" data-id="${quest.id}">Zurückweisen</button>
    </div>`;
  } else if (forGameMaster && quest.status === 'active') {
    actions = `<div class="action-row">
      <button class="btn btn--sm btn--neutral" data-action="edit-quest" data-id="${quest.id}">Bearbeiten</button>
      <button class="btn btn--sm btn--danger" data-action="delete-quest" data-id="${quest.id}">Löschen</button>
    </div>`;
  } else if (!forGameMaster && quest.status === 'active') {
    actions = `<div class="action-row">
      <button class="btn btn--block btn--confirm" data-action="submit-quest" data-id="${quest.id}">✓ Erledigt!</button>
    </div>`;
  }

  const rewards = quest.status === 'done' ? '' : `<div class="reward-row">
    <span class="reward-chip"><span class="reward-chip__icon" aria-hidden="true">⚡</span>${quest.exp_reward} EXP</span>
    <span class="reward-chip"><span class="reward-chip__icon" aria-hidden="true">◆</span>${quest.token_reward} Tokens</span>
  </div>`;

  // A finished recurring quest says when it comes back, so it does not
  // read as simply gone.
  const repeat = quest.status === 'done' && quest.resets_at
    ? `<span class="repeat-note">↻ ${formatReturn(quest.resets_at)}</span>`
    : '';

  return `<article class="quest-card${quest.status === 'done' ? ' quest-card--muted' : ''}" data-cat="${cat}">
    <div class="quest-card__head">
      <h3 class="quest-card__name">${esc(quest.name)}</h3>
      <span class="badge badge--${modifier}">${labels[quest.status]}</span>
    </div>
    <div class="quest-card__meta">
      <span class="tier tier--${cat}">
        <span class="tier__icon" aria-hidden="true">${tier.icon}</span>${tier.label}
      </span>
      ${repeat}
    </div>
    ${quest.description ? `<p class="quest-card__desc">${esc(quest.description)}</p>` : ''}
    ${rewards}
    ${actions}
  </article>`;
}

/** "in 3 Tagen" / "bald wieder" for a recurring quest's return date. */
function formatReturn(iso) {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (Number.isNaN(days)) return 'kehrt wieder';
  if (days <= 0) return 'gleich wieder da';
  if (days === 1) return 'morgen wieder';
  return `in ${days} Tagen wieder`;
}

/** Rarest and most urgent first, then newest. */
function byTier(a, b) {
  const diff = CATEGORIES[categoryOf(a)].rank - CATEGORIES[categoryOf(b)].rank;
  return diff !== 0 ? diff : String(b.created_at).localeCompare(String(a.created_at));
}

function renderQuests() {
  const active = state.quests.filter((q) => q.status === 'active').sort(byTier);
  const pending = state.quests.filter((q) => q.status === 'pending_confirm').sort(byTier);
  const done = state.quests.filter((q) => q.status === 'done');

  // Player
  const playerEl = $('playerQuestList');
  if (state.quests.length === 0) {
    playerEl.innerHTML = emptyState('📜', 'Noch keine Quests. Dein Game Master muss dir erst welche erstellen!');
  } else {
    let html = '';
    if (active.length) {
      html += '<h2 class="section-title">Aktive Quests</h2>';
      html += active.map((q) => questCard(q, { forGameMaster: false })).join('');
    }
    if (pending.length) {
      html += '<h2 class="section-title">Warten auf Bestätigung</h2>';
      html += pending.map((q) => questCard(q, { forGameMaster: false })).join('');
    }
    if (done.length) {
      html += '<h2 class="section-title section-title--muted">Erledigt</h2>';
      html += done.slice(0, 10).map((q) => questCard(q, { forGameMaster: false })).join('');
    }
    playerEl.innerHTML = html;
  }

  // Game master
  const gmEl = $('gmQuestsPanel');
  if (state.quests.length === 0) {
    gmEl.innerHTML = emptyState('📜', 'Noch keine Quests erstellt. Tippe auf + um loszulegen!');
  } else {
    let html = '';
    if (pending.length) {
      html += '<h2 class="section-title section-title--alert">🔔 Bestätigung ausstehend</h2>';
      html += pending.map((q) => questCard(q, { forGameMaster: true })).join('');
    }
    if (active.length) {
      html += '<h2 class="section-title">Aktive Quests</h2>';
      html += active.map((q) => questCard(q, { forGameMaster: true })).join('');
    }
    if (done.length) {
      html += '<h2 class="section-title section-title--muted">Erledigt</h2>';
      html += done.slice(0, 5).map((q) => questCard(q, { forGameMaster: true })).join('');
    }
    gmEl.innerHTML = html;
  }
}

function renderShop() {
  // Player
  const playerEl = $('playerShopList');
  if (state.shopItems.length === 0) {
    playerEl.innerHTML = emptyState('🛍️', 'Der Shop ist noch leer. Dein Game Master füllt ihn bald!');
  } else {
    playerEl.innerHTML = '<h2 class="section-title">Wifey Shop</h2>' + state.shopItems.map((item) => {
      const free = item.price === 0;
      const affordable = state.stats.tokens >= item.price;
      return `<article class="shop-item">
        <div class="shop-item__icon" aria-hidden="true">${esc(item.icon || DEFAULT_ICON)}</div>
        <div class="shop-item__info">
          <h3 class="shop-item__name">${esc(item.name)}</h3>
          ${item.description ? `<p class="shop-item__desc">${esc(item.description)}</p>` : ''}
        </div>
        <button class="buy-btn${free ? ' free-tag' : ''}" data-action="buy-item"
                data-id="${item.id}"${affordable ? '' : ' disabled'}>
          ${free ? 'Gratis' : `◆ ${item.price}`}
        </button>
      </article>`;
    }).join('');
  }

  // Game master
  const gmEl = $('gmShopPanel');
  if (state.shopItems.length === 0) {
    gmEl.innerHTML = emptyState('🛍️', 'Noch keine Artikel. Tippe auf + um welche hinzuzufügen!');
  } else {
    gmEl.innerHTML = state.shopItems.map((item) => `<article class="shop-item">
      <div class="shop-item__icon" aria-hidden="true">${esc(item.icon || DEFAULT_ICON)}</div>
      <div class="shop-item__info">
        <h3 class="shop-item__name">${esc(item.name)}</h3>
        ${item.description ? `<p class="shop-item__desc">${esc(item.description)}</p>` : ''}
        <div class="action-row">
          <button class="btn btn--sm btn--danger" data-action="delete-item" data-id="${item.id}">Entfernen</button>
        </div>
      </div>
      <span class="token-count">${item.price === 0 ? 'Gratis' : `◆ ${item.price}`}</span>
    </article>`).join('');
  }
}

function renderHistory() {
  const icons = { quest_done: '⚔️', purchase: '🛍️', level_up: '⭐' };

  if (state.history.length === 0) {
    const empty = emptyState('📖', 'Noch kein Verlauf vorhanden.');
    $('gmHistoryPanel').innerHTML = empty;
    $('playerHistoryList').innerHTML = empty;
    return;
  }

  const rows = state.history.map((entry) => {
    let value = '';
    if (entry.exp_gain) value += `<span class="log-entry__value log-entry__value--exp">+${entry.exp_gain} EXP</span>`;
    if (entry.token_gain) value += `<span class="log-entry__value log-entry__value--gain">+${entry.token_gain} ◆</span>`;
    if (entry.token_spent) value += `<span class="log-entry__value log-entry__value--spent">−${entry.token_spent} ◆</span>`;

    return `<div class="log-entry">
      <span class="log-entry__icon" aria-hidden="true">${icons[entry.type] ?? '📄'}</span>
      <div class="log-entry__info">
        <div class="log-entry__title">${esc(entry.title)}</div>
        <div class="log-entry__time">${formatRelativeTime(entry.timestamp)}</div>
      </div>
      ${value}
    </div>`;
  }).join('');

  $('gmHistoryPanel').innerHTML = '<h2 class="section-title">Verlauf</h2>' + rows;
  $('playerHistoryList').innerHTML = '<h2 class="section-title">Belohnungen &amp; Verlauf</h2>' + rows;
}

/* --- Navigation ---------------------------------------------------------- */

function setRole(role) {
  state.role = role;
  try { localStorage.setItem(ROLE_KEY, role); } catch { /* private mode */ }

  $('screenRole').hidden = true;
  $('screenPlayer').hidden = role !== 'player';
  $('screenGm').hidden = role !== 'gm';
  // Lets the version marker dodge the bottom bar / action button.
  document.body.dataset.screen = role;

  // Always open the QuestBook on the quest list — that is where pending
  // confirmations show up, and they are the reason to open it at all.
  if (role === 'gm') setGmTab('quests');
  renderAll();
}

function clearRole() {
  state.role = null;
  try { localStorage.removeItem(ROLE_KEY); } catch { /* private mode */ }

  $('screenPlayer').hidden = true;
  $('screenGm').hidden = true;
  $('screenRole').hidden = false;
  document.body.dataset.screen = 'role';
}

function setPlayerView(viewId) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === viewId);
  });
  document.querySelectorAll('#screenPlayer .view').forEach((view) => {
    view.classList.toggle('is-active', view.id === viewId);
  });
}

function setGmTab(tab) {
  state.gmTab = tab;
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  $('gmQuestsPanel').hidden = tab !== 'quests';
  $('gmShopPanel').hidden = tab !== 'shop';
  $('gmHistoryPanel').hidden = tab !== 'history';

  // Nothing to create on the history tab.
  $('fab').hidden = tab === 'history';
}

function openModal(id) { $(id).classList.add('is-open'); }
function closeModal(id) { $(id).classList.remove('is-open'); }

/* --- Actions ------------------------------------------------------------- */

/** Highlight a tier and, for a new quest, prefill its suggested rewards. */
function pickTier(category, { prefillRewards }) {
  state.formCategory = category;

  document.querySelectorAll('.tier-option').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.cat === category);
  });
  $('tierHint').textContent = CATEGORIES[category].hint;

  if (prefillRewards) {
    $('questExp').value = CATEGORIES[category].exp;
    $('questTokens').value = CATEGORIES[category].tokens;
  }
}

function openQuestForm(quest) {
  state.editingQuestId = quest?.id ?? null;

  $('questModalTitle').textContent = quest ? 'Quest bearbeiten' : 'Neue Quest';
  $('questSubmit').textContent = quest ? 'Änderungen speichern' : 'Quest erstellen';
  $('questName').value = quest?.name ?? '';
  $('questDesc').value = quest?.description ?? '';
  $('questExp').value = quest?.exp_reward ?? CATEGORIES[DEFAULT_CATEGORY].exp;
  $('questTokens').value = quest?.token_reward ?? CATEGORIES[DEFAULT_CATEGORY].tokens;

  // Editing keeps the rewards already agreed; a new quest gets the tier's.
  pickTier(quest ? categoryOf(quest) : DEFAULT_CATEGORY, { prefillRewards: false });
  openModal('questModal');
}

async function saveQuest(form) {
  if (!requireDb()) return;
  const data = new FormData(form);
  const name = String(data.get('name')).trim();
  if (!name) { showToast('Bitte einen Namen eingeben', 'error'); return; }

  const fields = {
    name,
    description: String(data.get('description')).trim(),
    exp_reward: Math.max(0, Number(data.get('exp')) || 0),
    token_reward: Math.max(0, Number(data.get('tokens')) || 0),
    category: state.formCategory,
  };

  const editingId = state.editingQuestId;
  const { error } = editingId
    ? await sb.from('quests').update(fields).eq('id', editingId)
    : await sb.from('quests').insert({ ...fields, status: 'active' });

  if (error) {
    reportError(error, editingId ? 'Quest konnte nicht gespeichert werden' : 'Quest konnte nicht erstellt werden');
    return;
  }

  form.reset();
  state.editingQuestId = null;
  closeModal('questModal');
  showToast(editingId ? 'Quest gespeichert!' : 'Quest erstellt!', 'success');
}

async function createShopItem(form) {
  if (!requireDb()) return;
  const data = new FormData(form);
  const name = String(data.get('name')).trim();
  if (!name) { showToast('Bitte einen Namen eingeben', 'error'); return; }

  const { error } = await sb.from('shop_items').insert({
    name,
    description: String(data.get('description')).trim(),
    icon: String(data.get('icon')).trim() || DEFAULT_ICON,
    price: Math.max(0, Number(data.get('price')) || 0),
  });

  if (error) { reportError(error, 'Artikel konnte nicht erstellt werden'); return; }

  form.reset();
  closeModal('shopModal');
  showToast('Artikel hinzugefügt!', 'success');
}

async function submitQuest(id) {
  if (!requireDb()) return;
  const { error } = await sb.from('quests')
    .update({ status: 'pending_confirm' })
    .eq('id', id).eq('status', 'active');

  if (error) { reportError(error, 'Quest konnte nicht eingereicht werden'); return; }
  showToast('Eingereicht! Warte auf Bestätigung.', 'info');
}

async function confirmQuest(id) {
  if (!requireDb()) return;

  // Read the quest back rather than trusting the local copy, and let the
  // status filter reject a double confirm from a second device.
  const { data: quest, error: readError } = await sb
    .from('quests').select('*').eq('id', id).maybeSingle();

  if (readError) { reportError(readError, 'Quest konnte nicht geladen werden'); return; }
  if (!quest || quest.status !== 'pending_confirm') {
    showToast('Diese Quest wurde bereits bearbeitet', 'info');
    return;
  }

  // Basic quests are the weekly chores: schedule their return as they close.
  const recurring = categoryOf(quest) === 'basic';
  const { data: claimed, error: claimError } = await sb.from('quests')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      resets_at: recurring ? new Date(Date.now() + WEEK_MS).toISOString() : null,
    })
    .eq('id', id).eq('status', 'pending_confirm')
    .select();

  if (claimError) { reportError(claimError, 'Quest konnte nicht bestätigt werden'); return; }
  if (!claimed || claimed.length === 0) {
    showToast('Diese Quest wurde bereits bestätigt', 'info');
    return;
  }

  const previousLevel = state.stats.level;
  const { level, exp } = applyExp(state.stats, quest.exp_reward);
  const tokens = state.stats.tokens + quest.token_reward;

  const { error: statsError } = await sb.from('player_stats')
    .update({ level, exp, tokens, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (statsError) { reportError(statsError, 'Belohnung konnte nicht gutgeschrieben werden'); return; }

  const entries = [{
    type: 'quest_done',
    title: quest.name,
    exp_gain: quest.exp_reward,
    token_gain: quest.token_reward,
  }];
  if (level > previousLevel) {
    entries.push({ type: 'level_up', title: `Level ${level} erreicht!` });
  }
  await sb.from('history').insert(entries);

  showToast(`Bestätigt! +${quest.exp_reward} EXP, +${quest.token_reward} Tokens`, 'success');
  if (level > previousLevel) setTimeout(() => showLevelUp(level), 600);
}

async function denyQuest(id) {
  if (!requireDb()) return;
  const { error } = await sb.from('quests').update({ status: 'active' }).eq('id', id);
  if (error) { reportError(error, 'Quest konnte nicht zurückgewiesen werden'); return; }
  showToast('Zurückgewiesen', 'info');
}

async function deleteQuest(id) {
  if (!requireDb()) return;
  const { error } = await sb.from('quests').delete().eq('id', id);
  if (error) { reportError(error, 'Quest konnte nicht gelöscht werden'); return; }
  showToast('Quest gelöscht', 'info');
}

async function deleteShopItem(id) {
  if (!requireDb()) return;
  const { error } = await sb.from('shop_items').delete().eq('id', id);
  if (error) { reportError(error, 'Artikel konnte nicht entfernt werden'); return; }
  showToast('Artikel entfernt', 'info');
}

async function buyItem(id) {
  if (!requireDb()) return;

  const item = state.shopItems.find((s) => s.id === id);
  if (!item) return;
  if (state.stats.tokens < item.price) {
    showToast('Nicht genug Tokens!', 'error');
    return;
  }

  // A free item costs nothing, so there is no balance to guard — skip
  // straight to logging it.
  if (item.price > 0) {
    const remaining = state.stats.tokens - item.price;
    // gte() makes the balance check part of the write, so two quick taps
    // cannot spend the same tokens twice.
    const { data, error } = await sb.from('player_stats')
      .update({ tokens: remaining, updated_at: new Date().toISOString() })
      .eq('id', 1).gte('tokens', item.price)
      .select();

    if (error) { reportError(error, 'Kauf fehlgeschlagen'); return; }
    if (!data || data.length === 0) {
      showToast('Nicht genug Tokens!', 'error');
      return;
    }
  }

  await sb.from('history').insert({
    type: 'purchase',
    title: item.name,
    token_spent: item.price,
  });

  showToast(`${item.name} eingelöst!`, 'success');
}

function showLevelUp(level) {
  $('levelupLevel').textContent = level;
  $('levelup').classList.add('is-open');
}

/* --- Event wiring -------------------------------------------------------- */

const actions = {
  'pick-role': (el) => setRole(el.dataset.role),
  'switch-role': () => clearRole(),
  'player-tab': (el) => setPlayerView(el.dataset.view),
  'gm-tab': (el) => setGmTab(el.dataset.tab),
  'open-create': () => {
    if (state.gmTab === 'shop') { openModal('shopModal'); return; }
    openQuestForm(null);
  },
  'pick-tier': (el) => pickTier(el.dataset.cat, { prefillRewards: !state.editingQuestId }),
  'edit-quest': (el) => {
    const quest = state.quests.find((q) => q.id === el.dataset.id);
    if (quest) openQuestForm(quest);
  },
  'dismiss-levelup': () => $('levelup').classList.remove('is-open'),
  'submit-quest': (el) => submitQuest(el.dataset.id),
  'confirm-quest': (el) => confirmQuest(el.dataset.id),
  'deny-quest': (el) => denyQuest(el.dataset.id),
  'delete-quest': (el) => deleteQuest(el.dataset.id),
  'delete-item': (el) => deleteShopItem(el.dataset.id),
  'buy-item': (el) => buyItem(el.dataset.id),
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const handler = actions[target.dataset.action];
  if (handler) handler(target);
});

// Tapping the dimmed area closes a sheet.
document.querySelectorAll('.modal').forEach((modal) => {
  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.classList.remove('is-open');
  });
});

/**
 * Swipe-down-to-dismiss for the bottom sheets, matching the iOS gesture.
 * Only starts when the touch begins on the handle or while the sheet's own
 * content is scrolled to the top — otherwise a drag inside a scrollable
 * sheet would fight the page instead of scrolling it.
 */
function makeSheetDraggable(sheet) {
  const modal = sheet.closest('.modal');
  let startY = null;
  let currentY = 0;
  let dragging = false;

  const canStartDrag = (target) => {
    if (target.closest('.sheet__handle')) return true;
    // Don't hijack taps/drags meant for form controls (typing, selecting,
    // tapping a tier button) — only bare sheet area starts a drag.
    if (target.closest('input, textarea, select, button, a')) return false;
    return sheet.scrollTop <= 0;
  };

  sheet.addEventListener('touchstart', (event) => {
    if (!canStartDrag(event.target)) { startY = null; return; }
    startY = event.touches[0].clientY;
    currentY = 0;
    dragging = false;
    sheet.style.transition = 'none';
  }, { passive: true });

  sheet.addEventListener('touchmove', (event) => {
    if (startY == null) return;
    const delta = event.touches[0].clientY - startY;
    if (delta <= 0) { currentY = 0; return; } // ignore upward drags
    dragging = true;
    currentY = delta;
    sheet.style.transform = `translateY(${delta}px)`;
  }, { passive: true });

  const endDrag = () => {
    if (startY == null) return;
    sheet.style.transition = '';
    sheet.style.transform = '';
    // Far enough, or a real drag past a small threshold: close it.
    if (dragging && currentY > 110) {
      modal.classList.remove('is-open');
    }
    startY = null;
    currentY = 0;
    dragging = false;
  };

  sheet.addEventListener('touchend', endDrag);
  sheet.addEventListener('touchcancel', endDrag);
}

document.querySelectorAll('.sheet').forEach(makeSheetDraggable);

$('questForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveQuest(event.currentTarget);
});

$('shopForm').addEventListener('submit', (event) => {
  event.preventDefault();
  createShopItem(event.currentTarget);
});

/* --- Boot ---------------------------------------------------------------- */

function start() {
  $('version').textContent = `v${APP_VERSION}`;
  document.body.dataset.screen = 'role';
  pickTier(DEFAULT_CATEGORY, { prefillRewards: true });

  if (window.supabase?.createClient) {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    showBanner('Datenbank nicht erreichbar — Änderungen werden nicht gespeichert.');
    console.error('supabase-js konnte nicht geladen werden.');
  }

  let savedRole = null;
  try { savedRole = localStorage.getItem(ROLE_KEY); } catch { /* private mode */ }
  if (savedRole === 'player' || savedRole === 'gm') {
    setRole(savedRole);
  } else {
    renderAll();
  }

  setGmTab(state.gmTab);
  loadAll();
  subscribeRealtime();
}

start();
