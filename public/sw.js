/* Rabbit Heard Ledger app-shell service worker.
 * Keeps a lightweight offline shell and improves installability signals.
 */

var RHL_CACHE = 'rhl-app-shell-v1';
var RHL_SHELL = [
  '/',
  '/app.css',
  '/favicon/favicon-32x32.png',
  '/favicon/manifest.json'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(RHL_CACHE).then(function(cache){
      return cache.addAll(RHL_SHELL);
    }).catch(function(){
      return Promise.resolve();
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(key){
        if(key !== RHL_CACHE) return caches.delete(key);
        return Promise.resolve();
      }));
    }).then(function(){
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event){
  if(!event.request || event.request.method !== 'GET') return;

  var req = event.request;
  var accept = req.headers && req.headers.get ? (req.headers.get('accept') || '') : '';
  var isDoc = req.mode === 'navigate' || accept.indexOf('text/html') > -1;

  if(isDoc){
    event.respondWith(
      fetch(req).then(function(response){
        var copy = response.clone();
        caches.open(RHL_CACHE).then(function(cache){ cache.put('/', copy); });
        return response;
      }).catch(function(){
        return caches.match(req).then(function(hit){
          return hit || caches.match('/');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function(hit){
      if(hit) return hit;
      return fetch(req).then(function(response){
        if(!response || response.status !== 200 || response.type !== 'basic') return response;
        var copy = response.clone();
        caches.open(RHL_CACHE).then(function(cache){ cache.put(req, copy); });
        return response;
      });
    })
  );
});
