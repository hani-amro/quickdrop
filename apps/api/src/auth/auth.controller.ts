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
import { AuthService } from "./auth.service.js";
import { buildClearSessionCookie, buildSessionCookie, parseCookies, SESSION_COOKIE } from "./cookie.js";

// §10.2 — مصادقة الطاقم:
//   POST /api/auth/login  {tenantSlug, email, password} → Set-Cookie qd_session + {role}
//   POST /api/auth/logout → حذف الجلسة من Redis + محو الكوكي (idempotent)
//   GET  /api/auth/me     → هوية الجلسة الحالية (الداشبورد يبني عليها الواجهة)
// الثلاثة معفاة من SessionGuard بالقائمة الحصرية (session.guard.ts) — مصادقة ذاتية.
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
  ): Promise<{ role: StaffRole }> {
    const { sessionId, role } = await this.auth.login(body);
    res.setHeader("Set-Cookie", buildSessionCookie(sessionId, this.secureCookies));
    return { role };
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
  ): Promise<{ staffId: string; role: StaffRole; tenantSlug: string }> {
    const sessionId = parseCookies(cookie)[SESSION_COOKIE];
    const session = sessionId !== undefined ? await this.auth.getSession(sessionId) : null;
    if (session === null) {
      throw new UnauthorizedException(); // §11 — رسالة عامة
    }
    return { staffId: session.staffId, role: session.role, tenantSlug: session.tenantSlug };
  }
}
