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
const APP_VERSION = '1.10.0';

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

/**
 * Shop icons offered as taps. All are long-established emoji, so they render
 * on any phone — unlike the newest Unicode additions, which show as an empty
 * box on an OS that predates them.
 */
const SHOP_ICONS = [
  '🎁', '💆', '🍿', '🛁', '🍫', '🥂', '💋', '🧸',
  '🌹', '🍳', '☕', '🎮', '💰', '🏆', '🍑', '❤️',
];

/**
 * How a limited shop item refills. `never` is a one-off: once it is gone it
 * stays gone until the game master edits it.
 */
const RESET_PERIODS = {
  never: { label: 'Einmalig', short: 'einmalig', hint: 'Ist es weg, bleibt es weg.' },
  daily: { label: 'Täglich', short: 'täglich', hint: 'Füllt sich jede Nacht wieder auf.' },
  weekly: { label: 'Wöchentlich', short: 'wöchentlich', hint: 'Füllt sich jeden Montag wieder auf.' },
  monthly: { label: 'Monatlich', short: 'monatlich', hint: 'Füllt sich am Monatsersten wieder auf.' },
};

const DEFAULT_PERIOD = 'never';

/**
 * Start of the next period, so a daily item refills at midnight rather than
 * a rolling 24 hours after whenever the app happened to be opened.
 */
function nextResetAt(period, from = new Date()) {
  const at = new Date(from);
  if (period === 'daily') {
    at.setHours(24, 0, 0, 0);
    return at;
  }
  if (period === 'weekly') {
    at.setHours(0, 0, 0, 0);
    at.setDate(at.getDate() + ((8 - at.getDay()) % 7 || 7)); // next Monday
    return at;
  }
  if (period === 'monthly') {
    at.setHours(0, 0, 0, 0);
    at.setDate(1);
    at.setMonth(at.getMonth() + 1);
    return at;
  }
  return null;
}

/** Stock facts for one item, in one place — the views all ask the same thing. */
function stockOf(item) {
  const limited = item.stock_max != null;
  const left = limited ? Math.max(0, item.stock_left ?? 0) : null;
  return { limited, left, max: item.stock_max, soldOut: limited && left <= 0 };
}

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
  chests: [],           // confirmed quests' rewards, unopened
  // Quest form: which tier is picked, and the quest being edited (null = new).
  formCategory: DEFAULT_CATEGORY,
  editingQuestId: null,
  editingItemId: null,   // shop item being edited (null = new)
  formPeriod: DEFAULT_PERIOD,  // refill rhythm picked in the shop form
  showArchive: false,    // archive section expanded in the QuestBook
};

/** A level-up queued behind the chest-reveal overlay, shown once it closes. */
let pendingLevelUp = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Keep only the first character a reader actually sees. An emoji can be
 * several code units, and a flag or family several code points, so counting
 * characters is not enough — two pasted emoji would otherwise both land in
 * a tile sized for one and spill out of it.
 */
function firstEmoji(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(text)) return segment;
    return '';
  }

  // Older engines: take the first code point plus anything that attaches to
  // it — variation selectors, skin tones, and zero-width-joined parts.
  const chars = [...text];
  let out = chars[0];
  let afterJoiner = false;
  for (let i = 1; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    const attaches = afterJoiner || cp === 0xFE0F || cp === 0x200D
      || (cp >= 0x1F3FB && cp <= 0x1F3FF);
    if (!attaches) break;
    out += chars[i];
    afterJoiner = cp === 0x200D;
  }
  return out;
}

/** The icon to draw for a shop item, normalised and never empty. */
const shopIcon = (item) => firstEmoji(item.icon) || DEFAULT_ICON;

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
 * no-op rather than a double reset. A quest that was filed away comes back
 * out with it — being archived tidies it, it does not cancel it.
 */
async function reviveDueQuests() {
  if (!sb) return;
  const { error } = await sb.from('quests')
    .update({ status: 'active', completed_at: null, resets_at: null, archived_at: null })
    .eq('status', 'done')
    .not('resets_at', 'is', null)
    .lte('resets_at', new Date().toISOString());

  if (error) console.error('Wiederkehrende Quests konnten nicht erneuert werden:', error);
}

/**
 * Refill limited shop items whose period has rolled over. Each update is
 * filtered on the reset time it is replacing, so two phones opening at the
 * same moment cannot refill the same item twice.
 * Returns true when anything was refilled, so the caller re-reads the shop.
 */
async function refillDueStock(items) {
  if (!sb) return false;
  const now = Date.now();
  const due = items.filter((item) =>
    item.stock_max != null
    && item.reset_period !== 'never'
    && item.stock_reset_at
    && new Date(item.stock_reset_at).getTime() <= now);

  if (!due.length) return false;

  const results = await Promise.all(due.map((item) => sb.from('shop_items')
    .update({
      stock_left: item.stock_max,
      stock_reset_at: nextResetAt(item.reset_period).toISOString(),
    })
    .eq('id', item.id)
    .eq('stock_reset_at', item.stock_reset_at)));

  const failure = results.find((r) => r.error);
  if (failure) console.error('Shop-Bestand konnte nicht aufgefüllt werden:', failure.error);
  return true;
}

