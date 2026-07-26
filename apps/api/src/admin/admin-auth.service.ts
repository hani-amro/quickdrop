import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { findAdminUserByEmail, getAdminTotpForVerify, setAdminTotpSecret, type DbHandle } from "@quickdrop/db";
import { decryptSecret, encryptSecret } from "@quickdrop/shared";
import type { Redis } from "ioredis";
import { z } from "zod";
import { parseOr400 } from "../common/staff-http.js";
import { DB, ENV, REDIS } from "../tokens.js";
import type { ApiEnv } from "../env.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../auth/hashing.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../auth/totp.js";
import { ADMIN_SESSION_ID_RE, ADMIN_SESSION_TTL_S } from "./admin-cookie.js";

// §10.2 + E1 — دخول المشرف الحقيقي: نظام منفصل تماماً عن الطاقم. email + argon2id ضد
// admin_users (is_active) → **TOTP إلزامي لكل مشرف** (بمحاكاة نمط الطاقم) → جلسة Redis
// بمفتاح 'asess:' وكوكي 'qd_admin' مستقلين. مساحات MFA منفصلة عن الطاقم ('admin_mfa*').
// مشرف بلا سرّ → جلسة **مقيّدة بالتفعيل** (pendingEnroll) يقصرها AdminGuard على التفعيل فقط.
// نفس انضباط الطاقم: رسالة فشل عامة واحدة + تأخير ثابت + تسوية توقيت ضد تعداد البريد.

const ADMIN_SESSION_KEY_PREFIX = "asess:";

// E1 — مساحات MFA للمشرف (منفصلة عن الطاقم mfa*/mfa_enroll* — صفر تصادم)
const ADMIN_MFA_CHALLENGE_PREFIX = "admin_mfa:";
const ADMIN_MFA_CHALLENGE_TTL_S = 5 * 60; // مهلة إدخال الكود
const ADMIN_MFA_ATTEMPTS_PREFIX = "admin_mfa:att:";
const ADMIN_MAX_MFA_ATTEMPTS = 5; // قفل على مستوى التحدّي (يحرق التحدّي بعد 5)
// قفل على مستوى **الحساب** (مراجعة عدائية major): مفتاحه adminId لا challenge، فتحدٍّ جديد
// لا يصفّره — يمنع تخمين TOTP الموزّع عبر إعادة الدخول (الذي يبطل ضمان العامل الثاني).
const ADMIN_MFA_ACCT_ATTEMPTS_PREFIX = "admin_mfa:acct_att:";
const ADMIN_MAX_ACCT_MFA_ATTEMPTS = 10; // فشل TOTP للحساب (عبر تحدّيات متعددة) قبل القفل
const ADMIN_MFA_ACCT_LOCK_TTL_S = 15 * 60; // نافذة قفل الحساب (تنتهي ذاتياً)
const ADMIN_TOTP_ENROLL_PREFIX = "admin_mfa_enroll:";
const ADMIN_TOTP_ENROLL_TTL_S = 10 * 60; // سرّ معلّق بـ Redis حتى التأكيد

/** §11 — فشل الدخول برسالة عامة + تأخير ثابت (لا يفرّق مشرفاً مجهولاً عن كلمة سر خاطئة). */
const FAILED_LOGIN_DELAY_MS = 300;

const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

// حمولة جلسة المشرف بـ Redis — تمرّ بـ Zod عند القراءة (حدّ نظام: عملية أخرى قد تكتب المفتاح)
const adminSessionSchema = z.object({
  adminId: z.string().uuid(),
  email: z.string().email(),
  pendingEnroll: z.boolean().optional(), // E1 — جلسة مقيّدة بالتفعيل (قبل تأكيد TOTP)
});

// حمولة تحدّي MFA (السرّ لا يُخزَّن هنا — يُعاد جلبه من القاعدة عند التحقق)
const adminMfaChallengeSchema = z.object({ adminId: z.string().uuid(), email: z.string().email() });

