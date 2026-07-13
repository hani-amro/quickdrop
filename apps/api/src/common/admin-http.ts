import { randomBytes } from "node:crypto";
import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { secretsEqual } from "@quickdrop/shared";

// §10.2/§14 — مصادقة كونسول المشرف: نظام دخول منفصل تماماً عن الـ staff. يقبل الآن
// **إمّا** جلسة admin cookie تحقق منها AdminGuard (العلامة أدناه) **وإمّا** Bearer
// ADMIN_API_TOKEN من env (يبقى للـ bootstrap وللآلات). الفصل مقصود: توكن الموظف لا
// يفتح /api/admin والعكس. (parseOr400/uuidSchema أدوات Zod عامة تُعاد من common/staff-http.)

/**
 * §10.2 — علامة "جلسة مشرف موثَّقة" لكل إقلاع عملية: AdminGuard يستبدل بها ترويسة
 * Authorization بعد التحقق من جلسة qd_admin (Redis)، فتقبلها هذه الدالة كبديل مكافئ
 * للـ Bearer. عشوائية 256-bit لا تغادر العملية — من يرسلها من الخارج يرفضه الحارس قبل
 * الوصول، وتبقى الطبقتان (حارس + خدمة) دفاعاً مزدوجاً حتى لو أُسقط الحارس عن مسار سهواً.
 */
export const ADMIN_SESSION_VERIFIED_AUTHORIZATION = `QdAdminSessionVerified ${randomBytes(32).toString("hex")}`;

/**
 * §10.2 — تخويل طبقة الخدمة: العلامة أعلاه (جلسة مشرف) أولاً، وإلا Bearer = ADMIN_API_TOKEN.
 * فحص العلامة قبل فحص التهيئة كي تعمل جلسات الكوكي حتى لو غاب ADMIN_API_TOKEN من env.
 * غياب التوكن **ووجود** Bearer غير مطابق (أو لا علامة) = 503/401. §4.1: مقارنة ثابتة الزمن.
 */
export function assertAdminToken(configured: string | undefined, authorization: string | undefined): void {
  if (authorization !== undefined && secretsEqual(authorization, ADMIN_SESSION_VERIFIED_AUTHORIZATION)) {
    return; // جلسة §10.2 موثَّقة من AdminGuard
  }
  if (configured === undefined) {
    throw new ServiceUnavailableException("admin API is not configured");
  }
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
  if (bearer === undefined || !secretsEqual(bearer, configured)) {
    throw new UnauthorizedException();
  }
}
