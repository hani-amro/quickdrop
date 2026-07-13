import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { StaffRole } from "@quickdrop/shared";
import type { Response } from "express";
import { ENV } from "../tokens.js";
import type { ApiEnv } from "../env.js";
import { AuthService, type StaffSession } from "./auth.service.js";
import { buildClearSessionCookie, buildSessionCookie, parseCookies, SESSION_COOKIE } from "./cookie.js";

// §10.2 — مصادقة الطاقم:
//   POST /api/auth/login  {tenantSlug, email, password}
//        → دور مُلزَم بـ TOTP وله سرّ: {mfaRequired:true, challenge} (بلا كوكي)
//        → غير ذلك: Set-Cookie qd_session + {role, mustEnrollTotp}
//   POST /api/auth/totp/verify {challenge, token} → يُكمل الدخول: Set-Cookie + {role}
//   POST /api/auth/totp/enroll (بجلسة) → {otpauthUrl} (يولّد سرّاً معلّقاً)
//   POST /api/auth/totp/enroll/confirm {token} (بجلسة) → يثبّت السرّ + {ok}
//   POST /api/auth/logout → حذف الجلسة من Redis + محو الكوكي (idempotent)
//   GET  /api/auth/me     → هوية الجلسة الحالية (الداشبورد يبني عليها الواجهة)
// login/verify/logout/me معفاة من SessionGuard (مصادقة ذاتية)؛ enroll/confirm محروسة.
// معرّف الجلسة لا يُعاد بالجسم أبداً — بالكوكي HttpOnly حصراً (§11).
@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  // Secure بالإنتاج حصراً — التطوير http محلي والكوكي Secure لن يُخزَّن أصلاً
  private get secureCookies(): boolean {
    return this.env.NODE_ENV === "production";
  }

  @Post("login")
  @HttpCode(200) // دخول ناجح = جلسة، ليس إنشاء مورد REST
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ role: StaffRole; mustEnrollTotp: boolean } | { mfaRequired: true; challenge: string }> {
    const result = await this.auth.login(body);
    if (result.kind === "mfa_required") {
      // خطوة ثانية مطلوبة (TOTP) — لا كوكي جلسة بعد؛ الواجهة تطلب الرمز بالتحدّي
      return { mfaRequired: true, challenge: result.challenge };
    }
    res.setHeader("Set-Cookie", buildSessionCookie(result.sessionId, this.secureCookies));
    return { role: result.role, mustEnrollTotp: result.mustEnrollTotp };
  }

  @Post("totp/verify")
  @HttpCode(200) // إكمال الدخول = جلسة، ليس إنشاء مورد
  async totpVerify(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ role: StaffRole }> {
    const { sessionId, role } = await this.auth.verifyLoginTotp(body);
    res.setHeader("Set-Cookie", buildSessionCookie(sessionId, this.secureCookies));
    return { role };
  }

  @Post("totp/enroll")
  @HttpCode(200) // يولّد سرّاً معلّقاً (لا يثبّته) — ليس إنشاء مورد دائم
  async totpEnroll(@Headers("cookie") cookie: string | undefined): Promise<{ otpauthUrl: string }> {
    const session = await this.requireSession(cookie);
    return this.auth.enrollTotp(session);
  }

  @Post("totp/enroll/confirm")
  @HttpCode(200)
  async totpEnrollConfirm(
    @Headers("cookie") cookie: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const session = await this.requireSession(cookie);
    return this.auth.confirmTotpEnroll(session, body);
  }

  @Post("logout")
  @HttpCode(200)
  async logout(
    @Headers("cookie") cookie: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const sessionId = parseCookies(cookie)[SESSION_COOKIE];
    if (sessionId !== undefined) {
      await this.auth.logout(sessionId);
    }
    // محو الكوكي دائماً — خروج بلا جلسة صالحة ليس خطأً (idempotent)
    res.setHeader("Set-Cookie", buildClearSessionCookie(this.secureCookies));
    return { ok: true };
  }

  @Get("me")
  async me(
    @Headers("cookie") cookie: string | undefined,
  ): Promise<{ staffId: string; role: StaffRole; tenantSlug: string; readonly?: true }> {
    const session = await this.requireSession(cookie);
    return {
      staffId: session.staffId,
      role: session.role,
      tenantSlug: session.tenantSlug,
      // §10.2 — علم الانتحال يصل الداشبورد كي يرسم الشريط البرتقالي "تشاهد كمشرف"
      ...(session.readonly === true ? { readonly: true as const } : {}),
    };
  }

  /** §10.2 — جلسة صالحة من الكوكي أو 401 عام؛ enroll/confirm/me تشترك فيها. */
  private async requireSession(cookie: string | undefined): Promise<StaffSession> {
    const sessionId = parseCookies(cookie)[SESSION_COOKIE];
    const session = sessionId !== undefined ? await this.auth.getSession(sessionId) : null;
    if (session === null) {
      throw new UnauthorizedException(); // §11 — رسالة عامة
    }
    return session;
  }
}
