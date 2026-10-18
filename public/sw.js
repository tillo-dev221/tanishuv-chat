/* ============================================================
   SERVICE WORKER — Tanishuv Chat PWA
   Xatosiz versiya
   ============================================================ */

const CACHE_NAME = 'tanishuv-chat-v2'; // Versiyani oshirdik (eski kesh yangilanadi)
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

// ============================================================
// 1. O'rnatish (Install)
// ============================================================
self.addEventListener('install', event => {
  console.log('[SW] O\'rnatilmoqda...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Fayllar keshlanmoqda');
        // Har bir faylni alohida keshlaymiz (bittasi xato bersa, qolganlari davom etadi)
        return Promise.all(
          PRECACHE_URLS.map(url => {
            return cache.add(url).catch(err => {
              console.warn('[SW] Keshga qo\'shilmadi:', url, err);
            });
          })
        );
      })
      .then(() => {
        console.log('[SW] O\'rnatildi');
        return self.skipWaiting();
      })
  );
});

// ============================================================
// 2. Faollashtirish (Activate)
// ============================================================
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

// ============================================================
// 3. So'rovlarni ushlash (Fetch)
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;

  // ✅ 1-QOIDAQ: FAQAT http va https so'rovlarini qabul qilamiz
  // Bu chrome-extension, moz-extension va boshqa sxemalarni bloklaydi
  if (!request.url.startsWith('http')) {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // ✅ 2-QOIDA: API so'rovlarini keshlash shart emas (har doim yangi)
  // Bu CORS xatolarini oldini oladi
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

  // ✅ 3-QOIDA: Faqat GET so'rovlarini keshlaymiz
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // ✅ 4-QOIDA: Keshdan qidirish
  event.respondWith(
    caches.match(request)
      .then(cachedResponse => {
        // Agar keshda bo'lsa — qaytaramiz va fonda yangilaymiz
        if (cachedResponse) {
          event.waitUntil(
            fetch(request).then(response => {
              if (response && response.status === 200) {
                return caches.open(CACHE_NAME).then(cache => {
                  return cache.put(request, response.clone()).catch(err => {
                    // Bu xato muhim emas, shunchaki logga yozamiz
                  });
                });
              }
            }).catch(() => {})
          );
          return cachedResponse;
        }

        // Keshda yo'q — tarmoqdan
        return fetch(request)
          .then(response => {
            // Muvaffaqiyatli so'rovni keshlaymiz
            if (response && response.status === 200) {
              const responseClone = response.clone();
              event.waitUntil(
                caches.open(CACHE_NAME).then(cache => {
                  return cache.put(request, responseClone).catch(err => {
                    // Bu xato muhim emas
                  });
                })
              );
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

// ============================================================
// 4. Push Notification (kelajakda)
// ============================================================
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Tanishuv Chat', body: 'Yangi xabar' };
  }

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

// ============================================================
// 5. Notification bosilganda
// ============================================================
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/')
  );
});
