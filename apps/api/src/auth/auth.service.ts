import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { staff, tenants, withTenant, type DbHandle } from "@quickdrop/db";
import { decryptSecret, encryptSecret, STAFF_ROLES, type StaffRole } from "@quickdrop/shared";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { z } from "zod";
import { parseOr400, slugSchema } from "../common/staff-http.js";
import { DB, ENV, REDIS } from "../tokens.js";
import type { ApiEnv } from "../env.js";
import { SESSION_ID_RE, SESSION_TTL_S } from "./cookie.js";
import { DUMMY_PASSWORD_HASH, hashPassword, needsRehash, remainingDelayMs, verifyPassword } from "./hashing.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

// §10.2 — مصادقة الطاقم الحقيقية: email + argon2id + جلسات cookie عبر Redis، مع
// TOTP إلزامي لدور owner وaccountant (RFC 6238، totp.ts). بعد نجاح كلمة السر:
// إن كان الدور مُلزَماً وله سرّ TOTP → لا جلسة الآن بل "تحدّي TOTP" قصير بـ Redis ثم
// verifyLoginTotp؛ وإن لم يسجّل سرّاً بعد → جلسة + mustEnrollTotp (يُلزَم بالتسجيل).

const SESSION_KEY_PREFIX = "sess:";

/** §10.2 — تحدّي TOTP وسيط (بعد كلمة السر، قبل الجلسة): يحمل هوية الموظف بمهلة قصيرة. */
const MFA_CHALLENGE_PREFIX = "mfa:";
const MFA_CHALLENGE_TTL_S = 5 * 60; // 5 دقائق لإدخال الرمز
// §11 — سقف محاولات TOTP لكل تحدٍّ: بعده يُبطَل التحدّي فيلزم دخول جديد بكلمة السر.
// حاجز على مستوى الحساب فوق حد المعدل لكل IP (يمنع تخمين الرمز السداسي موزّعاً على IPات).
const MFA_ATTEMPTS_PREFIX = "mfa:att:";
const MAX_MFA_ATTEMPTS = 5;

/** §10.2 — سرّ تسجيل TOTP معلّق (بين enroll وconfirm): لا يُثبَّت بـ staff حتى تأكيد رمز صحيح. */
const TOTP_ENROLL_PREFIX = "mfa_enroll:";
const TOTP_ENROLL_TTL_S = 10 * 60;

/** §10.2 — "الدخول كمكتب": جلسة طاقم مقيّدة القراءة مدتها 30 دقيقة (readonly + adminId). */
const IMPERSONATION_TTL_S = 30 * 60;

/** الأدوار المُلزَمة بـ TOTP (§10.2). */
function totpMandatory(role: StaffRole): boolean {
  return role === "owner" || role === "accountant";
}

// §11/مراجعة Phase 4 (security) — فشل الدخول بموعد نهائي ثابت (لا تأخير إضافي): توحيد المصادقة
// (§23) أدخل مسار bcrypt (طاقم WaFlow) الأبطأ من argon2 بـ ~200ms؛ التأخير الإضافي كان يترك
// هذا الفارق بالزمن الكلي فيكشف حساباً قديماً غير مُرقّى (enumeration). النوم حتى موعد ثابت
// يجعل زمن كل مسارات الفشل واحداً مهما كان الـ KDF. الموعد يتجاوز أبطأ مسار (bcrypt cost-12
// ~350ms + استعلامات) بهامش مريح.
const FAILED_LOGIN_DEADLINE_MS = 700;

// §11 — تأخير فشل ثابت لمسارات TOTP (تحقق رمز HMAC، لا KDF كلمة سر): لا تباين توقيت يُخفى،
// فالتأخير الإضافي البسيط يكفي (مسار كلمة السر بالدخول يستخدم الموعد النهائي أعلاه).
const FAILED_LOGIN_DELAY_MS = 300;

