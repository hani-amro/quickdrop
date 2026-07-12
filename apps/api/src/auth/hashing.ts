import { Algorithm, hash, verify } from "@node-rs/argon2";

// §10.2 — argon2id لكلمات سر الطاقم عبر @node-rs/argon2 (prebuilt — بلا native build).
// المعايير = الحد الأدنى الموصى به من OWASP: m=19456KiB (19MiB), t=2, p=1.
// نفس المعايير حرفياً بـ seed-dev (packages/db/scripts/seed-dev.ts) — أي تغيير هنا
// لا يكسر الهاشات القائمة (الهاش يحمل معاييره ذاتياً)، لكن حدّث الاثنين معاً.
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * تحقق آمن: هاش مخزَّن مشوّه = رفض مسجَّل (§16.12 — لا ابتلاع صامت؛ يشير لفساد
 * بيانات، لا لمحاولة دخول خاطئة). لا يُسجَّل الهاش ولا كلمة السر أبداً (§11).
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    console.error(JSON.stringify({ action: "password_verify", outcome: "invalid_hash_format" }));
    return false;
  }
}

/**
 * §11 — تسوية التوقيت ضد تعداد البريد: عند بريد غير موجود نتحقق ضد هذا الهاش
 * الوهمي بنفس المعايير فيتساوى زمن الفرعين. هاش كلمة سر عشوائية 256-bit أُهملت
 * فور توليده — لا يقابل أي كلمة سر معروفة، والتحقق ضده يفشل دائماً.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$LA8OOEmESgFIC/vTCVPGDw$X4Kg48jFvegcJDn8rZGXAj/XOHtbU/qKPUSw3joQ4dU";
