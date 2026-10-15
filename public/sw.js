/* ============================================================
   SERVICE WORKER — Tanishuv Chat PWA
   ============================================================ */

const CACHE_NAME = 'tanishuv-chat-v1';
const OFFLINE_URL = '/offline.html';

// Kesh qilinadigan fayllar
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/icon.svg',
  'https://cdn.jsdelivr.net/npm/disable-devtool@latest/disable-devtool.min.js',
  'https://unpkg.com/lucide@latest/dist/umd/lucide.min.js',
  'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;900&family=Inter:wght@400;500;600;700;800;900&display=swap'
];

// O'rnatish
self.addEventListener('install', event => {
  console.log('[SW] O\'rnatilmoqda...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Fayllar keshlanmoqda');
        return cache.addAll(PRECACHE_URLS).catch(err => {
          console.warn('[SW] Ba\'zi fayllar keshlanmadi:', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// Faollashtirish
self.addEventListener('activate', event => {
  console.log('[SW] Faollashtirilmoqda...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Eski kesh o\'chirilmoqda:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// So'rovlarni ushlash
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API so'rovlarini keshlash shart emas (har doim yangi)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Offline rejim' 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Boshqa so'rovlar uchun: avval kesh, keyin tarmoq
  event.respondWith(
    caches.match(request)
      .then(cachedResponse => {
        if (cachedResponse) {
          // Keshdan qaytaramiz, lekin fonda yangilaymiz
          fetch(request).then(response => {
            if (response && response.status === 200) {
              caches.open(CACHE_NAME).then(cache => {
                cache.put(request, response.clone());
              });
            }
          }).catch(() => {});
          return cachedResponse;
        }

        // Keshda yo'q — tarmoqdan
        return fetch(request)
          .then(response => {
            // Muvaffaqiyatli so'rovni keshlaymiz
            if (response && response.status === 200 && request.method === 'GET') {
              const responseClone = response.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(request, responseClone);
              });
            }
            return response;
          })
          .catch(() => {
            // Offline — HTML so'rovlar uchun offline sahifa
            if (request.mode === 'navigate') {
              return caches.match(OFFLINE_URL);
            }
            // Boshqa so'rovlar uchun bo'sh javob
            return new Response('', { status: 408 });
          });
      })
  );
});

// Push notification (kelajakda)
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Tanishuv Chat';
  const options = {
    body: data.body || 'Yangi xabar keldi',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification bosilganda
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/')
  );
});