const loginSchema = z.object({
  tenantSlug: slugSchema,
  // lowercase عند الدخول وعند الإنشاء (create-staff/seed) معاً — القيد الفريد
  // (tenant_id, email) حساس لحالة الأحرف، فالتطبيع بالطرفين شرط التطابق.
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

// حمولة الجلسة بـ Redis — تمر بـ Zod عند القراءة (حدّ نظام: عملية أخرى قد تكتب المفتاح)
const sessionSchema = z.object({
  staffId: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantSlug: slugSchema, // مقارنة نطاق الجلسة بالحارس دون رحلة قاعدة (§10.2: جلسة = مستأجر واحد)
  role: z.enum(STAFF_ROLES),
  // §10.2 — "الدخول كمكتب": جلسة انتحال مقيّدة القراءة (GET فقط بالحارس) موقّعة بمعرّف المشرف
  readonly: z.boolean().optional(),
  adminId: z.string().uuid().optional(),
});

export type StaffSession = z.infer<typeof sessionSchema>;

// §10.2 — تحدّي TOTP بـ Redis: هوية الموظف كاملة كي تُبنى الجلسة بعد التحقق دون
// إعادة كشف الموظف. لا يُخزَّن سرّ TOTP هنا — يُعاد جلبه من القاعدة عند التحقق.
const mfaChallengeSchema = z.object({
  staffId: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantSlug: slugSchema,
  role: z.enum(STAFF_ROLES),
});

const totpVerifySchema = z.object({
  challenge: z.string().regex(SESSION_ID_RE), // نفس شكل معرّف الجلسة: 128-bit hex
  token: z.string().trim().regex(/^\d{6}$/),
});

const totpTokenSchema = z.object({
  token: z.string().trim().regex(/^\d{6}$/),
});

/** جلسة مُصدَرة (بعد كلمة سر لدور بلا TOTP، أو بعد تحقق TOTP). */
export interface AuthSessionIssued {
  sessionId: string;
  role: StaffRole;
}

/**
 * §10.2 — نتيجة الدخول: إمّا جلسة مباشرة (أدوار بلا TOTP، أو owner/accountant لم
 * يسجّل سرّاً بعد → mustEnrollTotp)، وإمّا تحدّي TOTP (دور مُلزَم وله سرّ مُفعّل).
 */
export type LoginResult =
  | { kind: "session"; sessionId: string; role: StaffRole; mustEnrollTotp: boolean }
  | { kind: "mfa_required"; challenge: string };

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get masterKey(): Buffer {
    return Buffer.from(this.env.MASTER_KEY, "hex");
  }

  /**
   * ترحيل 0013 — dual-read انتقالي: السرّ المشفّر (bytea) أولاً، وإلا النصي القديم
   * حتى اكتمال backfill (scripts/encrypt-secrets-at-rest.ts). الكتابة مشفّرة حصراً.
   */
  private resolveTotpSecret(row: { totpSecret: string | null; totpSecretEnc: Buffer | null }): string | null {
    if (row.totpSecretEnc !== null) return decryptSecret(row.totpSecretEnc, this.masterKey);
    return row.totpSecret;
  }

  /**
   * §10.2 — الدخول: تحقق argon2id ثم جلسة 128-bit بـ Redis (TTL 8 ساعات).
   * كل مسارات الفشل (مستأجر مجهول/موقوف، بريد مجهول، موظف موقوف، كلمة سر خاطئة)
   * = نفس الرسالة العامة ونفس التأخير الثابت (§11) — السبب الحقيقي باللوغ فقط وبلا بريد.
   */
  async login(body: unknown): Promise<LoginResult> {
    const input = parseOr400(loginSchema, body, "auth_login");
    // §11/مراجعة Phase 4 (security) — بداية نافذة التوقيت الثابت: كل مسارات الفشل تنام حتى
    // موعد نهائي واحد (لا تأخير إضافي)، فلا يكشف الزمن أي KDF جرى (argon2 سريع vs bcrypt بطيء).
    const startedAt = Date.now();

    // البحث بالـ slug قبل معرفة المستأجر — استثناء RLS مسمّى (§2.4، نمط staff-http)
    const tenantRows = await this.handle.db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.slug, input.tenantSlug))
      .limit(1);
    const tenant = tenantRows[0];
    if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
      return this.failLogin("tenant_unavailable", input.tenantSlug, startedAt);
    }

    const staffRows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({
          id: staff.id,
          passwordHash: staff.passwordHash,
          role: staff.role,
          isActive: staff.isActive,
          totpSecret: staff.totpSecret,
          totpSecretEnc: staff.totpSecretEnc,
        })
        .from(staff)
        .where(and(eq(staff.tenantId, tenant.id), eq(staff.email, input.email)))
        .limit(1),
    );
    const member = staffRows[0];

    if (!member) {
      // §11 — تسوية التوقيت: تحقق ضد هاش وهمي كي لا يكشف الزمن وجود البريد
      await verifyPassword(DUMMY_PASSWORD_HASH, input.password);
      return this.failLogin("unknown_email", input.tenantSlug, startedAt);
    }
    const passwordOk = await verifyPassword(member.passwordHash, input.password);
    if (!member.isActive) {
      // التحقق جرى قبل الفحص عمداً (توقيت موحّد)؛ الموقوف يُرفض ولو صحّت كلمة السر
      return this.failLogin("inactive_staff", input.tenantSlug, startedAt);
    }
    if (!passwordOk) {
      return this.failLogin("bad_password", input.tenantSlug, startedAt);
    }

    // §23 (توحيد المصادقة) — هجرة كسولة: هاش bcrypt (طاقم WaFlow مستورد) صحّ الآن → أعد
    // هاشه argon2id واحفظه (كلمة السر بيدنا هذه اللحظة، لا نص صريح مخزَّن). فشل التحديث
    // لا يمنع الدخول (الهاش القديم صالح؛ الترقية تتكرر بالدخول التالي).
    if (needsRehash(member.passwordHash)) {
      try {
        const upgraded = await hashPassword(input.password);
        await withTenant(this.handle.db, tenant.id, (tx) =>
          tx.update(staff).set({ passwordHash: upgraded, updatedAt: new Date() }).where(eq(staff.id, member.id)),
        );
        console.log(JSON.stringify({ action: "staff_password_rehashed", tenant_id: tenant.id, staff_id: member.id, from: "bcrypt", to: "argon2id" }));
      } catch (error) {
        console.error(JSON.stringify({ action: "staff_password_rehash_failed", tenant_id: tenant.id, staff_id: member.id, message: error instanceof Error ? error.message : String(error) }));
      }
    }

    // §10.2 — دور مُلزَم بـ TOTP وله سرّ مُفعّل: لا جلسة الآن؛ أصدر تحدّياً وسيطاً
    // (Redis) ثم POST /api/auth/totp/verify يُكمل الدخول. لا يُخزَّن السرّ بالتحدّي.
    const hasTotpSecret = member.totpSecretEnc !== null || member.totpSecret !== null;
    if (totpMandatory(member.role) && hasTotpSecret) {
      const challenge = randomBytes(16).toString("hex"); // 128-bit
      const payload: z.infer<typeof mfaChallengeSchema> = {
        staffId: member.id,
        tenantId: tenant.id,
        tenantSlug: input.tenantSlug,
        role: member.role,
      };
      await this.redis.set(MFA_CHALLENGE_PREFIX + challenge, JSON.stringify(payload), "EX", MFA_CHALLENGE_TTL_S);
      console.log(
        JSON.stringify({ action: "auth_login", outcome: "mfa_required", tenant_id: tenant.id, actor: member.id }),
      );
      return { kind: "mfa_required", challenge };
    }

    // جلسة مباشرة. owner/accountant بلا سرّ TOTP بعد → mustEnrollTotp (الواجهة تُلزمه بالتسجيل).
    const mustEnrollTotp = totpMandatory(member.role) && !hasTotpSecret;
    const sessionId = await this.issueSession(
      { staffId: member.id, tenantId: tenant.id, tenantSlug: input.tenantSlug, role: member.role },
      SESSION_TTL_S,
    );
    // §13 — لوغ منظّم بحقول ثابتة: معرّفات فقط، لا بريد ولا كوكي (§11)
    console.log(
      JSON.stringify({ action: "auth_login", outcome: "ok", tenant_id: tenant.id, actor: member.id, role: member.role }),
    );
    return { kind: "session", sessionId, role: member.role, mustEnrollTotp };
  }

  /**
   * §10.2 — إكمال الدخول بعد تحدّي TOTP: يتحقق من الرمز ضد سرّ الموظف (يُعاد جلبه من
   * القاعدة، لا من التحدّي) ثم يُصدر الجلسة الكاملة. كل فشل = رسالة عامة + تأخير ثابت (§11).
   * التحدّي يُستهلك مرة واحدة (يُحذف عند النجاح) — لا إعادة استخدام.
   */
  async verifyLoginTotp(body: unknown): Promise<AuthSessionIssued> {
    const input = parseOr400(totpVerifySchema, body, "auth_totp_verify");

    let raw: string | null;
    try {
      raw = await this.withTimeout(this.redis.get(MFA_CHALLENGE_PREFIX + input.challenge), 200);
    } catch {
      console.warn(JSON.stringify({ action: "auth_totp_verify", outcome: "redis_unavailable" }));
      return this.failTotp("redis_unavailable");
    }
    if (raw === null) return this.failTotp("challenge_missing"); // منتهٍ أو غير موجود
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(JSON.stringify({ action: "auth_totp_verify", outcome: "corrupt_challenge_json" })); // §16.12
      return this.failTotp("corrupt_challenge");
    }
    const challenge = mfaChallengeSchema.safeParse(parsed);
    if (!challenge.success) {
      console.error(JSON.stringify({ action: "auth_totp_verify", outcome: "corrupt_challenge_shape" }));
      return this.failTotp("corrupt_challenge");
    }
    const payload = challenge.data;

    const rows = await withTenant(this.handle.db, payload.tenantId, (tx) =>
      tx
        .select({ totpSecret: staff.totpSecret, totpSecretEnc: staff.totpSecretEnc, isActive: staff.isActive })
        .from(staff)
        .where(and(eq(staff.tenantId, payload.tenantId), eq(staff.id, payload.staffId)))
        .limit(1),
    );
    const member = rows[0];
    const secret = member ? this.resolveTotpSecret(member) : null;
    if (!member || !member.isActive || secret === null) {
      return this.failTotp("staff_or_secret_missing");
    }
    if (!verifyTotp(secret, input.token)) {
      // §11 — عدّاد محاولات لكل تحدٍّ: بعد MAX نُبطل التحدّي (لا يبقى حياً للتخمين)
      const attempts = await this.redis.incr(MFA_ATTEMPTS_PREFIX + input.challenge);
      if (attempts === 1) await this.redis.expire(MFA_ATTEMPTS_PREFIX + input.challenge, MFA_CHALLENGE_TTL_S);
      if (attempts >= MAX_MFA_ATTEMPTS) {
        await this.redis.del(MFA_CHALLENGE_PREFIX + input.challenge);
        console.warn(
          JSON.stringify({ action: "auth_totp_verify", outcome: "challenge_locked", tenant_id: payload.tenantId, actor: payload.staffId }),
        );
      }
      return this.failTotp("bad_totp");
    }

    await this.redis.del(MFA_CHALLENGE_PREFIX + input.challenge);
    await this.redis.del(MFA_ATTEMPTS_PREFIX + input.challenge); // نجاح — نظّف عدّاد المحاولات
    const sessionId = await this.issueSession(
      { staffId: payload.staffId, tenantId: payload.tenantId, tenantSlug: payload.tenantSlug, role: payload.role },
      SESSION_TTL_S,
    );
    console.log(
      JSON.stringify({
        action: "auth_login",
        outcome: "ok_mfa",
        tenant_id: payload.tenantId,
        actor: payload.staffId,
        role: payload.role,
      }),
    );
    return { sessionId, role: payload.role };
  }

  /**
   * §10.2 — بدء تسجيل TOTP (بجلسة صالحة): يولّد سرّاً ويخزّنه معلّقاً بـ Redis (لا يُثبَّت
   * بـ staff حتى confirm برمز صحيح)، ويرجع otpauth URL للعرض كـ QR بالداشبورد.
   */
  async enrollTotp(session: StaffSession): Promise<{ otpauthUrl: string }> {
    const rows = await withTenant(this.handle.db, session.tenantId, (tx) =>
      tx
        .select({ email: staff.email })
        .from(staff)
        .where(and(eq(staff.tenantId, session.tenantId), eq(staff.id, session.staffId)))
        .limit(1),
    );
    const member = rows[0];
    if (!member) {
      // جلسة بلا موظف مقابل (مثلاً جلسة انتحال) — لا تسجيل TOTP لها
      throw new UnauthorizedException();
    }
    const secret = generateTotpSecret();
    await this.redis.set(TOTP_ENROLL_PREFIX + session.staffId, secret, "EX", TOTP_ENROLL_TTL_S);
    // الملصق يظهر بتطبيق المصادقة — بريد الموظف داخل نطاق المستأجر
    return { otpauthUrl: otpauthUrl(secret, `${session.tenantSlug}:${member.email}`, "QuickDrop") };
  }

  /**
   * §10.2 — تثبيت TOTP: يتحقق من رمز مقابل السرّ المعلّق ثم يكتبه مشفّراً بـ
   * staff.totp_secret_enc (AES-256-GCM بـ MASTER_KEY — ترحيل 0013)، ويصفّر العمود
   * النصي القديم إن وُجد (إعادة تسجيل = ترحيل ضمني).
   */
  async confirmTotpEnroll(session: StaffSession, body: unknown): Promise<{ ok: true }> {
    const input = parseOr400(totpTokenSchema, body, "auth_totp_enroll_confirm");
    const secret = await this.redis.get(TOTP_ENROLL_PREFIX + session.staffId);
    if (secret === null) {
      throw new BadRequestException("no pending enrollment"); // انتهى أو لم يُبدأ enroll
    }
    if (!verifyTotp(secret, input.token)) {
      await sleep(FAILED_LOGIN_DELAY_MS);
      throw new UnauthorizedException(); // السرّ المعلّق يبقى — يعيد المحاولة ضمن مهلته
    }
    await withTenant(this.handle.db, session.tenantId, (tx) =>
      tx
        .update(staff)
        .set({ totpSecretEnc: encryptSecret(secret, this.masterKey), totpSecret: null, updatedAt: new Date() })
        .where(and(eq(staff.tenantId, session.tenantId), eq(staff.id, session.staffId))),
    );
    await this.redis.del(TOTP_ENROLL_PREFIX + session.staffId);
    console.log(
      JSON.stringify({ action: "auth_totp_enrolled", tenant_id: session.tenantId, actor: session.staffId }),
    );
    return { ok: true };
  }

  /**
   * §10.2 — "الدخول كمكتب": جلسة طاقم مقيّدة القراءة (readonly) للمستأجر مدة 30 دقيقة،
   * موقّعة بمعرّف المشرف. staffId = adminId (الفاعل مشرف لا موظف)، والدور owner لرؤية
   * قراءة كاملة؛ كل كتابة يحجبها الحارس (readonly → GET فقط). الاستدعاء بعد تحقق المشرف.
   */
  async createImpersonationSession(input: {
    tenantId: string;
    tenantSlug: string;
    adminId: string;
  }): Promise<{ sessionId: string; role: StaffRole; expiresInS: number }> {
    const session: StaffSession = {
      staffId: input.adminId,
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      role: "owner",
      readonly: true,
      adminId: input.adminId,
    };
    const sessionId = await this.issueSession(session, IMPERSONATION_TTL_S);
    return { sessionId, role: session.role, expiresInS: IMPERSONATION_TTL_S };
  }

  /** يكتب جلسة طاقم بـ Redis بمعرّف 128-bit وTTL معطى ويرجع المعرّف. */
  private async issueSession(session: StaffSession, ttlS: number): Promise<string> {
    const sessionId = randomBytes(16).toString("hex"); // 128-bit
    await this.redis.set(SESSION_KEY_PREFIX + sessionId, JSON.stringify(session), "EX", ttlS);
    return sessionId;
  }

  /** §11 — فشل تحقق TOTP: رسالة عامة + تأخير ثابت؛ السبب باللوغ فقط (بلا معرّفات مكشوفة). */
  private async failTotp(reason: string): Promise<never> {
    console.warn(JSON.stringify({ action: "auth_totp_verify", outcome: "failed", reason }));
    await sleep(FAILED_LOGIN_DELAY_MS);
    throw new UnauthorizedException("invalid credentials");
  }

  /** جلسة صالحة أو null — معرّف بغير شكل إصداراتنا يُرفض قبل Redis. */
  async getSession(sessionId: string): Promise<StaffSession | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    // §1/§14 — عميل ioredis المشترك يعلّق أوامره أثناء انقطاع Redis (maxRetriesPerRequest:null).
    // على المصادقة نفشل **مغلقين وبسرعة**: مهلة قصيرة → null → الحارس يرفض 401 (عكس الحدّ
    // الذي يفشل مفتوحاً). لا نُبقي مسار الطلب معلّقاً.
    let raw: string | null;
    try {
      raw = await this.withTimeout(this.redis.get(SESSION_KEY_PREFIX + sessionId), 200);
    } catch {
      console.warn(JSON.stringify({ action: "auth_get_session", outcome: "redis_unavailable" }));
      return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // §16.12 — مفتاح فاسد ليس "لا جلسة" صامتة: فساد بيانات يُسجَّل (بلا محتوى) ويُرفض
      console.error(JSON.stringify({ action: "auth_get_session", outcome: "corrupt_session_json" }));
      return null;
    }
    const session = sessionSchema.safeParse(parsed);
    if (!session.success) {
      console.error(JSON.stringify({ action: "auth_get_session", outcome: "corrupt_session_shape" }));
      return null;
    }
    return session.data;
  }

  /** الخروج idempotent: حذف مفتاح غائب/منتهي ليس خطأً. */
  async logout(sessionId: string): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId)) return;
    await this.redis.del(SESSION_KEY_PREFIX + sessionId);
  }

  /** يسابق نداء Redis بمهلة — انتهاؤها يرمي، فيفشل المستدعي مغلقاً (§1/§14). */
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

  /**
   * §11 — رسالة عامة واحدة + **زمن كلّي ثابت** بموعد نهائي؛ السبب باللوغ فقط (slug بلا بريد).
   * النوم = الموعد ناقص الزمن المنقضي منذ startedAt، فيتساوى إجمالي الرد بين مسار argon2
   * السريع ومسار bcrypt البطيء (مراجعة Phase 4: منع كشف الحساب بفارق التوقيت). المنقضي إن
   * تجاوز الموعد (نادر، خادم محمّل) → نوم 0؛ لا سالب.
   */
  private async failLogin(reason: string, tenantSlug: string, startedAt: number): Promise<never> {
    console.warn(JSON.stringify({ action: "auth_login", outcome: "failed", reason, tenantSlug }));
    await sleep(remainingDelayMs(FAILED_LOGIN_DEADLINE_MS, startedAt, Date.now()));
    throw new UnauthorizedException("invalid credentials");
  }
}
