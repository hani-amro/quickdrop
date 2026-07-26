import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Response } from "express";
import { ENV } from "../tokens.js";
import type { ApiEnv } from "../env.js";
import { parseCookies } from "../auth/cookie.js";
import { AdminAuthService } from "./admin-auth.service.js";
import type { RequestWithAdmin } from "./admin.guard.js";
import {
  ADMIN_SESSION_COOKIE,
  buildAdminSessionCookie,
  buildClearAdminSessionCookie,
} from "./admin-cookie.js";

// §10.2 + E1 — دخول المشرف المنفصل (نطاق /api/admin/auth، جلسات qd_admin مستقلة، TOTP إلزامي):
//   POST /api/admin/auth/login              {email,password} → {mfaRequired,challenge} أو Set-Cookie + {pendingEnroll}
//   POST /api/admin/auth/totp/verify        {challenge,token} → Set-Cookie qd_admin (جلسة كاملة)
//   POST /api/admin/auth/totp/enroll        (محروس) → {otpauthUrl}
//   POST /api/admin/auth/totp/enroll/confirm{token} (محروس) → {ok} + ترقية الجلسة
//   POST /api/admin/auth/logout / GET session
// login/logout/session/totp/verify معفاة من AdminGuard (مصادقة ذاتية)؛ enroll/confirm محروسان.
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
  @HttpCode(200) // دخول = جلسة/تحدّي، ليس إنشاء مورد REST
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ mfaRequired: true; challenge: string } | { pendingEnroll: boolean }> {
    const result = await this.admin.login(body);
    if (result.kind === "mfa_required") {
      return { mfaRequired: true, challenge: result.challenge }; // بلا كوكي — الجلسة بعد verify
    }
    res.setHeader("Set-Cookie", buildAdminSessionCookie(result.sessionId, this.secureCookies));
    return { pendingEnroll: result.pendingEnroll };
  }

  @Post("totp/verify")
  @HttpCode(200) // إكمال الدخول بـ TOTP → جلسة كاملة (مصادقة ذاتية، لا حراسة)
  async totpVerify(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const { sessionId } = await this.admin.verifyLoginTotp(body);
    res.setHeader("Set-Cookie", buildAdminSessionCookie(sessionId, this.secureCookies));
    return { ok: true };
  }

  @Post("totp/enroll")
  @HttpCode(200) // محروس (AdminGuard يملأ req.adminSession ويسمح بمساري التفعيل لجلسة pendingEnroll)
  async totpEnroll(@Req() req: RequestWithAdmin): Promise<{ otpauthUrl: string }> {
    const session = req.adminSession;
    if (!session) throw new UnauthorizedException(); // دفاع مزدوج (الحارس يضمنها)
    return this.admin.enrollTotp(session);
  }

  @Post("totp/enroll/confirm")
  @HttpCode(200) // محروس — يرقّي الجلسة الحالية بعد التأكيد
  async totpEnrollConfirm(@Req() req: RequestWithAdmin, @Body() body: unknown): Promise<{ ok: true }> {
    const session = req.adminSession;
    const sessionId = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
    if (!session || sessionId === undefined) throw new UnauthorizedException();
    return this.admin.confirmTotpEnroll(session, sessionId, body);
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
  async session(
    @Headers("cookie") cookie: string | undefined,
  ): Promise<{ adminId: string; email: string; pendingEnroll: boolean }> {
    const sessionId = parseCookies(cookie)[ADMIN_SESSION_COOKIE];
    const session = sessionId !== undefined ? await this.admin.getSession(sessionId) : null;
    if (session === null) {
      throw new UnauthorizedException(); // §11 — رسالة عامة
    }
    return { adminId: session.adminId, email: session.email, pendingEnroll: session.pendingEnroll === true };
  }
}
