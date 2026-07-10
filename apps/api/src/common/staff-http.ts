import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { tenants, type Db } from "@quickdrop/db";
import { secretsEqual } from "@quickdrop/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";

// أدوات مشتركة لمسارات الـ staff (orders + drivers) — مصدر واحد للتخويل المؤقت
// (Bearer STAFF_API_TOKEN — §10.2 لاحقاً)، وتحقق Zod (§11)، وحلّ المستأجر بالـ slug.

// نفس قيد provision-tenant — يُستخدم بكل مداخل tenantSlug
export const slugSchema = z.string().regex(/^[a-z0-9-]{2,32}$/);

// معرّفات المسار (:id) و driverId — UUID حصراً؛ غير ذلك 400 عامة (§11)
export const uuidSchema = z.string().uuid();

/**
 * أمان مؤقت: Authorization: Bearer = STAFF_API_TOKEN من env — staff auth الحقيقي
 * (جلسات + argon2id §10.2) يُبنى لاحقاً؛ غياب التوكن من env = 503، لا فتح مفتوح.
 * §4.1: مقارنة ثابتة الزمن — لا === على أسرار؛ ورسالة عامة (§11).
 */
export function assertStaffToken(configured: string | undefined, authorization: string | undefined): void {
  if (configured === undefined) {
    throw new ServiceUnavailableException("staff API is not configured");
  }
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
  if (bearer === undefined || !secretsEqual(bearer, configured)) {
    throw new UnauthorizedException();
  }
}

/** §11 — الرفض 400 برسالة عامة؛ التفاصيل (مسارات الحقول بلا قيم — لا PII) باللوغ فقط. */
export function parseOr400<S extends z.ZodTypeAny>(schema: S, data: unknown, action: string): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        action,
        outcome: "validation_failed",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
      }),
    );
    throw new BadRequestException("invalid request");
  }
  return parsed.data;
}

export interface ActiveTenant {
  id: string;
  etaCorrectionBp: number; // §7 — معامل تصحيح الـ ETA لكل مستأجر (لقطة promised_at)
}

/**
 * استثناء RLS مسمّى (§2.4): البحث بالـ slug قبل معرفة المستأجر — نفس نمط بوابة الـ webhook.
 * §11/§14: رسالة عامة — لا نميّز "غير موجود" عن "موقوف" للخارج.
 */
export async function resolveActiveTenant(db: Db, slug: string): Promise<ActiveTenant> {
  const rows = await db
    .select({ id: tenants.id, status: tenants.status, etaCorrectionBp: tenants.etaCorrectionBp })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  const tenant = rows[0];
  if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
    throw new NotFoundException("not found");
  }
  return { id: tenant.id, etaCorrectionBp: tenant.etaCorrectionBp };
}
