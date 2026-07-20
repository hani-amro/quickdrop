import { computeIsSuspect, makePoint, toPostgisWkt } from "@quickdrop/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { drivers, driverLocations, orders } from "./schema/index.js";
import { InvalidTransitionError, transition } from "./state-machine.js";
import { withTenant, type Tx } from "./with-tenant.js";

// §7 v1.1 — تسجيل نقطة موقع سائق (المصدر الوحيد): كان في apps/worker/update-processor؛ نُقل
// إلى packages/db (P5.1) كي تستهلكه قناتا السائق معاً — بوت تيليغرام (worker) وتطبيق PWA
// (driver API) — بلا تكرار منطق is_suspect/geofence. النشر للوقت الحقيقي (publishRt) يبقى
// عند المستدعي (D9: db لا ينشر Redis)؛ الدالة تُرجع isSuspect ليقرّر المستدعي البثّ.

/** §7 v1.1 — نصف قطر geofence الوصول بالأمتار: نقطتان متتاليتان ضمنه من نقطة التسليم → arrived. */
export const GEOFENCE_ARRIVED_RADIUS_M = 150;

/**
 * §7 v1.1 — الانتقالات التلقائية بعد كتابة نقطة **غير مشبوهة**، لكل طلب من طلبات السائق
 * النشطة على حدة (D14): picked_up→in_transit (أول تحديث بعد الاستلام)، in_transit→arrived
 * (آخر نقطتين متتاليتين غير مشبوهتين ضمن 150م من التسليم — درع قفزات GPS). داخل ترانزاكشن
 * withTenant القائمة؛ transition تكتب order_events + outbox معها (D8). قفل صف السائق يسلسل.
 */
async function applyGeofenceTransitions(tx: Tx, tenantId: string, driverId: string): Promise<void> {
  const lastTwoWithinDropoff = sql<boolean>`(
    SELECT count(*) = 2 AND bool_and(ST_DWithin(${orders.dropoffPoint}, last2.point, ${GEOFENCE_ARRIVED_RADIUS_M}::float8))
    FROM (
      SELECT dl.point
      FROM driver_locations dl
      WHERE dl.tenant_id = ${tenantId}
        AND dl.driver_id = ${driverId}
        AND dl.is_suspect = false
      ORDER BY dl.recorded_at DESC
      LIMIT 2
    ) last2
  )`;

  const activeOrders = await tx
    .select({ id: orders.id, status: orders.status, arrivedByGeofence: lastTwoWithinDropoff })
    .from(orders)
    .where(
      and(eq(orders.driverId, driverId), inArray(orders.status, ["picked_up", "in_transit"]), isNull(orders.deletedAt)),
    );

  for (const order of activeOrders) {
    if (order.status === "picked_up") {
      try {
        await transition(tx, { orderId: order.id, to: "in_transit", actor: { type: "system" }, meta: { trigger: "driver_location" } });
      } catch (error: unknown) {
        // idempotent (§7): سباق مع زر «انطلقت» أو انتقال متزامن — التجاهل الصامت مسموح هنا حصراً.
        if (!(error instanceof InvalidTransitionError)) throw error;
      }
    } else if (order.status === "in_transit" && order.arrivedByGeofence) {
      try {
        await transition(tx, { orderId: order.id, to: "arrived", actor: { type: "system" }, meta: { trigger: "geofence" } });
      } catch (error: unknown) {
        if (!(error instanceof InvalidTransitionError)) throw error;
      }
    }
  }
}

/**
 * §7 v1.1 — نقطة موقع سائق: قفل صف السائق FOR UPDATE (يسلسل نبضتين متزامنتين) → is_suspect
 * عند الإدخال مقارنةً بآخر نقطة → INSERT driver_locations → تحديث last_point فقط إن أحدث
 * وغير مشبوهة → geofence. ترانزاكشن withTenant واحدة (D9: لا شبكة هنا). تُرجع isSuspect —
 * المستدعي يبثّ driver.location للنقطة غير المشبوهة بعد الالتزام.
 */
export async function recordDriverLocationTx(
  db: Db,
  tenantId: string,
  driverId: string,
  point: { lat: number; lng: number },
  recordedAt: Date,
): Promise<{ isSuspect: boolean }> {
  const isSuspect = await withTenant(db, tenantId, async (tx) => {
    const lockedRows = await tx
      .select({ id: drivers.id, lastPointAt: drivers.lastPointAt })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .for("update");
    const driver = lockedRows[0];
    if (!driver) {
      throw new Error(`recordDriverLocationTx: driver ${driverId} not found`); // §16.12: فشل صاخب
    }

    const prevRows = await tx
      .select({
        lat: sql<number>`ST_Y(${driverLocations.point}::geometry)`,
        lng: sql<number>`ST_X(${driverLocations.point}::geometry)`,
        recordedAt: driverLocations.recordedAt,
      })
      .from(driverLocations)
      .where(eq(driverLocations.driverId, driverId))
      .orderBy(desc(driverLocations.recordedAt))
      .limit(1);
    const prev = prevRows[0] ?? null;

    const { isSuspect: suspect, speedKmh } = computeIsSuspect(prev, { lat: point.lat, lng: point.lng, recordedAt });

    const wkt = toPostgisWkt(makePoint(point.lat, point.lng)); // الفخ 6/D7: WKT بترتيب lng lat
    await tx.insert(driverLocations).values({ tenantId, driverId, point: wkt, recordedAt, speedKmh, isSuspect: suspect });

    if (!suspect && (driver.lastPointAt === null || recordedAt.getTime() > driver.lastPointAt.getTime())) {
      await tx.update(drivers).set({ lastPoint: wkt, lastPointAt: recordedAt, updatedAt: new Date() }).where(eq(drivers.id, driverId));
    }
    if (!suspect) {
      await applyGeofenceTransitions(tx, tenantId, driverId);
    }
    return suspect;
  });

  return { isSuspect };
}
