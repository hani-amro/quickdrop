import { Inject, Injectable } from "@nestjs/common";
import { DRIVER_ACTIVE_ORDER_STATUSES, drivers, users, withTenant, type DbHandle } from "@quickdrop/db";
import type { DriverStatus } from "@quickdrop/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";

// §10.1 — GET /api/drivers: قائمة السائقين لشاشة الإرسال (الإسناد اليدوي يحتاج:
// من online، بأي سعة D14، وكم عمر آخر نقطة موقع). نفس التخويل المؤقت
// (Bearer STAFF_API_TOKEN §10.2 لاحقاً) ونفس انضباط Zod (§11).

const listQuerySchema = z.object({ tenantSlug: slugSchema });

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
