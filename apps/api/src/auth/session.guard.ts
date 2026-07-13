import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { secretsEqual } from "@quickdrop/shared";
import type { Request } from "express";
import { SESSION_VERIFIED_AUTHORIZATION } from "../common/staff-http.js";
import { ENV } from "../tokens.js";
import type { ApiEnv } from "../env.js";
import { AuthService, type StaffSession } from "./auth.service.js";
import { parseCookies, SESSION_COOKIE } from "./cookie.js";

// §10.2 — حارس عام (APP_GUARD): مسارات الطاقم /api/* تقبل **إمّا** جلسة cookie
// صالحة (Redis) **وإمّا** Bearer STAFF_API_TOKEN (يبقى للآلات وللداشبورد الحالي
// عبر الـ proxy الخادمي). عند نجاح الجلسة يستبدل الحارس ترويسة Authorization
// بعلامة SESSION_VERIFIED_AUTHORIZATION فتقبلها طبقة الخدمات (assertStaffToken) —
// صفر تغيير بتواقيع الخدمات، والطبقتان تبقيان دفاعاً مزدوجاً (§11).

/**
 * أي المسارات يحرسها هذا الحارس — نقية للاختبار:
 * - خارج /api/* (health، public/track، tg webhook) = بواباتها الخاصة، ليست نطاق الطاقم.
 * - /api/admin/* = نطاق مشرف منفصل تماماً (§10.2) — assertAdminToken بالخدمة.
 * - مسارات /api/auth ذاتية المصادقة بالقائمة الحصرية: login/totp/verify (خطوتا الدخول)
 *   وme/logout (تقرأ الكوكي بنفسها). enroll/confirm خارج القائمة → محروسة (تتطلب جلسة).
 *   أي مسار auth مستقبلي يُحرس افتراضياً، لا فتح مفتوح.
 */
export function isSessionGuardedPath(path: string): boolean {
  if (!path.startsWith("/api/")) return false;
  if (
    path === "/api/auth/login" ||
    path === "/api/auth/totp/verify" ||
    path === "/api/auth/logout" ||
    path === "/api/auth/me"
  ) {
    return false;
  }
  if (path === "/api/admin" || path.startsWith("/api/admin/")) return false;
  return true;
}

/** tenantSlug المرسل (جسم أو استعلام) إن وُجد — لمقارنته بنطاق الجلسة. */
export function readRequestedTenantSlug(body: unknown, query: Record<string, unknown>): string | undefined {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const fromBody = (body as Record<string, unknown>)["tenantSlug"];
    if (typeof fromBody === "string") return fromBody;
  }
  const fromQuery = query["tenantSlug"];
  return typeof fromQuery === "string" ? fromQuery : undefined;
}

/** الطلب بعد نجاح الجلسة يحمل هويتها — للخدمات التي تحتاج فاعلاً (actor) لاحقاً. */
export interface RequestWithSession extends Request {
  staffSession?: StaffSession;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    if (!isSessionGuardedPath(request.path)) return true;

    // (1) مسار الآلات: Bearer مقدَّم يُحسم هنا — صحيح يمرّ بترويسته كما هي (الخدمات
    // تعيد التحقق)، وخاطئ يُرفض فوراً بلا سقوط لمسار الجلسة (لا تخمين مزدوج).
    const authorization = request.headers.authorization;
    const bearer = authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
    if (bearer !== undefined) {
      if (this.env.STAFF_API_TOKEN !== undefined && secretsEqual(bearer, this.env.STAFF_API_TOKEN)) {
        return true;
      }
      throw new UnauthorizedException(); // §11 — رسالة عامة؛ لا نفرّق "غير مهيأ" عن "خاطئ"
    }

    // (2) مسار المتصفح: جلسة cookie من Redis
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (sessionId === undefined) {
      throw new UnauthorizedException();
    }
    const session = await this.auth.getSession(sessionId);
    if (session === null) {
      throw new UnauthorizedException();
    }

    // §10.2 — "الدخول كمكتب": جلسة انتحال مقيّدة القراءة تسمح بـ GET/HEAD فقط؛ أي
    // فعل كتابة (POST/PATCH/DELETE/…) يُرفض 403 "جلسة مشاهدة" قبل أي عمل بالخدمة.
    if (session.readonly === true && request.method !== "GET" && request.method !== "HEAD") {
      console.warn(
        JSON.stringify({
          action: "session_guard",
          outcome: "readonly_write_blocked",
          tenant_id: session.tenantId,
          actor: session.adminId ?? session.staffId,
          method: request.method,
        }),
      );
      throw new ForbiddenException("جلسة مشاهدة");
    }

    // §10.2 — نطاق الجلسة مستأجر واحد: tenantSlug المرسل (إن وُجد) يجب أن يطابق
    // جلسة المستخدم — الأبسط المنصوص: تحقق التطابق بدل إعادة كتابة المدخلات.
    const requested = readRequestedTenantSlug(request.body, request.query);
    if (requested !== undefined && requested !== session.tenantSlug) {
      // §13 لوغ منظّم — المعرّفات فقط؛ الرد عام (§11): لا نكشف أن الـ slug الآخر موجود
      console.warn(
        JSON.stringify({ action: "session_guard", outcome: "tenant_mismatch", tenant_id: session.tenantId, actor: session.staffId }),
      );
      throw new UnauthorizedException();
    }

    request.staffSession = session;
    request.headers.authorization = SESSION_VERIFIED_AUTHORIZATION; // طبقة الخدمات تقبلها
    return true;
  }
}
