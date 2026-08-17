/* Plate Ledger service worker — offline shell cache.
   Strategy: serve from cache immediately, refresh the cache in the background,
   so the app opens in a basement gym and still picks up updates next launch. */

var CACHE = "plate-ledger-1.14.2";
var SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon-32.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
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

/* A push arrives while the app is closed, so everything shown here comes from
   the payload — the service worker has no access to the page's state. */
self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Plate Ledger", {
      body: data.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: data.tag || "plate-ledger",
      data: { url: data.url || "./" }
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf("plate-ledger") !== -1 && "focus" in list[i]) return list[i].focus();
      }
      return self.clients.openWindow(target);
    })
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
