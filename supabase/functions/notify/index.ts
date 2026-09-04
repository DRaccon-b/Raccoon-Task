/**
 * Sends a web push to the other player's phone.
 *
 * The client only ever names an event ("a quest was posted") and the title it
 * concerns; the wording and the recipient are decided here. That way a phone
 * cannot be talked into pushing arbitrary text to the other one, and both
 * sides read the same way even after the app changes.
 *
 * The VAPID private key is never shipped to a phone. It sits in app_config,
 * a table with row level security on and no policy at all, so the anon key
 * cannot see it and only this function — which runs with the service role —
 * can read it.
 */
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

type Role = 'player' | 'gm';

const MESSAGES: Record<string, { to: Role; title: string; body: (name: string) => string }> = {
  quest_created: {
    to: 'player',
    title: 'Neue Quest!',
    body: (name) => `„${name}" wartet auf dich.`,
  },
  quest_submitted: {
    to: 'gm',
    title: 'Quest erledigt gemeldet',
    body: (name) => `„${name}" wartet auf deine Bestätigung.`,
  },
  quest_confirmed: {
    to: 'player',
    title: 'Bestätigt — eine Truhe wartet!',
    body: (name) => `„${name}" ist abgehakt. Mach die Truhe auf.`,
  },
  quest_denied: {
    to: 'player',
    title: 'Noch nicht ganz',
    body: (name) => `„${name}" wurde zurückgegeben.`,
  },
  item_bought: {
    to: 'gm',
    title: 'Im Shop eingelöst',
    body: (name) => `„${name}" wurde gerade gekauft.`,
  },
  test: {
    to: 'player',
    title: 'Mitteilungen sind an',
    body: () => 'So sieht es aus, wenn sich etwas tut.',
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST erwartet' }, 405);

  let payload: { event?: string; name?: string; to?: Role };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Kein JSON' }, 400);
  }

  const message = MESSAGES[payload.event ?? ''];
  if (!message) return json({ error: 'Unbekanntes Ereignis' }, 400);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: config, error: configError } = await supabase
    .from('app_config')
    .select('key, value');
  if (configError) return json({ error: configError.message }, 500);

  const setting = (key: string) => config?.find((row) => row.key === key)?.value ?? '';
  webpush.setVapidDetails(
    setting('vapid_subject'),
    setting('vapid_public'),
    setting('vapid_private'),
  );

  // "test" goes back to whoever asked for it, everything else to the other side.
  const target = payload.event === 'test' ? (payload.to ?? 'player') : message.to;
  const { data: subs, error: subsError } = await supabase
    .from('push_subs')
    .select('id, endpoint, p256dh, auth')
    .eq('role', target);
  if (subsError) return json({ error: subsError.message }, 500);
  if (!subs?.length) return json({ sent: 0, note: `Niemand als ${target} angemeldet` });

  const name = (payload.name ?? '').slice(0, 80) || 'Eine Quest';
  const body = JSON.stringify({ title: message.title, body: message.body(name) });

  const results = await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 3600 },
      );
      return { id: sub.id, ok: true };
    } catch (err) {
      // 404/410 means the phone uninstalled the app or reset its permission;
      // that subscription is dead for good, so drop it rather than retry it
      // on every future quest.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await supabase.from('push_subs').delete().eq('id', sub.id);
      }
      return { id: sub.id, ok: false, status, error: String(err) };
    }
  }));

  return json({ sent: results.filter((r) => r.ok).length, results });
});
