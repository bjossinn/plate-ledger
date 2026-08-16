/* Plate Ledger service worker — offline shell cache.
   Strategy: serve from cache immediately, refresh the cache in the background,
   so the app opens in a basement gym and still picks up updates next launch. */

var CACHE = "plate-ledger-1.4.0";
var SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      /* cache: "reload" skips the HTTP cache, so an update really is the new file */
      .then(function (cache) {
        return cache.addAll(SHELL.map(function (url) { return new Request(url, { cache: "reload" }); }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(event.request).then(function (hit) {
        var fresh = fetch(event.request).then(function (res) {
          if (res && res.status === 200 && res.type === "basic") cache.put(event.request, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || fresh;
      });
    })
  );
});
