import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { ApiEnv } from "../env.js";
import { AdminGuard, isAdminGuardedPath, isEnrollWhitelistedPath } from "./admin.guard.js";
import type { AdminAuthService, AdminSession } from "./admin-auth.service.js";

// E1 — حارس كونسول المشرف: إعفاء المصادقة الذاتية، وبوّابة "جلسة مقيّدة بالتفعيل"
// (pendingEnroll → 403 على أي مسار عدا التفعيل). التطبيع حمّال أمنياً (§11).

const COOKIE = `qd_admin=${"a".repeat(32)}`;
const PENDING: AdminSession = { adminId: "00000000-0000-0000-0000-000000000001", email: "a@b.co", pendingEnroll: true };
const FULL: AdminSession = { adminId: "00000000-0000-0000-0000-000000000002", email: "c@d.co" };

function makeCtx(path: string, headers: Record<string, unknown> = {}): {
  ctx: ExecutionContext;
  request: Record<string, unknown>;
} {
  const request: Record<string, unknown> = { path, headers };
  const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { ctx, request };
}

function guardWith(session: AdminSession | null, env: Partial<ApiEnv> = {}): AdminGuard {
  const adminAuth = { getSession: () => Promise.resolve(session) } as unknown as AdminAuthService;
  return new AdminGuard(adminAuth, env as ApiEnv);
}

describe("isAdminGuardedPath", () => {
  it("يعفي المصادقة الذاتية (login/logout/session/totp/verify)", () => {
    expect(isAdminGuardedPath("/api/admin/auth/login")).toBe(false);
    expect(isAdminGuardedPath("/api/admin/auth/logout")).toBe(false);
    expect(isAdminGuardedPath("/api/admin/auth/session")).toBe(false);
    expect(isAdminGuardedPath("/api/admin/auth/totp/verify")).toBe(false); // E1 — mid-login بلا جلسة
  });
  it("يحرس بقية نطاق المشرف (بما فيه enroll/confirm — يحتاجان الجلسة)", () => {
    expect(isAdminGuardedPath("/api/admin/tenants")).toBe(true);
    expect(isAdminGuardedPath("/api/admin/auth/totp/enroll")).toBe(true);
    expect(isAdminGuardedPath("/api/admin/auth/totp/enroll/confirm")).toBe(true);
  });
  it("خارج /api/admin ليس نطاق المشرف", () => {
    expect(isAdminGuardedPath("/api/orders")).toBe(false);
    expect(isAdminGuardedPath("/health")).toBe(false);
  });
  it("لا يُخدَع بحالة الأحرف/الشرطة الزائدة (يبقى الإعفاء صحيحاً)", () => {
    expect(isAdminGuardedPath("/API/Admin/Auth/Totp/Verify/")).toBe(false);
    expect(isAdminGuardedPath("/api/admin/auth/login/")).toBe(false);
  });
});

describe("isEnrollWhitelistedPath", () => {
  it("يسمح بمساري التفعيل فقط (مع تطبيع الحالة/الشرطة)", () => {
    expect(isEnrollWhitelistedPath("/api/admin/auth/totp/enroll")).toBe(true);
    expect(isEnrollWhitelistedPath("/api/admin/auth/totp/enroll/confirm")).toBe(true);
    expect(isEnrollWhitelistedPath("/API/admin/auth/totp/enroll/")).toBe(true); // حالة + شرطة
  });
  it("يرفض أي مسار آخر", () => {
    expect(isEnrollWhitelistedPath("/api/admin/tenants")).toBe(false);
    expect(isEnrollWhitelistedPath("/api/admin/auth/totp/verify")).toBe(false);
  });
});

describe("AdminGuard.canActivate — بوّابة التفعيل", () => {
  it("يمرّر المسارات المعفاة بلا جلسة", async () => {
    const { ctx } = makeCtx("/api/admin/auth/login");
    expect(await guardWith(null).canActivate(ctx)).toBe(true);
  });

  it("يرفض مسار محروس بلا كوكي (401)", async () => {
    const { ctx } = makeCtx("/api/admin/tenants");
    await expect(guardWith(PENDING).canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("جلسة pendingEnroll على مسار غير التفعيل → 403", async () => {
    const { ctx } = makeCtx("/api/admin/tenants", { cookie: COOKIE });
    await expect(guardWith(PENDING).canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("جلسة pendingEnroll مسموحة بمساري التفعيل (وتُملأ req.adminSession)", async () => {
    for (const p of ["/api/admin/auth/totp/enroll", "/api/admin/auth/totp/enroll/confirm"]) {
      const { ctx, request } = makeCtx(p, { cookie: COOKIE });
      expect(await guardWith(PENDING).canActivate(ctx)).toBe(true);
      expect(request.adminSession).toEqual(PENDING);
    }
  });

  it("جلسة كاملة تصل كل المسارات", async () => {
    const { ctx } = makeCtx("/api/admin/tenants", { cookie: COOKIE });
    expect(await guardWith(FULL).canActivate(ctx)).toBe(true);
  });

  it("مسار الآلة (Bearer صحيح) يتخطّى البوّابة؛ خاطئ → 401", async () => {
    const token = "z".repeat(40);
    const ok = makeCtx("/api/admin/tenants", { authorization: `Bearer ${token}` });
    expect(await guardWith(null, { ADMIN_API_TOKEN: token }).canActivate(ok.ctx)).toBe(true);
    const bad = makeCtx("/api/admin/tenants", { authorization: "Bearer wrong" });
    await expect(guardWith(null, { ADMIN_API_TOKEN: token }).canActivate(bad.ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
