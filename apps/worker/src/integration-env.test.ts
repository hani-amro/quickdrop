import { describe, expect, it } from "vitest";

// حارس ضد التخطي الصامت لاختبارات التكامل (توجيه المالك). كل *.integration.test.ts هنا
// يُحرَس بـ describe.skipIf(!hasDb) حيث hasDb = DATABASE_URL && DATABASE_URL_WORKER — فإن
// غابت هذه المتغيّرات عن التشغيل، تُتخطّى **بصمت** وتبدو النتيجة خضراء دون أن تجري فعلاً
// (بالذات تحت `turbo test`: وضع env الصارم يمرّر فقط ما بـ turbo.json → tasks.test.env).
// هذا الحارس اختبارٌ عادي **يجري دائماً** (ليس *.integration): يفشل صاخباً عند غياب أيٍّ من
// متغيّرات التكامل، فيتحوّل «تخطٍّ صامت» إلى «أحمر واضح» — تشغيل أخضر = التكامل جرى فعلاً.
//
// الاستثناء المشروع الوحيد: تشغيل وحدات محلي سريع بلا قاعدة/Redis — عيّن SKIP_INTEGRATION=1
// صراحةً (قرار واعٍ مسجَّل)، لا غياباً صامتاً. CI و`turbo test` لا يعيّنانه فيُفرَض التكامل.

const REQUIRED = ["DATABASE_URL", "DATABASE_URL_WORKER", "REDIS_URL"] as const;

describe("integration env guard — no silent skip (worker)", () => {
  it("all integration env vars are present (or SKIP_INTEGRATION is explicitly set)", () => {
    if (process.env["SKIP_INTEGRATION"] === "1") return; // تعطيل واعٍ صريح — لا غياب صامت
    const missing = REQUIRED.filter((k) => {
      const v = process.env[k];
      return v === undefined || v.trim() === "";
    });
    expect(
      missing,
      `Worker integration tests would SILENTLY SKIP — missing env: ${missing.join(", ")}. ` +
        `Set these (turbo passes them via turbo.json tasks.test.env), or set SKIP_INTEGRATION=1 to opt out on purpose.`,
    ).toEqual([]);
  });
});
