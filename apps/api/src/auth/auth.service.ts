import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { staff, tenants, withTenant, type DbHandle } from "@quickdrop/db";
import { STAFF_ROLES, type StaffRole } from "@quickdrop/shared";
import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { z } from "zod";
import { parseOr400, slugSchema } from "../common/staff-http.js";
import { DB, ENV, REDIS } from "../tokens.js";
import type { ApiEnv } from "../env.js";
import { SESSION_ID_RE, SESSION_TTL_S } from "./cookie.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./hashing.js";

// §10.2 — مصادقة الطاقم الحقيقية: email + argon2id + جلسات cookie عبر Redis.
// TODO(§10.2): TOTP إلزامي لدور owner وaccountant — يُبنى فوق هذه الجلسات لاحقاً
// (عمود staff.totp_secret موجود بالنموذج سلفاً): login ينجح ثم يطالب برمز TOTP
// قبل إصدار الجلسة الكاملة. غير مبني بهذه المرحلة عمداً.

const SESSION_KEY_PREFIX = "sess:";

/** §11 — فشل الدخول برسالة عامة واحدة + تأخير ثابت: لا يفرّق بريداً مجهولاً عن كلمة سر خاطئة. */
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
});

export type StaffSession = z.infer<typeof sessionSchema>;

export interface LoginResult {
  sessionId: string;
  role: StaffRole;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * §10.2 — الدخول: تحقق argon2id ثم جلسة 128-bit بـ Redis (TTL 8 ساعات).
   * كل مسارات الفشل (مستأجر مجهول/موقوف، بريد مجهول، موظف موقوف، كلمة سر خاطئة)
   * = نفس الرسالة العامة ونفس التأخير الثابت (§11) — السبب الحقيقي باللوغ فقط وبلا بريد.
   */
  async login(body: unknown): Promise<LoginResult> {
    const input = parseOr400(loginSchema, body, "auth_login");

    // البحث بالـ slug قبل معرفة المستأجر — استثناء RLS مسمّى (§2.4، نمط staff-http)
    const tenantRows = await this.handle.db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.slug, input.tenantSlug))
      .limit(1);
    const tenant = tenantRows[0];
    if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
      return this.failLogin("tenant_unavailable", input.tenantSlug);
    }

    const staffRows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({ id: staff.id, passwordHash: staff.passwordHash, role: staff.role, isActive: staff.isActive })
        .from(staff)
        .where(and(eq(staff.tenantId, tenant.id), eq(staff.email, input.email)))
        .limit(1),
    );
    const member = staffRows[0];

    if (!member) {
      // §11 — تسوية التوقيت: تحقق ضد هاش وهمي كي لا يكشف الزمن وجود البريد
      await verifyPassword(DUMMY_PASSWORD_HASH, input.password);
      return this.failLogin("unknown_email", input.tenantSlug);
    }
    const passwordOk = await verifyPassword(member.passwordHash, input.password);
    if (!member.isActive) {
      // التحقق جرى قبل الفحص عمداً (توقيت موحّد)؛ الموقوف يُرفض ولو صحّت كلمة السر
      return this.failLogin("inactive_staff", input.tenantSlug);
    }
    if (!passwordOk) {
      return this.failLogin("bad_password", input.tenantSlug);
    }

    const sessionId = randomBytes(16).toString("hex"); // 128-bit
    const session: StaffSession = {
      staffId: member.id,
      tenantId: tenant.id,
      tenantSlug: input.tenantSlug,
      role: member.role,
    };
    await this.redis.set(SESSION_KEY_PREFIX + sessionId, JSON.stringify(session), "EX", SESSION_TTL_S);

    // §13 — لوغ منظّم بحقول ثابتة: معرّفات فقط، لا بريد ولا كوكي (§11)
    console.log(
      JSON.stringify({ action: "auth_login", outcome: "ok", tenant_id: tenant.id, actor: member.id, role: member.role }),
    );
    return { sessionId, role: member.role };
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

  /** §11 — رسالة عامة واحدة + تأخير ثابت؛ السبب باللوغ فقط (slug بلا بريد — لا PII). */
  private async failLogin(reason: string, tenantSlug: string): Promise<never> {
    console.warn(JSON.stringify({ action: "auth_login", outcome: "failed", reason, tenantSlug }));
    await sleep(FAILED_LOGIN_DELAY_MS);
    throw new UnauthorizedException("invalid credentials");
  }
}
