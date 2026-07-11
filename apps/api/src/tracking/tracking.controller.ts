import { Controller, Get, Header, Inject, NotFoundException, Param } from "@nestjs/common";
import {
  DRIVER_ACTIVE_ORDER_STATUSES,
  drivers,
  orders,
  tenants,
  trackingTokens,
  withTenant,
  type DbHandle,
} from "@quickdrop/db";
import type { OrderStatus } from "@quickdrop/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../app.module.js";

// §7 — رابط التتبع العام: GET /public/track/:token **بلا auth** — الصفحة العامة /t/{token}
// (زائر مجهول) تستهلكه حصراً ولا API آخر لها. القاموس الأمني:
// - tracking_tokens استثناء RLS مسمّى (§2.3): البحث بالتوكن وحده بلا withTenant.
// - غائب/مشوّه/منتهٍ/مستأجر معلّق → 404 عام موحّد (§11/§14: لا تمييز للخارج).
// - الرد حالة + كود + نقطتان فقط — **لا أسماء ولا أرقام** (§7).
// - الفخ 19: نعيد عمر آخر نقطة (lastPointAgeS) — الواجهة تعرض "آخر موقع معروف قبل X"
//   بدل نقطة قديمة تتنكر بهيئة موقع حي.

// التوكن 16 بايت hex (128-bit — §7): أي شكل آخر = غير موجود، لا 400 تفصيلية (§11)
const tokenSchema = z.string().regex(/^[0-9a-f]{32}$/);

// D14 — «نشط» = assigned..arrived: خارجها لا موقع سائق بالرد (خصوصية السائق §7)
const TRACKED_ACTIVE_STATUSES: readonly OrderStatus[] = DRIVER_ACTIVE_ORDER_STATUSES;

export interface PublicTrackingResponse {
  status: OrderStatus;
  publicCode: string;
  dropoff: { lat: number; lng: number };
  /** آخر نقطة سائق إن كان الطلب نشطاً وله سائق أرسل موقعاً — وإلا null. */
  driver: { lat: number; lng: number; lastPointAgeS: number } | null;
}

@Controller("public/track")
export class TrackingController {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  // Access-Control-Allow-Origin: * — صفحة /t/{token} تجلب مباشرة من المتصفح (لا proxy)؛
  // GET بلا ترويسات مخصصة = simple request فلا preflight، والرد عام أصلاً بلا أسرار.
  @Get(":token")
  @Header("cache-control", "no-store")
  @Header("access-control-allow-origin", "*")
  async track(@Param("token") token: string): Promise<PublicTrackingResponse> {
    const parsed = tokenSchema.safeParse(token);
    if (!parsed.success) {
      throw new NotFoundException("not found"); // §11: رسالة عامة — التوكن لا يظهر بأي لوغ
    }

    // §2.3 — استثناء RLS مسمّى: زائر مجهول بلا tenant، البحث بالتوكن وحده (قراءة مباشرة)
    const tokenRows = await this.handle.db
      .select({
        tenantId: trackingTokens.tenantId,
        orderId: trackingTokens.orderId,
        expiresAt: trackingTokens.expiresAt,
      })
      .from(trackingTokens)
      .where(eq(trackingTokens.token, parsed.data))
      .limit(1);
    const tokenRow = tokenRows[0];
    if (!tokenRow || tokenRow.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException("not found"); // §7: منتهٍ = غائب — 404 عام
    }

    // §14 — مستأجر معلّق/مؤرشف: صفحته العامة تختفي بنفس الـ 404 (tenants استثناء RLS §2.3)
    const tenantRows = await this.handle.db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tokenRow.tenantId))
      .limit(1);
    const tenant = tenantRows[0];
    if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
      throw new NotFoundException("not found");
    }

    // بقية القراءة عبر withTenant بمستأجر التوكن (§2.2) — استعلام واحد join (§16.10).
    // D7: الهندسة تُقرأ بـ SQL صريح (ST_Y/ST_X على geometry) — لا WKB خام عبر الـ ORM.
    const row = await withTenant(this.handle.db, tokenRow.tenantId, async (tx) => {
      const rows = await tx
        .select({
          status: orders.status,
          publicCode: orders.publicCode,
          dropoffLat: sql<number>`ST_Y(${orders.dropoffPoint}::geometry)`,
          dropoffLng: sql<number>`ST_X(${orders.dropoffPoint}::geometry)`,
          driverId: orders.driverId,
          driverLat: sql<number | null>`ST_Y(${drivers.lastPoint}::geometry)`,
          driverLng: sql<number | null>`ST_X(${drivers.lastPoint}::geometry)`,
          driverLastPointAt: drivers.lastPointAt,
        })
        .from(orders)
        .leftJoin(drivers, and(eq(drivers.tenantId, orders.tenantId), eq(drivers.id, orders.driverId)))
        .where(and(eq(orders.id, tokenRow.orderId), isNull(orders.deletedAt))) // D10
        .limit(1);
      return rows[0];
    });
    if (!row) {
      throw new NotFoundException("not found"); // طلب محذوف ناعماً بعد إصدار التوكن (D10)
    }

    // §7 — موقع السائق فقط والطلب نشط (assigned..arrived) وله سائق أرسل نقطة:
    // خارج النافذة النشطة لا يُبثّ موقعه (خصوصية السائق — نفس روح stopMessageLiveLocation)
    const driver =
      TRACKED_ACTIVE_STATUSES.includes(row.status) &&
      row.driverId !== null &&
      row.driverLat !== null &&
      row.driverLng !== null &&
      row.driverLastPointAt !== null
        ? {
            lat: row.driverLat,
            lng: row.driverLng,
            // الفخ 19 — عمر النقطة بالثواني: الواجهة تعرض "آخر موقع معروف قبل X"
            lastPointAgeS: Math.max(0, Math.floor((Date.now() - row.driverLastPointAt.getTime()) / 1000)),
          }
        : null;

    return {
      status: row.status,
      publicCode: row.publicCode,
      dropoff: { lat: row.dropoffLat, lng: row.dropoffLng },
      driver,
    };
  }
}
