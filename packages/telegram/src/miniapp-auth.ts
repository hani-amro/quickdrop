import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// §10.3 — تحقق initData الوارد من Telegram Mini App. HMAC-SHA256 بمفتاح مشتق من توكن
// بوت **هذا المستأجر تحديداً** — التحقق بتوكن عام ثغرة انتحال كاملة بين المستأجرين
// (الوثيقة §10.3). نرفض auth_date أقدم من maxAgeSeconds (5 دقائق) لمنع إعادة التشغيل.
// منطق صافٍ قابل للاختبار (§15): لا قاعدة ولا شبكة؛ now معامل صريح (D6) للاختبار.

const userSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

// النوع مشتق من الـ schema كي يتطابقا تماماً تحت exactOptionalPropertyTypes.
export type TelegramWebAppUser = z.infer<typeof userSchema>;

export type InitDataResult =
  | { ok: true; user: TelegramWebAppUser; authDate: Date }
  | { ok: false; reason: "bad_format" | "bad_hash" | "expired" | "no_user" };

/**
 * §10.3 — يبني data_check_string القياسي (كل الأزواج عدا hash، مرتّبة بالمفتاح، 'k=v'
 * مفصولة بـ \n) بقيَم **مفكوكة الترميز** (URLSearchParams يفكّها). مصدر واحد للاختبار والتحقق.
 */
export function buildDataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  for (const [k, v] of params) {
    if (k === "hash") continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort(); // المفاتيح فريدة، ففرز 'k=v' يكافئ الفرز بالمفتاح (شرط تيليغرام)
  return pairs.join("\n");
}

/**
 * §10.3 — توقيع initData الصحيح لتوكن بوت معطى (يُستعمل بالاختبارات وبتوليد أي حمولة
 * خادمية). secret_key = HMAC_SHA256(key="WebAppData", data=bot_token).
 */
export function signInitDataHash(dataCheckString: string, botToken: string): string {
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSeconds: number; now?: Date },
): InitDataResult {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "bad_format" };
  }

  const hash = params.get("hash");
  if (hash === null || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: "bad_format" };

  const dataCheckString = buildDataCheckString(params);
  const computedHex = signInitDataHash(dataCheckString, botToken);
  const computed = Buffer.from(computedHex, "hex");
  const provided = Buffer.from(hash, "hex");
  // مقارنة ثابتة الزمن؛ الأطوال متساوية (كلاهما SHA-256) لكن نحرسها قبل timingSafeEqual
  if (computed.length !== provided.length || !timingSafeEqual(computed, provided)) {
    return { ok: false, reason: "bad_hash" };
  }

  // auth_date (unix ثوانٍ) — رفض القديم؛ ونافذة انزلاق صغيرة للأمام (ساعة الخادم) بـ 60ث
  const authRaw = params.get("auth_date");
  const authUnix = authRaw === null ? Number.NaN : Number.parseInt(authRaw, 10);
  if (!Number.isFinite(authUnix)) return { ok: false, reason: "bad_format" };
  const nowMs = (opts.now ?? new Date()).getTime();
  const ageSeconds = nowMs / 1000 - authUnix;
  if (ageSeconds > opts.maxAgeSeconds || ageSeconds < -60) return { ok: false, reason: "expired" };

  const userRaw = params.get("user");
  if (userRaw === null) return { ok: false, reason: "no_user" };
  let userJson: unknown;
  try {
    userJson = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "bad_format" };
  }
  const parsed = userSchema.safeParse(userJson);
  if (!parsed.success) return { ok: false, reason: "no_user" };

  return { ok: true, user: parsed.data, authDate: new Date(authUnix * 1000) };
}
