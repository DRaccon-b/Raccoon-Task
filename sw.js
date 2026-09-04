/* Service worker. Its only job is notifications: the app itself is served
   straight from the network, so there is no cache here to go stale and no
   chance of it handing out an old build. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = { title: 'Raccoon Quest', body: 'Es hat sich etwas getan.' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch { /* a push without a readable payload still deserves a nudge */ }

  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: './icon.png',
    badge: './icon.png',
    // One tag per kind, so a second quest replaces the first notification
    // instead of stacking up a wall of them on the lock screen.
    tag: payload.tag || 'raccoon',
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = open.find((client) => client.url.includes(self.registration.scope));
    if (mine) return mine.focus();
    return self.clients.openWindow('./');
  })());
});
