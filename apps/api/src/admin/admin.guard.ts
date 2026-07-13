import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { secretsEqual } from "@quickdrop/shared";
import type { Request } from "express";
import { ADMIN_SESSION_VERIFIED_AUTHORIZATION } from "../common/admin-http.js";
import { parseCookies } from "../auth/cookie.js";
import { ENV } from "../tokens.js";
import type { ApiEnv } from "../env.js";
import { AdminAuthService, type AdminSession } from "./admin-auth.service.js";
import { ADMIN_SESSION_COOKIE } from "./admin-cookie.js";

// §10.2 — حارس عام (APP_GUARD) لكونسول المشرف: مسارات /api/admin/* تقبل **إمّا** جلسة
// qd_admin (Redis) **وإمّا** Bearer ADMIN_API_TOKEN (bootstrap/آلات). عند نجاح الجلسة
// يستبدل الحارس ترويسة Authorization بعلامة ADMIN_SESSION_VERIFIED فتقبلها طبقة الخدمة
// (assertAdminToken) — دفاع مزدوج، صفر تغيير بتواقيع الخدمات. منفصل تماماً عن SessionGuard
// للطاقم (نظام دخول مستقل §10.2). auth الذاتية (login/logout/session) معفاة أدناه.

/**
 * أي مسارات المشرف يحرسها هذا الحارس:
 * - خارج /api/admin/* = ليس نطاق المشرف (SessionGuard/بواباتها الخاصة).
 * - ثلاثي /api/admin/auth بالقائمة الحصرية = مصادقة ذاتية (login مفتوح؛ session/logout
 *   يقرآن الكوكي بنفسيهما) — أي مسار admin مستقبلي يُحرس افتراضياً.
 */
export function isAdminGuardedPath(path: string): boolean {
  if (!(path === "/api/admin" || path.startsWith("/api/admin/"))) return false;
  if (
    path === "/api/admin/auth/login" ||
    path === "/api/admin/auth/logout" ||
    path === "/api/admin/auth/session"
  ) {
    return false;
  }
  return true;
}

/** الطلب بعد نجاح جلسة المشرف يحمل هويتها — لِمَن يحتاج الفاعل (impersonate). */
export interface RequestWithAdmin extends Request {
  adminSession?: AdminSession;
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly adminAuth: AdminAuthService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithAdmin>();
    if (!isAdminGuardedPath(request.path)) return true;

    // (1) مسار الآلات/bootstrap: Bearer مقدَّم يُحسم هنا — صحيح يمرّ بترويسته كما هي
    // (الخدمة تعيد التحقق)، وخاطئ يُرفض فوراً بلا سقوط لمسار الجلسة (لا تخمين مزدوج).
    const bearer = request.headers.authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
    if (bearer !== undefined) {
      if (this.env.ADMIN_API_TOKEN !== undefined && secretsEqual(bearer, this.env.ADMIN_API_TOKEN)) {
        return true;
      }
      throw new UnauthorizedException(); // §11 — رسالة عامة
    }

    // (2) مسار المتصفح: جلسة qd_admin من Redis
    const sessionId = parseCookies(request.headers.cookie)[ADMIN_SESSION_COOKIE];
    if (sessionId === undefined) {
      throw new UnauthorizedException();
    }
    const session = await this.adminAuth.getSession(sessionId);
    if (session === null) {
      throw new UnauthorizedException();
    }

    request.adminSession = session;
    request.headers.authorization = ADMIN_SESSION_VERIFIED_AUTHORIZATION; // طبقة الخدمة تقبلها
    return true;
  }
}
