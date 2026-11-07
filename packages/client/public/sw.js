// A pass-through service worker. It exists so the game can be installed to a
// phone's home screen; it deliberately caches nothing, so a new deploy is
// always what players get and a stale copy can never be served.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // No respondWith: the browser fetches from the network as usual.
});
