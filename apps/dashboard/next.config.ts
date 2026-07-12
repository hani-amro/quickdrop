import path from "node:path";
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

// §12 — إخراج standalone للصورة الإنتاجية: Next يتتبّع التبعيات وينتج server.js مع
// node_modules مصغّرة مكتفية ذاتياً فلا حاجة لـ pnpm deploy. outputFileTracingRoot =
// جذر الـ monorepo كي يتتبّع حزمة الـ workspace (@quickdrop/shared) عبر روابط pnpm
// الرمزية وينسخ ملفاتها؛ ومعه يصير مدخل التشغيل apps/dashboard/server.js داخل standalone.
// مبوَّب خلف BUILD_STANDALONE=1 (يضبطه Dockerfile): نسخ standalone يُنشئ روابط رمزية
// وويندوز يمنعها بلا صلاحية مرتفعة (EPERM) فيكسر `pnpm build` محلياً — البناء الإنتاجي
// على لينكس (node:24-slim) يسمح بها. التبويب يُبقي بناء المضيف أخضر ويفعّل standalone بالصورة.
const standalone: Pick<NextConfig, "output" | "outputFileTracingRoot"> =
  process.env.BUILD_STANDALONE === "1"
    ? { output: "standalone", outputFileTracingRoot: path.join(__dirname, "../..") }
    : {};

const nextConfig: NextConfig = {
  ...standalone,
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
