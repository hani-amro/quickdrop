import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Res, UnauthorizedException } from "@nestjs/common";
import type { Response } from "express";
import { ENV } from "../tokens.js";
import type { ApiEnv } from "../env.js";
import { parseCookies } from "../auth/cookie.js";
import { AdminAuthService } from "./admin-auth.service.js";
import {
  ADMIN_SESSION_COOKIE,
  buildAdminSessionCookie,
  buildClearAdminSessionCookie,
} from "./admin-cookie.js";

// §10.2 — دخول المشرف المنفصل (نطاق /api/admin/auth، جلسات qd_admin مستقلة تماماً):
//   POST /api/admin/auth/login   {email, password} → Set-Cookie qd_admin + {ok}
//   POST /api/admin/auth/logout  → حذف الجلسة من Redis + محو الكوكي (idempotent)
//   GET  /api/admin/auth/session → هوية المشرف الحالية (للكونسول)
// الثلاثة معفاة من AdminGuard (مصادقة ذاتية)؛ معرّف الجلسة بالكوكي HttpOnly حصراً (§11).
@Controller("api/admin/auth")
export class AdminAuthController {
  constructor(
    private readonly admin: AdminAuthService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  private get secureCookies(): boolean {
    return this.env.NODE_ENV === "production";
  }

  @Post("login")
  @HttpCode(200) // دخول ناجح = جلسة، ليس إنشاء مورد REST
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const { sessionId } = await this.admin.login(body);
    res.setHeader("Set-Cookie", buildAdminSessionCookie(sessionId, this.secureCookies));
    return { ok: true };
  }

  @Post("logout")
  @HttpCode(200)
  async logout(
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const sessionId = parseCookies(cookie)[ADMIN_SESSION_COOKIE];
    if (sessionId !== undefined) {
      await this.admin.logout(sessionId);
    }
    res.setHeader("Set-Cookie", buildClearAdminSessionCookie(this.secureCookies));
    return { ok: true };
  }

  @Get("session")
  async session(@Headers("cookie") cookie: string | undefined): Promise<{ adminId: string; email: string }> {
    const sessionId = parseCookies(cookie)[ADMIN_SESSION_COOKIE];
    const session = sessionId !== undefined ? await this.admin.getSession(sessionId) : null;
    if (session === null) {
      throw new UnauthorizedException(); // §11 — رسالة عامة
    }
    return { adminId: session.adminId, email: session.email };
  }
}
