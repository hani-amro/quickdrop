import { ForbiddenException, Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
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
export function isAdminGuardedPath(rawPath: string): boolean {
  // §11 — Express يوجّه case-insensitive ويقبل شرطة زائدة؛ لو قارنّا بحساسية الأحرف أو
  // دون إزالة الـ'/' الأخيرة لتخطّى مهاجمٌ الحارس بمسار مختلط الأحرف (/API/admin/...)
  // أو بشرطة زائدة ووصل للمعالج بلا حراسة. نطبّع الحالة والشرطة ونقارن الكل به.
  const path = rawPath.toLowerCase().replace(/\/+$/, "") || "/";
  if (!(path === "/api/admin" || path.startsWith("/api/admin/"))) return false;
  if (
    path === "/api/admin/auth/login" ||
    path === "/api/admin/auth/logout" ||
    path === "/api/admin/auth/session" ||
    path === "/api/admin/auth/totp/verify" // E1 — إكمال دخول mid-login (بلا جلسة بعد)
  ) {
    return false;
  }
  return true;
}

/**
 * E1 — المسارات المسموحة لجلسة **مقيّدة بالتفعيل** (pendingEnroll). enroll/confirm يبقيان
 * محروسَين (كي يحمّل الحارس الجلسة) لكن يُسمح بهما هنا؛ أي مسار admin آخر → 403 حتى التفعيل.
 * نفس تطبيع isAdminGuardedPath حرفياً (حالة + شرطة أخيرة) — التطابق حمّال أمنياً.
 */
export function isEnrollWhitelistedPath(rawPath: string): boolean {
  const path = rawPath.toLowerCase().replace(/\/+$/, "") || "/";
  return path === "/api/admin/auth/totp/enroll" || path === "/api/admin/auth/totp/enroll/confirm";
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
    // E1 — بوّابة التفعيل: جلسة pendingEnroll لا تصل إلا مسارات التفعيل (403 على ما عداها).
    // مسار Bearer رجع أعلاه (لا جلسة → لا بوّابة)؛ login/logout/session/totp/verify معفاة أصلاً.
    if (session.pendingEnroll === true && !isEnrollWhitelistedPath(request.path)) {
      throw new ForbiddenException(); // §11 — يجب تفعيل 2FA أولاً
    }
    request.headers.authorization = ADMIN_SESSION_VERIFIED_AUTHORIZATION; // طبقة الخدمة تقبلها
    return true;
  }
}
