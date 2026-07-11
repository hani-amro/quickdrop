import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { secretsEqual } from "@quickdrop/shared";

// §10.2/§14 — مصادقة كونسول المشرف: نظام دخول منفصل تماماً عن الـ staff. مؤقتاً
// Bearer = ADMIN_API_TOKEN من env؛ دخول المشرف الحقيقي (admin_users + جلسات §10.2)
// لاحقاً. الفصل مقصود: توكن الموظف لا يفتح /api/admin والعكس. (parseOr400/uuidSchema
// أدوات Zod عامة تُعاد من common/staff-http — التخويل وحده منفصل هنا.)

/**
 * غياب ADMIN_API_TOKEN من env = 503 (المسارات معطَّلة بصوت عالٍ، لا فتح مفتوح).
 * §4.1: مقارنة ثابتة الزمن على الأسرار (لا ===)؛ رسالة عامة (§11).
 */
export function assertAdminToken(configured: string | undefined, authorization: string | undefined): void {
  if (configured === undefined) {
    throw new ServiceUnavailableException("admin API is not configured");
  }
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
  if (bearer === undefined || !secretsEqual(bearer, configured)) {
    throw new UnauthorizedException();
  }
}
