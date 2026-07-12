import type { NextConfig } from "next";

// §11 — CSP صارم على الداشبورد + رؤوس أمان أساسية.
// MapLibre GL يحتاج blob: (workers) وبلاطات OSM النقطية (img-src) — لا شيء آخر خارجي.
const isDev = process.env.NODE_ENV !== "production";

// §10.1 — Socket.IO يتصل بأصل الـ API مباشرة من المتصفح (لا يمر بالـ proxy الخادمي):
// أضِف الأصل بصيغتيه http(s) وws(s) إلى connect-src وإلا حجبه الـ CSP — handshake
// engine.io الأولي polling ثم ترقية WebSocket. القيمة بلا شرطة نهائية.
const rtApiOrigin = process.env.NEXT_PUBLIC_API_URL ?? "";
const rtConnectSrc = rtApiOrigin === "" ? "" : ` ${rtApiOrigin} ${rtApiOrigin.replace(/^http/, "ws")}`;

const csp = [
  "default-src 'self'",
  // Next يحقن سكربتات inline للـ hydration (بلا nonce بهالمرحلة)؛ dev يحتاج eval للـ refresh
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  `connect-src 'self' https://tile.openstreetmap.org${rtConnectSrc}`,
  "worker-src 'self' blob:",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