async function loadAll() {
  if (!sb) return;
  await reviveDueQuests();

  const [stats, quests, shop, history, chests] = await Promise.all([
    sb.from('player_stats').select('*').eq('id', 1).maybeSingle(),
    sb.from('quests').select('*').order('created_at', { ascending: false }),
    sb.from('shop_items').select('*').order('created_at', { ascending: false }),
    sb.from('history').select('*').order('timestamp', { ascending: false }).limit(HISTORY_LIMIT),
    sb.from('chests').select('*').order('created_at', { ascending: true }),
  ]);

  const failure = [stats, quests, shop, history, chests].find((r) => r.error);
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
  state.chests = chests.data ?? [];

  // Stock periods can only be judged once the items are in hand.
  if (await refillDueStock(state.shopItems)) {
    const { data } = await sb.from('shop_items').select('*').order('created_at', { ascending: false });
    if (data) state.shopItems = data;
  }

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
    return;
  }

  if (table === 'chests') {
    const { data } = await sb.from('chests').select('*').order('created_at', { ascending: true });
    state.chests = data ?? [];
    renderChests();
    // The raccoon's mood/status leads with "a chest is waiting".
    renderRaccoon();
  }
}

function subscribeRealtime() {
  if (!sb) return;
  if (channel) sb.removeChannel(channel);

  const tables = ['player_stats', 'quests', 'shop_items', 'history', 'chests'];
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
  renderChests();
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
  const chestCount = state.chests.length;

  let mood = '😴';
  let status = 'Keine Quests offen. Zeit zum Chillen.';

  if (chestCount > 0) {
    mood = '🤩';
    status = chestCount === 1
      ? 'Eine Truhe wartet auf dich!'
      : `${chestCount} Truhen warten auf dich!`;
  } else if (pending > 0) {
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
  renderGait(active);
}

/* Only active quests set the pace: one waiting on her confirmation is off his
   plate, and a chest is a reward rather than a chore. */
function gaitFor(active) {
  if (active === 0) return { gait: 'rest', step: 0 };
  if (active <= 2) return { gait: 'walk', step: active === 1 ? 0.74 : 0.64 };
  // From three onwards he runs, tightening by 0.03s per quest down to a floor
  // where the legs would otherwise blur into each other.
  return { gait: 'run', step: Math.max(0.26, 0.44 - (active - 3) * 0.03) };
}

function renderGait(active) {
  const scene = $('scene');
  if (!scene) return;
  const { gait, step } = gaitFor(active);
  scene.dataset.gait = gait;

  if (gait === 'rest') {
    // Let the stylesheet's own resting timings stand.
    scene.style.removeProperty('--step');
    scene.style.removeProperty('--road-speed');
    scene.style.removeProperty('--bush-speed');
    return;
  }

  // The ground has to keep pace with the legs, or he moonwalks.
  scene.style.setProperty('--step', `${step}s`);
  scene.style.setProperty('--road-speed', `${(step * 1.9).toFixed(3)}s`);
  scene.style.setProperty('--bush-speed', `${(step * 15).toFixed(2)}s`);
}

/* --- Chest artwork --------------------------------------------------------
   One chest per tier, drawn rather than just recoloured: a plain crate for
   Basic, a spiked hell-forge for Rapid Fire, a lacquered royal casket for
   Special, and a winged reliquary for Divine. Every variant keeps the same
   anatomy — an interior, a glow, a base, and a `.chest__lid` group — so the
   reveal's opening animation works on all four, and all colours come from
   CSS variables. Everything stays inside the 0–64 viewBox so a chest can
   never spill over its card.
   ------------------------------------------------------------------------ */

const CHEST_INTERIOR = `
    <rect class="chest__inside" x="9" y="20" width="46" height="15" rx="2"/>
    <ellipse class="chest__glow" cx="32" cy="29" rx="19" ry="8"/>`;

const CHEST_ART = {
  // Everyday wooden crate: iron bands, a simple lock.
  basic: (spark) => `
    ${CHEST_INTERIOR}${spark}
    <path class="chest__wood" d="M6 34 h52 v13 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z"/>
    <path class="chest__wood-dark" d="M6 45 h52 v2 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z"/>
    <rect class="chest__metal" x="6" y="31" width="52" height="5" rx="1"/>
    <rect class="chest__metal" x="14" y="34" width="5" height="17"/>
    <rect class="chest__metal" x="45" y="34" width="5" height="17"/>
    <g class="chest__lid">
      <path class="chest__wood" d="M6 32 v-6 C6 14 17 6 32 6 C47 6 58 14 58 26 v6 z"/>
      <path class="chest__wood-light" d="M12 26 C12 17 20 11 32 11 C44 11 52 17 52 26 z"/>
      <rect class="chest__metal" x="14" y="20" width="5" height="12"/>
      <rect class="chest__metal" x="45" y="20" width="5" height="12"/>
      <rect class="chest__metal" x="6" y="27" width="52" height="5" rx="1"/>
    </g>
    <rect class="chest__metal" x="27" y="29" width="10" height="11" rx="2"/>
    <circle class="chest__keyhole" cx="32" cy="34" r="1.8"/>`,

  // Hell-forged: flames licking up behind, charred iron, ember cracks, spikes.
  rapid_fire: (spark) => `
    <g class="chest__flames">
      <path class="chest__flame" d="M11 23 C7 16 13 12 12 5 C18 10 19 17 16 23 Z"/>
      <path class="chest__flame chest__flame--tall" d="M28 17 C23 7 33 4 31 0 C40 6 41 12 36 17 Z"/>
      <path class="chest__flame" d="M48 23 C44 16 50 12 49 5 C55 10 56 17 53 23 Z"/>
    </g>
    ${CHEST_INTERIOR}${spark}
    <path class="chest__wood" d="M6 34 h52 v14 a2 2 0 0 1 -2 2 h-48 a2 2 0 0 1 -2 -2 z"/>
    <path class="chest__wood-dark" d="M6 45 h52 v3 a2 2 0 0 1 -2 2 h-48 a2 2 0 0 1 -2 -2 z"/>
    <path class="chest__ember" d="M24 38 l3 4 l-2 5"/>
    <path class="chest__ember" d="M40 38 l-3 4 l2 5"/>
    <rect class="chest__metal" x="6" y="31" width="52" height="5"/>
    <rect class="chest__metal" x="13" y="34" width="6" height="16"/>
    <rect class="chest__metal" x="45" y="34" width="6" height="16"/>
    <g class="chest__lid">
      <path class="chest__metal" d="M19 13 l3 -8 l3 8 z"/>
      <path class="chest__metal" d="M39 13 l3 -8 l3 8 z"/>
      <path class="chest__wood" d="M6 32 v-4 L17 11 h30 L58 28 v4 z"/>
      <path class="chest__wood-light" d="M17 11 h30 L51 19 H13 z"/>
      <rect class="chest__metal" x="13" y="19" width="6" height="13"/>
      <rect class="chest__metal" x="45" y="19" width="6" height="13"/>
      <rect class="chest__metal" x="6" y="27" width="52" height="5"/>
    </g>
    <path class="chest__metal" d="M26 28 h12 v8 a6 6 0 0 1 -12 0 z"/>
    <circle class="chest__keyhole" cx="32" cy="33" r="2"/>`,

  // Royal casket: lacquered blue, silver trim with rivets, a gem on the lid.
  special: (spark) => `
    ${CHEST_INTERIOR}${spark}
    <path class="chest__wood" d="M6 34 h52 v13 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z"/>
    <path class="chest__wood-dark" d="M6 45 h52 v2 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z"/>
    <rect class="chest__metal" x="6" y="31" width="52" height="5" rx="1.5"/>
    <rect class="chest__metal" x="13" y="34" width="4" height="17" rx="1.5"/>
    <rect class="chest__metal" x="47" y="34" width="4" height="17" rx="1.5"/>
    <circle class="chest__rivet" cx="10" cy="41" r="1.3"/>
    <circle class="chest__rivet" cx="54" cy="41" r="1.3"/>
    <circle class="chest__rivet" cx="10" cy="47" r="1.3"/>
    <circle class="chest__rivet" cx="54" cy="47" r="1.3"/>
    <g class="chest__lid">
      <path class="chest__wood" d="M6 32 v-5 C6 15 17 7 32 7 C47 7 58 15 58 27 v5 z"/>
      <path class="chest__wood-light" d="M12 27 C12 18 20 12 32 12 C44 12 52 18 52 27 z"/>
      <path class="chest__trim" d="M13 27 C13 19 21 13 32 13 C43 13 51 19 51 27"/>
      <rect class="chest__metal" x="13" y="20" width="4" height="12" rx="1.5"/>
      <rect class="chest__metal" x="47" y="20" width="4" height="12" rx="1.5"/>
      <rect class="chest__metal" x="6" y="27" width="52" height="5" rx="1.5"/>
      <path class="chest__gem" d="M32 14 L37.5 20.5 L32 27 L26.5 20.5 Z"/>
      <path class="chest__gem-shine" d="M32 14 L34.5 20.5 L32 27 Z"/>
    </g>
    <rect class="chest__metal" x="27" y="29" width="10" height="11" rx="3"/>
    <circle class="chest__keyhole" cx="32" cy="34" r="1.8"/>`,

  // Reliquary: a halo, radiating light, wings, and a star struck on the lid.
  divine: (spark) => `
    <g class="chest__rays">
      <path class="chest__ray" d="M29 32 L32 0 L35 32 Z"/>
      <path class="chest__ray" d="M29 32 L32 0 L35 32 Z" transform="rotate(30 32 32)"/>
      <path class="chest__ray" d="M29 32 L32 0 L35 32 Z" transform="rotate(-30 32 32)"/>
      <path class="chest__ray" d="M29 32 L32 0 L35 32 Z" transform="rotate(60 32 32)"/>
      <path class="chest__ray" d="M29 32 L32 0 L35 32 Z" transform="rotate(-60 32 32)"/>
      <path class="chest__ray" d="M29 32 L32 0 L35 32 Z" transform="rotate(90 32 32)"/>
      <path class="chest__ray" d="M29 32 L32 0 L35 32 Z" transform="rotate(-90 32 32)"/>
    </g>
    <!-- the halo clears the lid, so it still reads once the chest opens -->
    <ellipse class="chest__halo" cx="32" cy="5" rx="11" ry="3"/>
    <path class="chest__wing" d="M10 32 C3 27 0 36 5 41 C5 35 7 33 10 36 Z"/>
    <path class="chest__wing" d="M54 32 C61 27 64 36 59 41 C59 35 57 33 54 36 Z"/>
    ${CHEST_INTERIOR}${spark}
    <path class="chest__wood" d="M6 34 h52 v13 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z"/>
    <path class="chest__wood-dark" d="M6 45 h52 v2 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z"/>
    <rect class="chest__metal" x="6" y="31" width="52" height="5" rx="2"/>
    <rect class="chest__metal" x="13" y="34" width="5" height="17" rx="2"/>
    <rect class="chest__metal" x="46" y="34" width="5" height="17" rx="2"/>
    <g class="chest__lid">
      <path class="chest__wood" d="M6 32 v-4 C6 17 17 10 32 10 C47 10 58 17 58 28 v4 z"/>
      <path class="chest__wood-light" d="M12 28 C12 20 20 15 32 15 C44 15 52 20 52 28 z"/>
      <rect class="chest__metal" x="13" y="22" width="5" height="10" rx="2"/>
      <rect class="chest__metal" x="46" y="22" width="5" height="10" rx="2"/>
      <rect class="chest__metal" x="6" y="27" width="52" height="5" rx="2"/>
      <path class="chest__star" d="M32 14 L33.9 19.6 L39.5 21.5 L33.9 23.4 L32 29 L30.1 23.4 L24.5 21.5 L30.1 19.6 Z"/>
    </g>
    <rect class="chest__metal" x="27" y="29" width="10" height="11" rx="3"/>
    <circle class="chest__keyhole" cx="32" cy="34" r="1.8"/>`,
};

/**
 * Render a chest for one tier. `sparkles` adds the burst the reveal needs;
 * the tray's resting chests leave it off.
 */
function chestSvg(category = DEFAULT_CATEGORY, { sparkles = false } = {}) {
  const cat = CATEGORIES[category] ? category : DEFAULT_CATEGORY;
  const spark = sparkles ? `
    <g class="chest__sparks">
      <circle class="chest__spark" cx="20" cy="26" r="2"/>
      <circle class="chest__spark" cx="32" cy="22" r="2.6"/>
      <circle class="chest__spark" cx="44" cy="26" r="2"/>
      <circle class="chest__spark" cx="26" cy="24" r="1.6"/>
      <circle class="chest__spark" cx="39" cy="24" r="1.6"/>
    </g>` : '';

  return `<svg class="chest chest--${cat}" viewBox="0 0 64 64" role="img" aria-label="Schatztruhe">
    ${CHEST_ART[cat](spark)}
  </svg>`;
}

/** One unopened reward, shown on the player's home screen. */
function chestCard(chest) {
  const cat = CATEGORIES[chest.category] ? chest.category : DEFAULT_CATEGORY;
  const tier = CATEGORIES[cat];

  return `<article class="chest-card" data-cat="${cat}" data-chest-id="${chest.id}">
    <div class="chest-card__icon" aria-hidden="true">${chestSvg(cat)}</div>
    <div class="chest-card__info">
      <h3 class="chest-card__name">${esc(chest.name)}</h3>
      <span class="tier tier--${cat}">
        <span class="tier__icon" aria-hidden="true">${tier.icon}</span>${tier.label}
      </span>
      <div class="reward-row">
        <span class="reward-chip"><span class="reward-chip__icon" aria-hidden="true">⚡</span>${chest.exp_reward} EXP</span>
        <span class="reward-chip"><span class="reward-chip__icon" aria-hidden="true">◆</span>${chest.token_reward} Token</span>
      </div>
    </div>
    <button class="btn btn--sm btn--confirm chest-card__open" data-action="open-chest" data-id="${chest.id}">Öffnen</button>
  </article>`;
}

function renderChests() {
  const tray = $('chestTray');
  if (state.chests.length === 0) {
    tray.hidden = true;
    tray.innerHTML = '';
    return;
  }

  tray.hidden = false;
  const title = state.chests.length === 1 ? 'Eine Truhe wartet' : `${state.chests.length} Truhen warten`;
  tray.innerHTML = `
    <h2 class="chest-tray__title">${title}</h2>
    <div class="chest-list">${state.chests.map(chestCard).join('')}</div>
  `;
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
  } else if (forGameMaster && quest.status === 'done' && quest.archived_at) {
    // Filed away: it can come back out, or be reused as a template.
    actions = `<div class="action-row">
      <button class="btn btn--sm btn--neutral" data-action="repost-quest" data-id="${quest.id}">Erneut stellen</button>
      <button class="btn btn--sm btn--neutral" data-action="unarchive-quest" data-id="${quest.id}">Zurückholen</button>
      <button class="btn btn--sm btn--danger" data-action="delete-quest" data-id="${quest.id}">Löschen</button>
    </div>`;
  } else if (forGameMaster && quest.status === 'done') {
    // A finished quest doubles as a template for the next round.
    actions = `<div class="action-row">
      <button class="btn btn--sm btn--neutral" data-action="repost-quest" data-id="${quest.id}">Erneut stellen</button>
      <button class="btn btn--sm btn--neutral" data-action="archive-quest" data-id="${quest.id}">Archivieren</button>
      <button class="btn btn--sm btn--danger" data-action="delete-quest" data-id="${quest.id}">Löschen</button>
    </div>`;
  } else if (!forGameMaster && quest.status === 'active') {
    actions = `<div class="action-row">
      <button class="btn btn--block btn--confirm" data-action="submit-quest" data-id="${quest.id}">✓ Erledigt!</button>
    </div>`;
  } else if (!forGameMaster && quest.status === 'done') {
    // The player tidies their own log; the same archive both roles share.
    actions = `<div class="action-row">
      <button class="btn btn--sm btn--neutral"
              data-action="${quest.archived_at ? 'unarchive-quest' : 'archive-quest'}"
              data-id="${quest.id}">${quest.archived_at ? 'Zurückholen' : 'Archivieren'}</button>
    </div>`;
  }

  const rewards = quest.status === 'done' ? '' : `<div class="reward-row">
    <span class="reward-chip"><span class="reward-chip__icon" aria-hidden="true">⚡</span>${quest.exp_reward} EXP</span>
    <span class="reward-chip"><span class="reward-chip__icon" aria-hidden="true">◆</span>${quest.token_reward} Token</span>
  </div>`;

  // A finished recurring quest says when it comes back, so it does not read
  // as simply gone — that still holds once it is archived, since filing it
  // away does not cancel the return.
  let repeat = '';
  if (quest.status === 'done' && quest.resets_at) {
    repeat = `<span class="repeat-note">↻ ${formatReturn(quest.resets_at)}</span>`;
  } else if (quest.status === 'done' && quest.archived_at) {
    repeat = '<span class="repeat-note">📦 Archiviert</span>';
  }

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

/**
 * The collapsible archive, shared by both quest lists. Both roles see the
 * same archive — it is one board, so tidying it away tidies it for both.
 */
function archiveSection(archived, { forGameMaster }) {
  if (!archived.length) return '';

  const cards = state.showArchive
    ? archived.map((q) => questCard(q, { forGameMaster })).join('')
    : '';

  return `<button class="archive-toggle" data-action="toggle-archive"
                  aria-expanded="${state.showArchive}">
    <span>📦 Archiv (${archived.length})</span>
    <span class="archive-toggle__chevron">${state.showArchive ? '▲' : '▼'}</span>
  </button>${cards}`;
}

/** Rarest and most urgent first, then newest. */
function byTier(a, b) {
  const diff = CATEGORIES[categoryOf(a)].rank - CATEGORIES[categoryOf(b)].rank;
  return diff !== 0 ? diff : String(b.created_at).localeCompare(String(a.created_at));
}

function renderQuests() {
  const active = state.quests.filter((q) => q.status === 'active').sort(byTier);
  const pending = state.quests.filter((q) => q.status === 'pending_confirm').sort(byTier);
  // Archived quests leave both lists and live in the game master's archive.
  const done = state.quests.filter((q) => q.status === 'done' && !q.archived_at);
  const archived = state.quests.filter((q) => q.archived_at);

  // Player
  const playerEl = $('playerQuestList');
  {
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
    if (!html) {
      html += emptyState('📜', archived.length
        ? 'Nichts offen — alles liegt im Archiv.'
        : 'Noch keine Quests. Dein Game Master muss dir erst welche erstellen!');
    }
    html += archiveSection(archived, { forGameMaster: false });
    playerEl.innerHTML = html;
  }

  // Game master
  const gmEl = $('gmQuestsPanel');
  {
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
    // Nothing on the board — say so above the archive rather than leaving
    // a lone toggle looking like a broken screen.
    if (!html) {
      html += emptyState('📜', archived.length
        ? 'Nichts offen — alles liegt im Archiv. Tippe auf + für eine neue Quest.'
        : 'Noch keine Quests erstellt. Tippe auf + um loszulegen!');
    }
    html += archiveSection(archived, { forGameMaster: true });
    gmEl.innerHTML = html;
  }
}

/** "1/2" plus how it refills — shown to both roles. */
function stockMeta(item) {
  const { limited, left, max, soldOut } = stockOf(item);
  if (!limited) return '';

  const refill = item.reset_period !== 'never'
    ? `<span class="stock-reset">↻ ${RESET_PERIODS[item.reset_period].short}</span>`
    : '<span class="stock-reset">einmalig</span>';

  return `<div class="shop-item__meta">
    <span class="stock${soldOut ? ' stock--empty' : ''}">${left}/${max}</span>
    ${refill}
  </div>`;
}

function renderShop() {
  // Player
  const playerEl = $('playerShopList');
  if (state.shopItems.length === 0) {
    playerEl.innerHTML = emptyState('🛍️', 'Der Shop ist noch leer. Dein Game Master füllt ihn bald!');
  } else {
    playerEl.innerHTML = '<h2 class="section-title">Wifey Shop</h2>' + state.shopItems.map((item) => {
      const free = item.price === 0;
      const { soldOut } = stockOf(item);
      const affordable = state.stats.tokens >= item.price;
      const label = soldOut ? 'Leer' : free ? 'Gratis' : `◆ ${item.price}`;

      return `<article class="shop-item${soldOut ? ' shop-item--empty' : ''}">
        <div class="shop-item__icon" aria-hidden="true">${esc(shopIcon(item))}</div>
        <div class="shop-item__info">
          <h3 class="shop-item__name">${esc(item.name)}</h3>
          ${item.description ? `<p class="shop-item__desc">${esc(item.description)}</p>` : ''}
          ${stockMeta(item)}
        </div>
        <button class="buy-btn${free && !soldOut ? ' free-tag' : ''}" data-action="buy-item"
                data-id="${item.id}"${affordable && !soldOut ? '' : ' disabled'}>
          ${label}
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
      <div class="shop-item__icon" aria-hidden="true">${esc(shopIcon(item))}</div>
      <div class="shop-item__info">
        <h3 class="shop-item__name">${esc(item.name)}</h3>
        ${item.description ? `<p class="shop-item__desc">${esc(item.description)}</p>` : ''}
        ${stockMeta(item)}
        <div class="action-row">
          <button class="btn btn--sm btn--neutral" data-action="edit-item" data-id="${item.id}">Bearbeiten</button>
          <button class="btn btn--sm btn--danger" data-action="delete-item" data-id="${item.id}">Entfernen</button>
        </div>
      </div>
      <span class="token-count">${item.price === 0 ? 'Gratis' : `◆ ${item.price}`}</span>
    </article>`).join('');
  }
}

function renderHistory() {
  const icons = { quest_done: '⚔️', chest_opened: '🎁', purchase: '🛍️', level_up: '⭐' };

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
  // Same idea for the player: chests wait on the raccoon screen, so that
  // is the one screen a role switch should never leave hidden behind
  // whatever tab was open last.
  if (role === 'player') setPlayerView('viewRaccoon');
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

/**
 * Open the quest sheet. With no quest it creates one; with a quest it edits
 * that quest, unless `asTemplate` — then the quest's values only seed a
 * brand new one, leaving the finished original untouched in the history.
 */
function openQuestForm(quest, { asTemplate = false } = {}) {
  state.editingQuestId = asTemplate ? null : (quest?.id ?? null);
  const editing = state.editingQuestId != null;

  $('questModalTitle').textContent =
    editing ? 'Quest bearbeiten' : asTemplate ? 'Quest erneut stellen' : 'Neue Quest';
  $('questSubmit').textContent =
    editing ? 'Änderungen speichern' : asTemplate ? 'Erneut stellen' : 'Quest erstellen';

  $('questName').value = quest?.name ?? '';
  $('questDesc').value = quest?.description ?? '';
  $('questExp').value = quest?.exp_reward ?? CATEGORIES[DEFAULT_CATEGORY].exp;
  $('questTokens').value = quest?.token_reward ?? CATEGORIES[DEFAULT_CATEGORY].tokens;

  // Editing and reposting both keep the rewards already agreed.
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

/** Highlight whichever offered icon matches what the field holds. */
function renderIconPicker() {
  const current = firstEmoji($('itemIcon').value);
  $('iconPicker').innerHTML = SHOP_ICONS.map((emoji) => `
    <button type="button" class="icon-option${emoji === current ? ' is-selected' : ''}"
            data-action="pick-icon" data-icon="${emoji}"
            aria-label="Icon ${emoji}">${emoji}</button>`).join('');
}

/**
 * The refill choice only means something once a quantity is set, so the
 * whole section stays hidden for an unlimited item.
 */
function renderPeriodPicker() {
  const limited = $('itemStock').value.trim() !== '';
  $('periodField').hidden = !limited;
  if (!limited) return;

  $('periodPicker').innerHTML = Object.entries(RESET_PERIODS).map(([key, period]) => `
    <button type="button" class="segmented__option${key === state.formPeriod ? ' is-selected' : ''}"
            data-action="pick-period" data-period="${key}">${period.label}</button>`).join('');
  $('periodHint').textContent = RESET_PERIODS[state.formPeriod].hint;
}

/** Open the shop sheet, empty for a new item or filled to edit one. */
function openShopForm(item) {
  state.editingItemId = item?.id ?? null;
  state.formPeriod = RESET_PERIODS[item?.reset_period] ? item.reset_period : DEFAULT_PERIOD;

  $('shopModalTitle').textContent = item ? 'Artikel bearbeiten' : 'Neuer Shop-Artikel';
  $('shopSubmit').textContent = item ? 'Änderungen speichern' : 'Artikel erstellen';
  $('itemName').value = item?.name ?? '';
  $('itemDesc').value = item?.description ?? '';
  // Normalise on the way in, so editing an old two-emoji item cleans it up.
  $('itemIcon').value = item ? shopIcon(item) : DEFAULT_ICON;
  $('itemPrice').value = item?.price ?? 10;
  $('itemStock').value = item?.stock_max ?? '';

  renderIconPicker();
  renderPeriodPicker();
  openModal('shopModal');
}

async function saveShopItem(form) {
  if (!requireDb()) return;
  const data = new FormData(form);
  const name = String(data.get('name')).trim();
  if (!name) { showToast('Bitte einen Namen eingeben', 'error'); return; }

  const editingId = state.editingItemId;
  const previous = editingId ? state.shopItems.find((s) => s.id === editingId) : null;

  const rawStock = String(data.get('stock')).trim();
  const stockMax = rawStock === '' ? null : Math.max(0, Math.round(Number(rawStock) || 0));
  const period = stockMax == null ? 'never' : state.formPeriod;

  // Editing a name or price must not silently restock what the player has
  // already spent, so the count is only reset when the quantity itself
  // changes (or the item was unlimited until now).
  let stockLeft = null;
  if (stockMax != null) {
    stockLeft = previous && previous.stock_max === stockMax
      ? Math.min(previous.stock_left ?? stockMax, stockMax)
      : stockMax;
  }

  // Likewise keep a running period's deadline instead of restarting it.
  let resetAt = null;
  if (stockMax != null && period !== 'never') {
    resetAt = previous && previous.reset_period === period && previous.stock_reset_at
      ? previous.stock_reset_at
      : nextResetAt(period).toISOString();
  }

  const fields = {
    name,
    description: String(data.get('description')).trim(),
    icon: firstEmoji(data.get('icon')) || DEFAULT_ICON,
    price: Math.max(0, Number(data.get('price')) || 0),
    stock_max: stockMax,
    stock_left: stockLeft,
    reset_period: period,
    stock_reset_at: resetAt,
  };
  const { error } = editingId
    ? await sb.from('shop_items').update(fields).eq('id', editingId)
    : await sb.from('shop_items').insert(fields);

  if (error) {
    reportError(error, editingId ? 'Artikel konnte nicht gespeichert werden' : 'Artikel konnte nicht erstellt werden');
    return;
  }

  form.reset();
  state.editingItemId = null;
  closeModal('shopModal');
  showToast(editingId ? 'Artikel gespeichert!' : 'Artikel hinzugefügt!', 'success');
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

  // The reward doesn't credit yet — it waits as a chest on the player's
  // home screen until they open it.
  const { error: chestError } = await sb.from('chests').insert({
    quest_id: quest.id,
    name: quest.name,
    category: categoryOf(quest),
    exp_reward: quest.exp_reward,
    token_reward: quest.token_reward,
  });

  if (chestError) { reportError(chestError, 'Truhe konnte nicht erstellt werden'); return; }
  showToast('Bestätigt! Eine Truhe wartet auf dem Hauptbildschirm.', 'success');
}

/** Claim a chest's reward: delete-then-check makes a double tap or a
 * second device racing for the same chest a safe no-op instead of a
 * double payout. */
async function openChest(id) {
  if (!requireDb()) return;

  const btn = document.querySelector(`.chest-card__open[data-id="${id}"]`);
  const card = document.querySelector(`.chest-card[data-chest-id="${id}"]`);
  if (btn) btn.disabled = true;
  card?.classList.add('is-opening');

  // A short shake before the network round-trip makes the tap feel instant.
  await sleep(420);

  const { data: claimed, error } = await sb.from('chests').delete().eq('id', id).select();
  if (error) {
    reportError(error, 'Truhe konnte nicht geöffnet werden');
    card?.classList.remove('is-opening');
    if (btn) btn.disabled = false;
    return;
  }
  if (!claimed || claimed.length === 0) {
    // Already opened — the realtime refresh will drop the card shortly.
    return;
  }

  const chest = claimed[0];
  const previousLevel = state.stats.level;
  const { level, exp } = applyExp(state.stats, chest.exp_reward);
  const tokens = state.stats.tokens + chest.token_reward;

  const { error: statsError } = await sb.from('player_stats')
    .update({ level, exp, tokens, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (statsError) { reportError(statsError, 'Belohnung konnte nicht gutgeschrieben werden'); return; }

  const entries = [{
    type: 'chest_opened',
    title: chest.name,
    exp_gain: chest.exp_reward,
    token_gain: chest.token_reward,
  }];
  if (level > previousLevel) {
    entries.push({ type: 'level_up', title: `Level ${level} erreicht!` });
  }
  await sb.from('history').insert(entries);

  showChestReveal(chest, level > previousLevel ? level : null);
}

function showChestReveal(chest, newLevel) {
  // Draw the tier's own chest, so the reveal shows the same one just opened.
  const cat = CATEGORIES[chest.category] ? chest.category : DEFAULT_CATEGORY;
  $('chestRevealIcon').dataset.cat = cat;
  $('chestRevealIcon').innerHTML = chestSvg(cat, { sparkles: true });
  $('chestRevealName').textContent = chest.name;
  $('chestRevealExp').textContent = `+${chest.exp_reward} EXP`;
  $('chestRevealTokens').textContent = `+${chest.token_reward} ◆`;
  pendingLevelUp = newLevel;
  $('chestReveal').classList.add('is-open');
}

function dismissChestReveal() {
  $('chestReveal').classList.remove('is-open');
  if (pendingLevelUp != null) {
    const level = pendingLevelUp;
    pendingLevelUp = null;
    setTimeout(() => showLevelUp(level), 350);
  }
}

async function denyQuest(id) {
  if (!requireDb()) return;
  const { error } = await sb.from('quests').update({ status: 'active' }).eq('id', id);
  if (error) { reportError(error, 'Quest konnte nicht zurückgewiesen werden'); return; }
  showToast('Zurückgewiesen', 'info');
}

/**
 * File a finished quest away. It only tidies it out of the lists — the
 * return date is left alone, so a weekly quest still comes back on time
 * (and unarchives itself when it does). Ending a recurrence is deleting
 * the quest or moving it off the Basic tier, not filing it away.
 */
async function archiveQuest(id) {
  if (!requireDb()) return;
  const { error } = await sb.from('quests')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'done');

  if (error) { reportError(error, 'Quest konnte nicht archiviert werden'); return; }
  showToast('Archiviert', 'info');
}

async function unarchiveQuest(id) {
  if (!requireDb()) return;
  const { error } = await sb.from('quests').update({ archived_at: null }).eq('id', id);
  if (error) { reportError(error, 'Quest konnte nicht zurückgeholt werden'); return; }
  showToast('Zurück in der Liste', 'info');
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

  const { limited, soldOut } = stockOf(item);
  if (soldOut) { showToast('Ausverkauft!', 'error'); return; }
  if (state.stats.tokens < item.price) {
    showToast('Nicht genug Token!', 'error');
    return;
  }

  // Claim the stock first: it is the scarcer resource, and gte() makes the
  // "is one left" check part of the write, so two quick taps cannot take
  // the same last item.
  if (limited) {
    const { data, error } = await sb.from('shop_items')
      .update({ stock_left: item.stock_left - 1 })
      .eq('id', id).gte('stock_left', 1)
      .select();

    if (error) { reportError(error, 'Kauf fehlgeschlagen'); return; }
    if (!data || data.length === 0) { showToast('Ausverkauft!', 'error'); return; }
  }

  // A free item costs nothing, so there is no balance to guard — skip
  // straight to logging it.
  if (item.price > 0) {
    const remaining = state.stats.tokens - item.price;
    const { data, error } = await sb.from('player_stats')
      .update({ tokens: remaining, updated_at: new Date().toISOString() })
      .eq('id', 1).gte('tokens', item.price)
      .select();

    const paid = !error && data && data.length > 0;
    if (!paid) {
      // Put the claimed stock back rather than swallowing it for a purchase
      // that never happened.
      if (limited) {
        await sb.from('shop_items').update({ stock_left: item.stock_left }).eq('id', id);
      }
      if (error) reportError(error, 'Kauf fehlgeschlagen');
      else showToast('Nicht genug Token!', 'error');
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
    if (state.gmTab === 'shop') { openShopForm(null); return; }
    openQuestForm(null);
  },
  'pick-tier': (el) => pickTier(el.dataset.cat, { prefillRewards: !state.editingQuestId }),
  'edit-quest': (el) => {
    const quest = state.quests.find((q) => q.id === el.dataset.id);
    if (quest) openQuestForm(quest);
  },
  'repost-quest': (el) => {
    const quest = state.quests.find((q) => q.id === el.dataset.id);
    if (quest) openQuestForm(quest, { asTemplate: true });
  },
  'archive-quest': (el) => archiveQuest(el.dataset.id),
  'unarchive-quest': (el) => unarchiveQuest(el.dataset.id),
  'toggle-archive': () => { state.showArchive = !state.showArchive; renderQuests(); },
  'edit-item': (el) => {
    const item = state.shopItems.find((s) => s.id === el.dataset.id);
    if (item) openShopForm(item);
  },
  'pick-icon': (el) => {
    $('itemIcon').value = el.dataset.icon;
    renderIconPicker();
  },
  'pick-period': (el) => {
    state.formPeriod = el.dataset.period;
    renderPeriodPicker();
  },
  'dismiss-levelup': () => $('levelup').classList.remove('is-open'),
  'dismiss-chest-reveal': () => dismissChestReveal(),
  'open-chest': (el) => openChest(el.dataset.id),
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
  saveShopItem(event.currentTarget);
});

// Typing a custom emoji clears the highlight on the offered ones.
$('itemIcon').addEventListener('input', renderIconPicker);

// A quantity is what makes the refill choice meaningful, so it appears and
// disappears with the field.
$('itemStock').addEventListener('input', renderPeriodPicker);

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
