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
export function isSessionGuardedPath(rawPath: string): boolean {
  // §11 — Express يوجّه case-insensitive ويقبل شرطة زائدة: نطبّع الحالة والشرطة الأخيرة
  // قبل أي مقارنة (وإلا /API/... أو /api/.../ يتخطّى الحارس أو يقع بتصنيف خاطئ).
  const path = rawPath.toLowerCase().replace(/\/+$/, "") || "/";
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
  // §10.3 — الـ Mini App نطاق زبون ذاتي المصادقة (initData ثم توكن Bearer مجهول)،
  // ليس نطاق الطاقم — يحرسه MiniappService بنفسه. حرسه بجلسة الطاقم كان سيمنعه كلياً.
  if (path === "/api/miniapp" || path.startsWith("/api/miniapp/")) return false;
  return true;
}

/**
 * §11 أمان حرج — كل قيَم tenantSlug المرسلة (**جسم وواستعلام معاً**). سابقاً كنا نقرأ
 * الجسم ثم نسقط للاستعلام: مهاجم يضع slug نفسه بالجسم (يمرّر الحارس) وslug الضحية
 * بالاستعلام (تقرؤه خدمات GET) → تسرّب قراءة كامل بين المستأجرين. لذلك نُرجع **كل**
 * المصادر ونرفض إن اختلف أيٌّ منها عن الجلسة (والحمولة تُفحَص حتى على GET لأن body-parser
 * يحلّلها لأي طريقة تحمل content-type: application/json).
 */
export function readRequestedTenantSlugs(body: unknown, query: Record<string, unknown>): string[] {
  const slugs: string[] = [];
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const fromBody = (body as Record<string, unknown>)["tenantSlug"];
    if (typeof fromBody === "string") slugs.push(fromBody);
  }
  const fromQuery = query["tenantSlug"];
  if (typeof fromQuery === "string") slugs.push(fromQuery);
  return slugs;
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

    // §10.2 — نطاق الجلسة مستأجر واحد: **كل** tenantSlug مرسل (جسم أو استعلام) يجب أن
    // يطابق جلسة المستخدم. فحص المصدرين معاً (لا الأول فقط) يسدّ تسرّب القراءة بين
    // المستأجرين عبر جسم-خادع/استعلام-ضحية على مسارات GET (ثغرة حرجة §11).
    const requestedSlugs = readRequestedTenantSlugs(request.body, request.query);
    if (requestedSlugs.some((slug) => slug !== session.tenantSlug)) {
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
