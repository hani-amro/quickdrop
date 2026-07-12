import { defineConfig } from "vitest/config";

// §15 — اختبارات التكامل تتشارك قاعدة Postgres واحدة وكلٌّ منها يبدأ بـ TRUNCATE شامل
// (نمط isolation.test.ts). تشغيل ملفات الاختبار بالتوازي (افتراضي vitest) يجعل مسحَ
// ملفٍ يجرف بيانات ملفٍ آخر أثناء عمله — لذلك الملفات تسلسلية. اختبارات الوحدة الصافية
// بنفس الحزمة صغيرة فلا كلفة تُذكر.
export default defineConfig({
  test: {
    fileParallelism: false,
    // سيناريوهات السباق تنتظر أقفال صفوف (وقد تنتظر فضّ deadlock ~ثانية) — مهلة أوسع من الافتراضي.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
