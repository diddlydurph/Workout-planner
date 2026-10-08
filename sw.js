// Minimal service worker: only used to ping you about a rest timer
// (10 seconds left, then rest done) while the app is in the background.
// It doesn't cache anything.
let token = 0;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const until = t => new Promise(r => setTimeout(r, Math.max(0, t - Date.now())));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'cancel') { token++; return; }
  if (d.type !== 'rest') return;
  const mine = ++token;
  const ping = async (title, body, vibrate) => {
    if (mine !== token) return; // timer was skipped, extended or restarted
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(c => c.visibilityState === 'visible')) return; // app is open: it rings itself
    if (Notification.permission !== 'granted') return;
    await self.registration.showNotification(title, { body, tag: 'rest-timer', renotify: true, vibrate });
  };
  const next = d.label ? `Next set: ${d.label}` : 'Next set';
  e.waitUntil((async () => {
    if (d.warn && d.end - Date.now() > 10500) {
      await until(d.end - 10000);
      await ping('10 seconds left', `Get set · ${next}`, [150]);
    }
    await until(d.end);
    await ping('Rest done', next, [600, 200, 600, 200, 600]);
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(ws => ws.length ? ws[0].focus() : self.clients.openWindow('./')));
});
