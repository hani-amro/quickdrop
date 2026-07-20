// PWA خفيف — service worker شبكة-أولاً: يمكّن التثبيت ("أضف للشاشة") بلا خدمة قديمة عالقة.
// لا نخزّن استجابات الـ API (السائق يحتاج بيانات طازجة دائماً)؛ الكاش لقشرة التطبيق فقط
// كاحتياط عند انقطاع الشبكة. GET فقط.
const SHELL = "qd-driver-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // لا نتدخّل في POST (المصادقة/الموقع/الأفعال)
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return; // بيانات حيّة — شبكة فقط، لا كاش
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => undefined);
        return res;
      })
      .catch(() => caches.match(req).then((m) => m ?? Response.error())),
  );
});
