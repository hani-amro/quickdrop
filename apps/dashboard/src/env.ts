import { z } from "zod";

// §11 — env محقونة وقت التشغيل وتمر بـ Zod. التحقق كسول عند أول استخدام
// (لا عند import): `next build` لا يملك أسراراً ولا يحتاجها — أول طلب فعلي يفشل
// بصوت عالٍ إن نقصت القيم، لا فتح مفتوح ولا قيم افتراضية صامتة.
const envSchema = z.object({
  API_URL: z.string().url(),
  // نفس قيد الـ API (STAFF_API_TOKEN ≥ 32) — التوكن لا يغادر الخادم إلى المتصفح أبداً
  STAFF_API_TOKEN: z.string().min(32),
  // نفس قيد slug عند provision-tenant
  TENANT_SLUG: z.string().regex(/^[a-z0-9-]{2,32}$/),
});

export type DashboardEnv = z.infer<typeof envSchema>;

let cached: DashboardEnv | null = null;

export function getEnv(): DashboardEnv {
  if (cached === null) {
    const parsed = envSchema.safeParse({
      API_URL: process.env.API_URL,
      STAFF_API_TOKEN: process.env.STAFF_API_TOKEN,
      TENANT_SLUG: process.env.TENANT_SLUG,
    });
    if (!parsed.success) {
      // §11: التفاصيل باللوغ فقط (مسارات الحقول بلا قيم — لا أسرار)، والخطأ عام
      console.error(
        JSON.stringify({
          action: "dashboard_env",
          outcome: "validation_failed",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
        }),
      );
      throw new Error("dashboard env is not configured");
    }
    cached = parsed.data;
  }
  return cached;
}
