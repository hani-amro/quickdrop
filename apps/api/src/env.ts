import { parseEnv } from "@quickdrop/shared";
import { z } from "zod";

// كل env vars تمر بـ Zod عند الإقلاع (§1) — الفشل صاخب وقبل فتح أي منفذ.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // MASTER_KEY: 32 بايت hex (§4.2) — openssl rand -hex 32
  MASTER_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "MASTER_KEY must be 64 hex chars (32 bytes)"),
  // أمان مؤقت لمسارات D15 (/api/orders): Authorization: Bearer = هذا التوكن —
  // openssl rand -hex 32. staff auth الحقيقي (جلسات + argon2id §10.2) لاحقاً.
  // غيابه = المسارات ترد 503 (معطَّلة بصوت عالٍ)، لا فتح مفتوح.
  STAFF_API_TOKEN: z.string().min(32).optional(),
  // §10.2/§14 — كونسول المشرف: مصادقة منفصلة تماماً عن STAFF_API_TOKEN. مؤقتاً
  // Bearer = هذا التوكن (openssl rand -hex 32)؛ دخول المشرف الحقيقي (admin_users +
  // جلسات §10.2) لاحقاً. غيابه = كل /api/admin/* ترد 503 (معطَّلة بصوت عالٍ).
  ADMIN_API_TOKEN: z.string().min(32).optional(),
  // §10.2 — هوية المشرف الفاعل (يوقّع audit_log). ثابت مؤقت حتى دخول المشرف الكامل؛
  // غيابه = تُسجَّل عمليات المشرف بلوغ منظّم بلا صف audit_log (CHECK/FK يفرضان مشرفاً).
  ADMIN_ID: z.string().uuid().optional(),
  // §13 — Sentry: غيابه = مراقبة أخطاء معطَّلة (no-op)، لا فشل.
  SENTRY_DSN: z.string().url().optional(),
  // دمج WaFlow (MERGE_PLAN §3.1) — قناة واتساب Cloud API. سرّا التطبيق على مستوى
  // المنصة (تطبيق Meta واحد لكل المستأجرين؛ التوجيه بالمستأجر عبر phone_number_id).
  // غيابهما = بوابة /wa معطَّلة بصوت عالٍ (403 verify / تجاهل موقَّع) — لا فتح مفتوح.
  META_APP_SECRET: z.string().min(16).optional(),
  META_VERIFY_TOKEN: z.string().min(16).optional(),
  // دمج WaFlow (خطوة 20) — Billplz: قاعدة الـ API (sandbox للاختبار) وعنواننا العام
  // (يُبنى منه callback_url). الاعتمادات نفسها لكل مستأجر بالقاعدة (مشفّرة — ترحيل 0021).
  BILLPLZ_BASE_URL: z.string().url().default("https://www.billplz.com/api/v3"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:3000"),
  // P5.1 — قناة السائق (PWA): جذر مضيف تطبيق السائق لبناء رابط الربط (deep-link) الذي
  // يُرسله المكتب. غيابه = افتراضي التطوير المحلي (لا فشل — الرابط يُبنى بأي حال).
  DRIVER_APP_URL: z.string().url().optional(),
});

export type ApiEnv = z.infer<typeof envSchema>;

export function loadEnv(): ApiEnv {
  return parseEnv(envSchema);
}
