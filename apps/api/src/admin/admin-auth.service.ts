import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { findAdminUserByEmail, type DbHandle } from "@quickdrop/db";
import type { Redis } from "ioredis";
import { z } from "zod";
import { parseOr400 } from "../common/staff-http.js";
import { DB, REDIS } from "../tokens.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../auth/hashing.js";
import { ADMIN_SESSION_ID_RE, ADMIN_SESSION_TTL_S } from "./admin-cookie.js";

// §10.2 — دخول المشرف الحقيقي: نظام منفصل تماماً عن الطاقم. email + argon2id ضد
// admin_users (is_active) → جلسة Redis بمفتاح 'asess:' وكوكي 'qd_admin' مستقلين.
// نفس انضباط الطاقم: رسالة فشل عامة واحدة + تأخير ثابت + تسوية توقيت ضد تعداد البريد.
// TODO(§10.2): TOTP إلزامي للمشرف تحسين تالٍ (admin_users.totp_secret موجود) — يُبنى كنمط الطاقم.

const ADMIN_SESSION_KEY_PREFIX = "asess:";

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
});

export type AdminSession = z.infer<typeof adminSessionSchema>;

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** §10.2 — دخول المشرف: تحقق argon2id ثم جلسة 128-bit بـ Redis (asess:، TTL 8 ساعات). */
  async login(body: unknown): Promise<{ sessionId: string }> {
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

    const sessionId = randomBytes(16).toString("hex"); // 128-bit
    const session: AdminSession = { adminId: admin.id, email: admin.email };
    await this.redis.set(
      ADMIN_SESSION_KEY_PREFIX + sessionId,
      JSON.stringify(session),
      "EX",
      ADMIN_SESSION_TTL_S,
    );
    console.log(JSON.stringify({ action: "admin_login", outcome: "ok", actor: admin.id }));
    return { sessionId };
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
}
