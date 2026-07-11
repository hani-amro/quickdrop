import { Inject, Injectable } from "@nestjs/common";
import { getDashboardStats, type DashboardStats, type DbHandle } from "@quickdrop/db";
import type { OrderStatus } from "@quickdrop/shared";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";

// §13/§10 — GET /api/analytics: إحصاءات لوحة المكتب (KPI + سلسلة يومية). كل الحساب
// المجمّع بطبقة db (analytics.ts §16.10 — لا N+1)؛ هنا التخويل والتحقق وتحويل المال
// bigint→string عند حافة الـ JSON (D5). "اليوم"/التجميع بمنطقة المستأجر (tenantDay §16.8).

const querySchema = z.object({
  tenantSlug: slugSchema,
  // query string فارغة = غير مُرسلة؛ الحدّ الأقصى 90 يوماً (نفس قصّ طبقة db)
  days: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.coerce.number().int().positive().max(90).optional(),
  ),
});

export interface StatusCountView {
  status: OrderStatus;
  count: number;
}

export interface DailyCountView {
  day: string;
  count: number;
}

export interface ZoneCountView {
  zoneId: string;
  name: string;
  count: number;
}

export interface AnalyticsResponse {
  window: { sinceDays: number; timezone: string };
  ordersToday: number;
  ordersWindow: number;
  statusCounts: StatusCountView[];
  avgAssignSeconds: number | null;
  avgDeliverySeconds: number | null;
  revenue: string; // D5: bigint→string عند الحافة
  deliveredCount: number;
  activeDrivers: number;
  daily: DailyCountView[];
  topZones: ZoneCountView[];
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async stats(authorization: string | undefined, query: unknown): Promise<AnalyticsResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(querySchema, query, "analytics_stats");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const stats: DashboardStats = await getDashboardStats(this.handle.db, tenant.id, {
      timezone: tenant.timezone, // الفخ 8 — التقويم بمنطقة المستأجر لا الخادم
      ...(input.days !== undefined ? { sinceDays: input.days } : {}),
    });

    return {
      window: stats.window,
      ordersToday: stats.ordersToday,
      ordersWindow: stats.ordersWindow,
      statusCounts: stats.statusCounts,
      avgAssignSeconds: stats.avgAssignSeconds,
      avgDeliverySeconds: stats.avgDeliverySeconds,
      revenue: String(stats.revenue), // D5: bigint→string
      deliveredCount: stats.deliveredCount,
      activeDrivers: stats.activeDrivers,
      daily: stats.daily,
      topZones: stats.topZones,
    };
  }
}
