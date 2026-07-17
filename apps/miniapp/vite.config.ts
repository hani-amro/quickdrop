import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Telegram Mini App يُقدَّم من مسار فرعي عبر النفق (ngrok/cloudflared) → base نسبي.
// §10.3 روحية اللوحة: maplibre-gl لا يدخل الحزمة الأولية — يُحمَّل ديناميكياً في شاشة
// التسليم فقط (await import داخل المكوّن)، و manualChunks يمنحه اسم chunk مستقلاً للقياس.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("maplibre-gl")) return "maplibre";
          return undefined;
        },
      },
    },
  },
});
