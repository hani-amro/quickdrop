import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DRIVER_ACTIVE_ORDER_STATUSES, createDriver, drivers, users, withTenant, type DbHandle } from "@quickdrop/db";
import { VEHICLES, type DriverStatus, type Vehicle } from "@quickdrop/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";
import { normalizePhoneE164 } from "../orders/orders.util.js";

// §10.1 — GET /api/drivers: قائمة السائقين لشاشة الإرسال (الإسناد اليدوي يحتاج:
// من online، بأي سعة D14، وكم عمر آخر نقطة موقع). نفس التخويل المؤقت
// (Bearer STAFF_API_TOKEN §10.2 لاحقاً) ونفس انضباط Zod (§11).

const listQuerySchema = z.object({ tenantSlug: slugSchema });

// §14 — إنشاء/تفعيل سائق: userId (حساب موجود) أو phone (يُنشأ مستخدم دور driver) —
// أحدهما حصراً. المركبة إلزامية (VEHICLES). التطبيع E.164 نفس شاشة الطلب اليدوي (D15).
const phoneSchema = z
  .string()
  .min(5)
  .max(32)
  .transform((raw, ctx) => {
    const normalized = normalizePhoneE164(raw);
    if (normalized === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid E.164 phone" });
      return z.NEVER;
    }
    return normalized;
  });

const createBodySchema = z
  .object({
    tenantSlug: slugSchema,
    vehicle: z.enum(VEHICLES),
    userId: uuidSchema.optional(),
    phone: phoneSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  // XOR: تماماً أحدهما — userId أو phone (لا كلاهما ولا لا شيء)
  .refine((d) => (d.userId === undefined) !== (d.phone === undefined), {
    message: "exactly one of userId or phone is required",
  });

export interface CreateDriverResponse {
  driver: { id: string; vehicle: Vehicle; status: DriverStatus };
}

export interface DriverSummary {
  driverId: string;
  name: string | null;
  phone: string | null;
  status: DriverStatus;
  activeOrders: number; // D14: الانشغال يُشتق من العدّ مقابل max_concurrent_orders — لا حالة busy
  maxConcurrentOrders: number;
  lastPointAt: string | null; // §10.1: "آخر نقطة قبل X" — الواجهة تعرض العمر لا الإحداثيات
}

export interface ListDriversResponse {
  drivers: DriverSummary[];
}

@Injectable()
export class DriversService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  // §14 — إنشاء/تفعيل سائق مع فرض حد الباقة. القرار كله (قفل المستأجر، فحص الحد،
  // الإدراج) داخل ترانزاكشن createDriver بطبقة القاعدة؛ هنا فقط ترجمة النتيجة إلى HTTP.
  async create(authorization: string | undefined, body: unknown): Promise<CreateDriverResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(createBodySchema, body, "drivers_create");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const result = await createDriver(this.handle.db, tenant.id, {
      vehicle: input.vehicle,
      // exactOptionalPropertyTypes: لا نمرّر undefined صريحاً
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
    });

    switch (result.outcome) {
      case "created":
      case "already_driver": {
        // already_driver = مُفعَّل أصلاً لنفس المستخدم: نجاح idempotent (§16.7)
        console.log(
          JSON.stringify({
            action: "driver_created",
            tenant_id: tenant.id,
            driver_id: result.driver.id,
            outcome: result.outcome,
          }),
        );
        return { driver: result.driver };
      }
      case "plan_limit":
        // §14 — رسالة ترقية لا فشل صامت. التفاصيل باللوغ فقط (§11: رسالة عامة للعميل).
        console.warn(
          JSON.stringify({
            action: "driver_create_rejected",
            tenant_id: tenant.id,
            reason: "plan_limit",
            plan: result.plan,
            limit: Number.isFinite(result.limit) ? result.limit : "inf",
            current: result.current,
          }),
        );
        throw new ConflictException("تجاوزت حد باقتك، رقِّ الباقة");
      case "user_not_found":
        throw new NotFoundException("not found"); // معرّف مدخل مستخدم (§11)
    }
  }

  // §16.10 — لا N+1: القائمة استعلام واحد (join users + subquery مرتبط واحد للعدّ).
  async list(authorization: string | undefined, query: unknown): Promise<ListDriversResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(listQuerySchema, query, "drivers_list");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    // D14 — نفس تعريف "طلب نشط" حرفياً من محرك الإسناد (assigned..arrived)
    const activeStatusesIn = sql.join(
      DRIVER_ACTIVE_ORDER_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    );
    const activeOrdersExpr = sql<number>`(
      SELECT count(*) FROM orders ao
      WHERE ao.tenant_id = ${drivers.tenantId}
        AND ao.driver_id = ${drivers.id}
        AND ao.deleted_at IS NULL
        AND ao.status IN (${activeStatusesIn})
    )`.mapWith(Number);

    const rows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({
          driverId: drivers.id,
          name: users.firstName,
          phone: users.phoneE164,
          status: drivers.status,
          activeOrders: activeOrdersExpr,
          maxConcurrentOrders: drivers.maxConcurrentOrders,
          lastPointAt: drivers.lastPointAt,
        })
        .from(drivers)
        .innerJoin(users, and(eq(users.tenantId, drivers.tenantId), eq(users.id, drivers.userId)))
        .where(eq(drivers.tenantId, tenant.id)) // فوق RLS — يقود فهرس (tenant_id, status)
        // online أولاً (الموزّع يمسح بعينه §10.1) ثم الأقدم انضماماً — ترتيب حتمي
        .orderBy(desc(sql`(${drivers.status} = 'online')`), asc(drivers.createdAt))
        .limit(100), // §10.1: ترقيم من الخادم — سقف v1؛ سائقو مكتب واحد عشرات كحد أقصى (§14)
    );

    return {
      drivers: rows.map((r) => ({
        driverId: r.driverId,
        name: r.name,
        phone: r.phone,
        status: r.status,
        activeOrders: r.activeOrders,
        maxConcurrentOrders: r.maxConcurrentOrders,
        // لا مال بهذه القائمة (bigint→string لا ينطبق)؛ التواريخ ISO 8601 (D6)
        lastPointAt: r.lastPointAt?.toISOString() ?? null,
      })),
    };
  }
}
