import { adminUsers, createDb, getAdminTotpForVerify, type DbHandle } from "@quickdrop/db";
import { decryptSecret } from "@quickdrop/shared";
import type { ExecutionContext } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiEnv } from "../env.js";
import { hashPassword } from "../auth/hashing.js";
import { totpToken } from "../auth/totp.js";
import { AdminAuthService, type AdminSession } from "./admin-auth.service.js";
import { AdminGuard } from "./admin.guard.js";

// E1 — 2FA للمشرف (تكامل حي DB + Redis): إلزامي لكل مشرف، جلسة مقيّدة بالتفعيل، تشفير
// السرّ عند الراحة، قفل التحدّي بعد 5 محاولات. نموذج driver.integration.test.ts.

const APP_URL = process.env["DATABASE_URL"];
const REDIS_URL = process.env["REDIS_URL"];
const hasDeps = Boolean(APP_URL && REDIS_URL);

const PASSWORD = "admin-pass-123";
const MASTER_KEY = "a".repeat(64);
const masterKeyBuf = Buffer.from(MASTER_KEY, "hex");
const env = { MASTER_KEY } as unknown as ApiEnv;

function ctx(path: string, sessionId?: string): ExecutionContext {
  const request: Record<string, unknown> = {
    path,
    headers: sessionId !== undefined ? { cookie: `qd_admin=${sessionId}` } : {},
  };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe.skipIf(!hasDeps)("AdminAuthService — 2FA إلزامي + جلسة مقيّدة بالتفعيل (E1)", () => {
  let handle: DbHandle;
  let redis: Redis;
  let service: AdminAuthService;
  let guard: AdminGuard;
  let adminId: string;
  let email: string;

  // حالة مشتركة عبر الاختبارات المتسلسلة (تفعيل ثم دخول لاحق بالسرّ)
  let pendingSessionId: string;
  let session: AdminSession;
  let secret: string;

  beforeAll(async () => {
    handle = createDb(APP_URL!);
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    service = new AdminAuthService(handle, env, redis);
    guard = new AdminGuard(service, env);
    email = `admin-${Date.now().toString(36)}@qa.test`;
    const passwordHash = await hashPassword(PASSWORD);
    const rows = await handle.db.insert(adminUsers).values({ email, passwordHash }).returning({ id: adminUsers.id });
    adminId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.db.delete(adminUsers).where(eq(adminUsers.id, adminId)).catch(() => undefined);
    await handle.close();
    redis.disconnect();
  });

  it("إلزامي: دخول مشرف بلا سرّ → جلسة مقيّدة بالتفعيل + البوّابة تمنع غير التفعيل", async () => {
    const result = await service.login({ email, password: PASSWORD });
    expect(result.kind).toBe("session");
    if (result.kind !== "session") throw new Error("unreachable");
    expect(result.pendingEnroll).toBe(true);
    pendingSessionId = result.sessionId;

    const s = await service.getSession(pendingSessionId);
    expect(s?.pendingEnroll).toBe(true);
    session = s!;

    // البوّابة: مسار غير التفعيل → 403؛ مسار التفعيل → مسموح
    await expect(guard.canActivate(ctx("/api/admin/tenants", pendingSessionId))).rejects.toThrow();
    expect(await guard.canActivate(ctx("/api/admin/auth/totp/enroll", pendingSessionId))).toBe(true);
  });

  it("تفعيل → تأكيد → السرّ مشفّر عند الراحة + الجلسة تُرقّى لكاملة", async () => {
    const { otpauthUrl } = await service.enrollTotp(session);
    secret = new URL(otpauthUrl).searchParams.get("secret") ?? "";
    expect(secret).toMatch(/^[A-Z2-7]+$/);

    const confirmed = await service.confirmTotpEnroll(session, pendingSessionId, { token: totpToken(secret) });
    expect(confirmed).toEqual({ ok: true });

    // مخزّن مشفّراً؛ النصّي مصفّر؛ الفكّ يطابق
    const row = await getAdminTotpForVerify(handle.db, adminId);
    expect(row?.totpSecret).toBeNull();
    expect(row?.totpSecretEnc).not.toBeNull();
    expect(decryptSecret(row!.totpSecretEnc!, masterKeyBuf)).toBe(secret);

    // الجلسة رُقّيت: pendingEnroll زالت → البوّابة تسمح بكل المسارات
    const s = await service.getSession(pendingSessionId);
    expect(s?.pendingEnroll ?? false).toBe(false);
    expect(await guard.canActivate(ctx("/api/admin/tenants", pendingSessionId))).toBe(true);
  });

  it("لديه سرّ: دخول → mfa_required → verify بكود صحيح → جلسة كاملة", async () => {
    const result = await service.login({ email, password: PASSWORD });
    expect(result.kind).toBe("mfa_required");
    if (result.kind !== "mfa_required") throw new Error("unreachable");

    const verified = await service.verifyLoginTotp({ challenge: result.challenge, token: totpToken(secret) });
    expect(verified.sessionId).toMatch(/^[0-9a-f]{32}$/);
    const s = await service.getSession(verified.sessionId);
    expect(s?.pendingEnroll ?? false).toBe(false); // جلسة كاملة (لا تفعيل)
  });

  it("قفل التحدّي بعد 5 أكواد خاطئة (التحدّي يُحذف — حتى الصحيح يفشل بعدها)", async () => {
    const result = await service.login({ email, password: PASSWORD });
    if (result.kind !== "mfa_required") throw new Error("unreachable");
    const good = totpToken(secret);
    const bad = good === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) {
      await expect(service.verifyLoginTotp({ challenge: result.challenge, token: bad })).rejects.toThrow();
    }
    // استُنفدت المحاولات → التحدّي محذوف؛ الكود الصحيح لم يعد ينفع (يلزم إعادة دخول)
    await expect(service.verifyLoginTotp({ challenge: result.challenge, token: totpToken(secret) })).rejects.toThrow();
  });

  it("كلمة سر خاطئة → فشل عام (لا تسريب، لا جلسة)", async () => {
    await expect(service.login({ email, password: "wrong-password" })).rejects.toThrow();
  });
});
