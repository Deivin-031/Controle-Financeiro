const CACHE = 'mf-v330-push';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll([
        './',
        './index.html',
        './style.css',
        './app.js?v=3.2.1',
        './config.js',
        './manifest.json',
        './icon-192.png',
        './icon-512.png'
      ]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(
        ks.filter(k =>
          k.startsWith('mf-') && k !== CACHE
        ).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (
    e.request.method !== 'GET' ||
    new URL(e.request.url).origin !== location.origin
  ) return;

  e.respondWith(
    fetch(e.request)
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', e => {
  let data = {};

  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = {};
  }

  e.waitUntil(
    self.registration.showNotification(
      data.title || 'Controle Financeiro',
      {
        body: data.body || 'Voce tem um novo lembrete.',
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [200, 100, 200],
        data: {
          url: self.registration.scope
        }
      }
    )
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();

  e.waitUntil(
    self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(async clients => {
      for (const client of clients) {
        if (
          client.url.startsWith(self.registration.scope) &&
          'focus' in client
        ) {
          return client.focus();
        }
      }

      return self.clients.openWindow(
        self.registration.scope
      );
    })
  );
});
