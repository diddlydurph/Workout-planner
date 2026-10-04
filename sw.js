// Minimal service worker: only used to ping you when a rest timer ends
// while the app is in the background. It doesn't cache anything.
let token = 0;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'cancel') { token++; return; }
  if (d.type !== 'rest') return;
  const mine = ++token;
  const wait = Math.max(0, d.end - Date.now());
  e.waitUntil(new Promise(r => setTimeout(r, wait)).then(async () => {
    if (mine !== token) return; // timer was skipped, extended or restarted
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(c => c.visibilityState === 'visible')) return; // app is open: it rings itself
    if (Notification.permission !== 'granted') return;
    await self.registration.showNotification('Rest done', {
      body: d.label ? `Next set: ${d.label}` : 'Next set',
      tag: 'rest-timer', renotify: true, vibrate: [200, 100, 200],
    });
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(ws => ws.length ? ws[0].focus() : self.clients.openWindow('./')));
});
