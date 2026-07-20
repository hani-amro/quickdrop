import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// P5.1 — تطبيق السائق (PWA خفيف): يُقدَّم من جذر مضيفه. لا خرائط ثقيلة (العنوان + رابط
// "افتح بالخرائط" يكفيان؛ الملاحة على تطبيق هاتف السائق). base "/" لنطاق service worker نظيف.
export default defineConfig({
  base: "/",
  plugins: [react()],
  server: { port: 5174 },
});
