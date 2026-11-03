/* Keeps a copy of the app on the phone so it opens without internet.
   Online it always fetches the newest files first (3 s limit), so an upload to the site shows up on the next launch. */
const CACHE = "story-studio-v5";
const FILES = [
  "./", "./index.html", "./stories.html", "./fotolajm.html", "./videolajm.html", "./thumbnail.html", "./timeline.js", "./timeline.css",
  "./common.css", "./common.js", "./fonts.css", "./logo.png", "./foto-overlay.webp",
  "./thumb-base.webp", "./thumb-top.webp", "./thumb-mask.png", "./thumb-grain.webp",
  "./p-andi.webp", "./p-altina.webp", "./p-armati.webp", "./p-dreni.webp", "./p-anmo.webp", "./p-emira.webp", "./p-joni.webp",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(req, { cache: "no-cache" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 3000)),
      ]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true })
        || (req.mode === "navigate" ? await cache.match("./index.html") || await cache.match("./") : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