const adminTotpVerifySchema = z.object({
  challenge: z.string().regex(ADMIN_SESSION_ID_RE), // نفس شكل معرّف الجلسة (128-bit hex)
  token: z.string().trim().regex(/^\d{6}$/),
});
const adminTotpTokenSchema = z.object({ token: z.string().trim().regex(/^\d{6}$/) });

export type AdminSession = z.infer<typeof adminSessionSchema>;

/** نتيجة دخول المشرف: تحدّي MFA (بلا جلسة) أو جلسة (كاملة أو مقيّدة بالتفعيل). */
export type AdminLoginResult =
  | { kind: "session"; sessionId: string; pendingEnroll: boolean }
  | { kind: "mfa_required"; challenge: string };

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get masterKey(): Buffer {
    return Buffer.from(this.env.MASTER_KEY, "hex");
  }

  /** قراءة مزدوجة: المشفّر مقدَّم (فكّ)، وإلا النصّي الانتقالي. (مكرَّرة محلياً — لا مسّ للطاقم.) */
  private resolveTotpSecret(row: { totpSecret: string | null; totpSecretEnc: Buffer | null }): string | null {
    if (row.totpSecretEnc !== null) return decryptSecret(row.totpSecretEnc, this.masterKey);
    return row.totpSecret;
  }

  /** إصدار جلسة Redis (asess:، 128-bit، TTL 8 ساعات) وإرجاع معرّفها. */
  private async issueSession(session: AdminSession): Promise<string> {
    const sessionId = randomBytes(16).toString("hex"); // 128-bit
    await this.redis.set(ADMIN_SESSION_KEY_PREFIX + sessionId, JSON.stringify(session), "EX", ADMIN_SESSION_TTL_S);
    return sessionId;
  }

  /**
   * §10.2 + E1 — دخول المشرف: تحقق argon2id ثم بوّابة TOTP إلزامية:
   * - لديه سرّ → تحدّي MFA (بلا كوكي) يُكمَّل بـ verifyLoginTotp.
   * - بلا سرّ → جلسة **مقيّدة بالتفعيل** (pendingEnroll) — التفعيل إلزامي قبل أي وصول.
   */
  async login(body: unknown): Promise<AdminLoginResult> {
    const input = parseOr400(adminLoginSchema, body, "admin_login");

    const admin = await findAdminUserByEmail(this.handle.db, input.email);
    if (!admin) {
      // §11 — تسوية التوقيت: تحقق ضد هاش وهمي كي لا يكشف الزمن وجود البريد
      await verifyPassword(DUMMY_PASSWORD_HASH, input.password);
      return this.fail("unknown_admin");
    }
    const passwordOk = await verifyPassword(admin.passwordHash, input.password);
    if (!admin.isActive) {
      return this.fail("inactive_admin"); // التحقق قبل الفحص عمداً (توقيت موحّد)
    }
    if (!passwordOk) {
      return this.fail("bad_password");
    }

    const hasSecret = admin.totpSecretEnc !== null || admin.totpSecret !== null;
    if (hasSecret) {
      const challenge = randomBytes(16).toString("hex"); // 128-bit، بشكل معرّف الجلسة
      const payload: z.infer<typeof adminMfaChallengeSchema> = { adminId: admin.id, email: admin.email };
      await this.redis.set(
        ADMIN_MFA_CHALLENGE_PREFIX + challenge,
        JSON.stringify(payload),
        "EX",
        ADMIN_MFA_CHALLENGE_TTL_S,
      );
      console.log(JSON.stringify({ action: "admin_login", outcome: "mfa_required", actor: admin.id }));
      return { kind: "mfa_required", challenge };
    }

    // بلا سرّ → التفعيل إلزامي: جلسة مقيّدة (AdminGuard يقصرها على مسارات التفعيل)
    const sessionId = await this.issueSession({ adminId: admin.id, email: admin.email, pendingEnroll: true });
    console.log(JSON.stringify({ action: "admin_login", outcome: "ok_pending_enroll", actor: admin.id }));
    return { kind: "session", sessionId, pendingEnroll: true };
  }

  /** E1 — إكمال الدخول بالتحقق من كود TOTP: يستهلك التحدّي ويصدر جلسة **كاملة**. */
  async verifyLoginTotp(body: unknown): Promise<{ sessionId: string }> {
    const input = parseOr400(adminTotpVerifySchema, body, "admin_totp_verify");
    const challengeKey = ADMIN_MFA_CHALLENGE_PREFIX + input.challenge;

    let raw: string | null;
    try {
      raw = await this.withTimeout(this.redis.get(challengeKey), 200);
    } catch {
      return this.failTotp("redis_unavailable");
    }
    if (raw === null) return this.failTotp("no_challenge");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.failTotp("corrupt_challenge_json"); // §16.12
    }
    const challenge = adminMfaChallengeSchema.safeParse(parsed);
    if (!challenge.success) return this.failTotp("corrupt_challenge_shape");
    const adminId = challenge.data.adminId;

    // قفل على مستوى الحساب (مفتاحه adminId): تحدٍّ جديد لا يصفّره فلا يُلتَفّ عليه بإعادة
    // الدخول. incr-first (قبل verifyTotp) يغلق أيضاً TOCTOU التزامن على التحدّي الواحد.
    // الوصول هنا يتطلّب أصلاً كلمة سر صحيحة (تحدٍّ صالح) — فلا قفل بلا مصادقة كلمة سر.
    const acctKey = ADMIN_MFA_ACCT_ATTEMPTS_PREFIX + adminId;
    const acctAttempts = await this.redis.incr(acctKey);
    if (acctAttempts === 1) await this.redis.expire(acctKey, ADMIN_MFA_ACCT_LOCK_TTL_S);
    if (acctAttempts > ADMIN_MAX_ACCT_MFA_ATTEMPTS) return this.failTotp("account_locked");

    const row = await getAdminTotpForVerify(this.handle.db, adminId);
    if (!row || !row.isActive) return this.failTotp("admin_gone_or_inactive");
    let secret: string | null;
    try {
      secret = this.resolveTotpSecret(row); // فشل الفكّ (مفتاح مدوَّر/تالف) → 401 نظيف لا 500
    } catch {
      return this.failTotp("decrypt_error");
    }
    if (secret === null) return this.failTotp("no_secret");

    if (!verifyTotp(secret, input.token)) {
      // قفل على مستوى التحدّي: يحرق التحدّي بعد 5 (إضافةً لقفل الحساب أعلاه)
      const attemptsKey = ADMIN_MFA_ATTEMPTS_PREFIX + input.challenge;
      const attempts = await this.redis.incr(attemptsKey);
      if (attempts === 1) await this.redis.expire(attemptsKey, ADMIN_MFA_CHALLENGE_TTL_S);
      if (attempts >= ADMIN_MAX_MFA_ATTEMPTS) {
        await this.redis.del(challengeKey); // استُنفدت المحاولات → التحدّي لا يُعاد استعماله
        await this.redis.del(attemptsKey);
      }
      return this.failTotp("bad_totp");
    }

    await this.redis.del(challengeKey);
    await this.redis.del(ADMIN_MFA_ATTEMPTS_PREFIX + input.challenge);
    await this.redis.del(acctKey); // نجاح → صفّر عدّاد فشل الحساب
    const sessionId = await this.issueSession({ adminId, email: challenge.data.email });
    console.log(JSON.stringify({ action: "admin_login", outcome: "ok_mfa", actor: adminId }));
    return { sessionId };
  }

  /** E1 — بدء تفعيل TOTP: سرّ معلّق بـ Redis (10د) + رابط otpauth (يتطلّب جلسة مشرف). */
  async enrollTotp(session: AdminSession): Promise<{ otpauthUrl: string }> {
    const secret = generateTotpSecret();
    await this.redis.set(ADMIN_TOTP_ENROLL_PREFIX + session.adminId, secret, "EX", ADMIN_TOTP_ENROLL_TTL_S);
    return { otpauthUrl: otpauthUrl(secret, session.email, "QuickDrop Admin") };
  }

  /**
   * E1 — تأكيد التفعيل: يتحقّق من الكود ضد السرّ المعلّق، يخزّنه مشفّراً، **ويرقّي الجلسة**
   * في مكانها (يُسقط pendingEnroll) — فيصير الوصول كاملاً بلا إعادة دخول.
   */
  async confirmTotpEnroll(session: AdminSession, sessionId: string, body: unknown): Promise<{ ok: true }> {
    const input = parseOr400(adminTotpTokenSchema, body, "admin_totp_enroll_confirm");
    const secret = await this.redis.get(ADMIN_TOTP_ENROLL_PREFIX + session.adminId);
    if (secret === null) throw new BadRequestException("no pending enrollment");
    if (!verifyTotp(secret, input.token)) {
      await sleep(FAILED_LOGIN_DELAY_MS); // كود خاطئ: السرّ المعلّق يبقى ضمن TTL (إعادة محاولة)
      throw new UnauthorizedException("invalid credentials");
    }
    await setAdminTotpSecret(this.handle.db, session.adminId, encryptSecret(secret, this.masterKey));
    await this.redis.del(ADMIN_TOTP_ENROLL_PREFIX + session.adminId);
    // ترقية الجلسة في مكانها: تُسقط pendingEnroll. نُعيد ضبط TTL كاملاً (المشرف صادق للتوّ)
    // — أبسط وأكثر أماناً عبر إصدارات Redis من KEEPTTL (تتطلّب 6.0+).
    await this.redis.set(
      ADMIN_SESSION_KEY_PREFIX + sessionId,
      JSON.stringify({ adminId: session.adminId, email: session.email }),
      "EX",
      ADMIN_SESSION_TTL_S,
      "XX", // ترقية فقط إن كانت الجلسة قائمة (لا تُحيي جلسة أُبطلت بخروج متزامن)
    );
    console.log(JSON.stringify({ action: "admin_totp_enrolled", actor: session.adminId }));
    return { ok: true };
  }

  /** جلسة مشرف صالحة أو null — يفشل مغلقاً وبسرعة عند تعليق Redis (§1/§14، كجلسة الطاقم). */
  async getSession(sessionId: string): Promise<AdminSession | null> {
    if (!ADMIN_SESSION_ID_RE.test(sessionId)) return null;
    let raw: string | null;
    try {
      raw = await this.withTimeout(this.redis.get(ADMIN_SESSION_KEY_PREFIX + sessionId), 200);
    } catch {
      console.warn(JSON.stringify({ action: "admin_get_session", outcome: "redis_unavailable" }));
      return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(JSON.stringify({ action: "admin_get_session", outcome: "corrupt_session_json" })); // §16.12
      return null;
    }
    const session = adminSessionSchema.safeParse(parsed);
    if (!session.success) {
      console.error(JSON.stringify({ action: "admin_get_session", outcome: "corrupt_session_shape" }));
      return null;
    }
    return session.data;
  }

  /** الخروج idempotent: حذف مفتاح غائب/منتهٍ ليس خطأً. */
  async logout(sessionId: string): Promise<void> {
    if (!ADMIN_SESSION_ID_RE.test(sessionId)) return;
    await this.redis.del(ADMIN_SESSION_KEY_PREFIX + sessionId);
  }

  /** يسابق نداء Redis بمهلة — انتهاؤها يرمي فيفشل المستدعي مغلقاً (§1/§14). */
  private withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("redis timeout")), ms);
      op.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /** §11 — رسالة عامة واحدة + تأخير ثابت؛ السبب باللوغ فقط (بلا بريد — لا PII). */
  private async fail(reason: string): Promise<never> {
    console.warn(JSON.stringify({ action: "admin_login", outcome: "failed", reason }));
    await sleep(FAILED_LOGIN_DELAY_MS);
    throw new UnauthorizedException("invalid credentials");
  }

  /** §11 — فشل تحقق TOTP: رسالة عامة + تأخير ثابت (لا يفرّق الأسباب). */
  private async failTotp(reason: string): Promise<never> {
    console.warn(JSON.stringify({ action: "admin_totp_verify", outcome: "failed", reason }));
    await sleep(FAILED_LOGIN_DELAY_MS);
    throw new UnauthorizedException("invalid credentials");
  }
}
