import { defineConfig } from "vitest/config";

// اختبارات وحدات نقية للداشبورد (منطق i18n وأدوات) — بلا jsdom (لا مكوّنات React هنا).
// مكوّنات React/الوكيل الخادمي تُغطّى بـ @quickdrop/e2e (Playwright) ضد المكدّس الحي.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
