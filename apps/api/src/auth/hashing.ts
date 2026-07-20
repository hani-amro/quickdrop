import { Algorithm, hash, verify } from "@node-rs/argon2";
import { verify as bcryptVerify } from "@node-rs/bcrypt";

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

// دمج WaFlow (MERGE_PLAN §23/R-09) — توحيد المصادقة: طاقم WaFlow المستورد يحمل هاش
// **bcrypt** ($2a/$2b/$2y). نتحقّق منه ونعيد الهاش argon2id **كسولاً عند أول دخول ناجح**
// (needsRehash)، فيُوحَّد المخزن تدريجياً بلا كلمات سر بنص صريح ولا إعادة ضبط جماعية.
const BCRYPT_RE = /^\$2[aby]\$/;

/** هل الهاش المخزّن بصيغة bcrypt (طاقم WaFlow مستورد)؟ */
export function isBcryptHash(storedHash: string): boolean {
  return BCRYPT_RE.test(storedHash);
}

/** يحتاج إعادة هاش argon2id؟ = هاش bcrypt (كل هاشات argon2 القائمة بمعاييرنا). */
export function needsRehash(storedHash: string): boolean {
  return isBcryptHash(storedHash);
}

/**
 * تحقق آمن يوحّد الخوارزميتين: bcrypt (طاقم WaFlow) أو argon2id (طاقم QuickDrop). هاش
 * مخزَّن مشوّه = رفض مسجَّل (§16.12 — لا ابتلاع صامت). لا يُسجَّل الهاش ولا كلمة السر (§11).
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    if (isBcryptHash(storedHash)) {
      return await bcryptVerify(password, storedHash);
    }
    return await verify(storedHash, password);
  } catch {
    console.error(JSON.stringify({ action: "password_verify", outcome: "invalid_hash_format" }));
    return false;
  }
}

/**
 * §11 — ضد تعداد البريد: عند بريد غير موجود نتحقق ضد هذا الهاش الوهمي كي لا يكون مسار
 * «لا مستخدم» فورياً. هاش كلمة سر عشوائية 256-bit أُهملت فور توليده — لا يقابل أي كلمة سر،
 * والتحقق ضده يفشل دائماً. ملاحظة (§23/مراجعة Phase 4): مع دخول مسار bcrypt (أبطأ من argon2)
 * لم يعد الهاش الوهمي وحده يسوّي الزمن؛ التسوية الكلّية يضمنها الموعد النهائي بـ failLogin
 * (remainingDelayMs) — كل مسارات الفشل تنام لنفس اللحظة مهما كان الـ KDF.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$LA8OOEmESgFIC/vTCVPGDw$X4Kg48jFvegcJDn8rZGXAj/XOHtbU/qKPUSw3joQ4dU";

/**
 * §11/مراجعة Phase 4 (security) — التوقيت الثابت لفشل الدخول: كم يتبقّى لبلوغ موعد نهائي
 * ثابت من لحظة البدء (= الموعد ناقص المنقضي، غير سالب). النوم بهذا القدر يجعل إجمالي زمن
 * كل مسارات الفشل واحداً مهما كان الـ KDF (argon2 سريع vs bcrypt طاقم WaFlow البطيء)، فلا
 * يكشف التوقيت وجود حساب قديم غير مُرقّى. نقيّة كي تُختبَر بلا توقيت حقيقي.
 */
export function remainingDelayMs(deadlineMs: number, startedAt: number, now: number): number {
  return Math.max(0, deadlineMs - (now - startedAt));
}
