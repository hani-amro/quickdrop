import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { tenantDay } from "@quickdrop/shared";
import type { OrderStatus } from "@quickdrop/shared";
import type { Db } from "./client.js";
import { drivers, orderEvents, orders, zones } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §13/§10 v1.1 — تحليلات لوحة المكتب. مبدأ الأداء (§16.10: لا N+1): كل مقياس استعلام
// مجمّع واحد (GROUP BY / AVG / SUM أو join تجميعي) داخل ترانزاكشن withTenant واحدة
// (لقطة متسقة). لا حلقة استعلام لكل صف. كل حساب تقويمي ("اليوم"، تجميع يومي §16.8)
// بمنطقة المستأجر عبر AT TIME ZONE / tenantDay — لا يوم الخادم. المال bigint (D5).

export interface StatusCount {
  status: OrderStatus;
  count: number;
}

export interface DailyCount {
  /** YYYY-MM-DD بمنطقة المستأجر (§16.8). */
  day: string;
  count: number;
}

export interface ZoneCount {
  zoneId: string;
  name: string;
  count: number;
}

export interface DashboardStats {
  /** إعدادات النافذة المطبَّقة (للعرض/التشخيص). */
  window: { sinceDays: number; timezone: string };
  /** طلبات اليوم (بمنطقة المستأجر). */
  ordersToday: number;
  /** إجمالي طلبات النافذة (آخر sinceDays يوماً). */
  ordersWindow: number;
  /** التوزيع حسب الحالة ضمن النافذة. */
  statusCounts: StatusCount[];
  /** متوسط زمن الإسناد بالثواني (confirmed→assigned) — null إن لا بيانات. */
  avgAssignSeconds: number | null;
  /** متوسط زمن التوصيل بالثواني (created→delivered) — null إن لا بيانات. */
  avgDeliverySeconds: number | null;
  /** إجمالي الإيراد = SUM(price_total) للطلبات المسلَّمة ضمن النافذة (D5: bigint). */
  revenue: bigint;
  /** عدد الطلبات المسلَّمة ضمن النافذة. */
  deliveredCount: number;
  /** السائقون المتصلون الآن (status='online') — غير مقيَّد بالنافذة. */
  activeDrivers: number;
  /** سلسلة يومية متصلة بطول sinceDays (الأقدم→الأحدث)؛ يوم بلا بيانات = 0. */
  daily: DailyCount[];
  /** أكثر المناطق طلباً (حسب zone عبر ST_Covers على نقطة التسليم) — أعلى 5. */
  topZones: ZoneCount[];
}

export interface DashboardStatsOptions {
  /** نافذة التحليل بالأيام (افتراضي 7). */
  sinceDays?: number;
  /** منطقة المستأجر الزمنية (§16.8) — إلزامية لحساب "اليوم"/التجميع اليومي. */
  timezone: string;
}

const DEFAULT_SINCE_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** numeric من الدرايفر يصل نصاً (أو null على مجموعة فارغة) — تطبيع دفاعي لرقم/null. */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** سلسلة تواريخ تقويمية متصلة تنتهي بـ todayStr (بمنطقة المستأجر). ظهيرة UTC تتفادى حواف DST. */
export function localDateSeries(todayStr: string, days: number): string[] {
  const [y, m, d] = todayStr.split("-").map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dt = new Date(base - i * MS_PER_DAY);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    out.push(`${yy}-${mm}-${dd}`);
  }
  return out;
}

/**
 * §13 — إحصاءات لوحة المكتب. النافذة زمنية متدحرجة (now − sinceDays)؛ التجميع اليومي
 * تقويمي بمنطقة المستأجر (اليوم الأقدم قد يكون جزئياً — مقبول للوحة KPI تقريبية).
 */
export async function getDashboardStats(
  db: Db,
  tenantId: string,
  options: DashboardStatsOptions,
): Promise<DashboardStats> {
  const sinceDays = Math.max(1, Math.min(90, Math.floor(options.sinceDays ?? DEFAULT_SINCE_DAYS)));
  const timezone = options.timezone;
  const now = new Date(); // D6: UTC
  const windowStart = new Date(now.getTime() - sinceDays * MS_PER_DAY);
  const todayStr = tenantDay(timezone, now);

  const countExpr = sql<number>`count(*)::int`.mapWith(Number);
  // §16.8 — التجميع بيوم المستأجر التقويمي، لا بيوم الخادم
  const dayExpr = sql<string>`to_char((${orders.createdAt} AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD')`;

  return withTenant(db, tenantId, async (tx) => {
    // 1) التوزيع حسب الحالة ضمن النافذة (GROUP BY status — استعلام واحد)
    const statusRows = await tx
      .select({ status: orders.status, count: countExpr })
      .from(orders)
      .where(
        and(eq(orders.tenantId, tenantId), isNull(orders.deletedAt), gte(orders.createdAt, windowStart)),
      )
      .groupBy(orders.status);

    // 2) السلسلة اليومية (GROUP BY يوم المستأجر — استعلام واحد)
    const dailyRows = await tx
      .select({ day: dayExpr, count: countExpr })
      .from(orders)
      .where(
        and(eq(orders.tenantId, tenantId), isNull(orders.deletedAt), gte(orders.createdAt, windowStart)),
      )
      .groupBy(dayExpr);

    // 3) إيراد + متوسط التوصيل + عدد المسلَّم (طلبات delivered ضمن النافذة — استعلام واحد)
    const deliveredRows = await tx
      .select({
        // D5 — SUM(BIGINT) يصل numeric نصياً؛ coalesce يمنع null على مجموعة فارغة
        revenue: sql<bigint>`coalesce(sum(${orders.priceTotal}), 0)`.mapWith((v) => BigInt(String(v))),
        avgDeliverySeconds: sql<
          number | null
        >`avg(extract(epoch from (${orders.deliveredAt} - ${orders.createdAt})))`,
        deliveredCount: countExpr,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          isNull(orders.deletedAt),
          eq(orders.status, "delivered"),
          gte(orders.createdAt, windowStart),
        ),
      );

    // 4) متوسط زمن الإسناد (confirmed→assigned) — أقدم حدثين لكل طلب، join تجميعي واحد.
    //    order_events append-only؛ لكل طلب قد يتكرر assigned (إعادة إسناد) → نأخذ min.
    const confirmed = tx
      .select({
        orderId: orderEvents.orderId,
        confirmedAt: sql<Date>`min(${orderEvents.createdAt})`.as("confirmed_at"),
      })
      .from(orderEvents)
      .where(
        and(
          eq(orderEvents.tenantId, tenantId),
          eq(orderEvents.toStatus, "confirmed"),
          gte(orderEvents.createdAt, windowStart),
        ),
      )
      .groupBy(orderEvents.orderId)
      .as("confirmed");

    const assigned = tx
      .select({
        orderId: orderEvents.orderId,
        assignedAt: sql<Date>`min(${orderEvents.createdAt})`.as("assigned_at"),
      })
      .from(orderEvents)
      .where(and(eq(orderEvents.tenantId, tenantId), eq(orderEvents.toStatus, "assigned")))
      .groupBy(orderEvents.orderId)
      .as("assigned");

    const assignRows = await tx
      .select({
        avgAssignSeconds: sql<
          number | null
        >`avg(extract(epoch from (${assigned.assignedAt} - ${confirmed.confirmedAt})))`,
      })
      .from(confirmed)
      .innerJoin(
        assigned,
        and(
          eq(assigned.orderId, confirmed.orderId),
          sql`${assigned.assignedAt} >= ${confirmed.confirmedAt}`,
        ),
      );

    // 5) السائقون المتصلون الآن (count — استعلام واحد)
    const activeDriverRows = await tx
      .select({ count: countExpr })
      .from(drivers)
      .where(and(eq(drivers.tenantId, tenantId), eq(drivers.status, "online")));

    // 6) أكثر المناطق طلباً — join مكاني ST_Covers(zone.polygon, dropoff) مجمّع (استعلام واحد).
    //    مكلف نسبياً لكن مناطق المكتب قليلة (§14) والنافذة محدودة — مقبول v1.
    const zoneCountExpr = sql<number>`count(*)::int`.mapWith(Number);
    const zoneRows = await tx
      .select({ zoneId: zones.id, name: zones.name, count: zoneCountExpr })
      .from(orders)
      .innerJoin(
        zones,
        and(eq(zones.tenantId, orders.tenantId), sql`ST_Covers(${zones.polygon}, ${orders.dropoffPoint})`),
      )
      .where(
        and(eq(orders.tenantId, tenantId), isNull(orders.deletedAt), gte(orders.createdAt, windowStart)),
      )
      .groupBy(zones.id, zones.name)
      .orderBy(desc(zoneCountExpr), asc(zones.name))
      .limit(5);

    // —— تجميع النتائج (لا استعلامات إضافية) ——
    const dailyMap = new Map<string, number>();
    for (const r of dailyRows) dailyMap.set(r.day, r.count);
    const daily = localDateSeries(todayStr, sinceDays).map((day) => ({ day, count: dailyMap.get(day) ?? 0 }));

    const ordersWindow = statusRows.reduce((sum, r) => sum + r.count, 0);
    const delivered = deliveredRows[0];

    return {
      window: { sinceDays, timezone },
      ordersToday: dailyMap.get(todayStr) ?? 0,
      ordersWindow,
      statusCounts: statusRows.map((r) => ({ status: r.status, count: r.count })),
      avgAssignSeconds: numOrNull(assignRows[0]?.avgAssignSeconds),
      avgDeliverySeconds: numOrNull(delivered?.avgDeliverySeconds),
      revenue: delivered?.revenue ?? 0n,
      deliveredCount: delivered?.deliveredCount ?? 0,
      activeDrivers: activeDriverRows[0]?.count ?? 0,
      daily,
      topZones: zoneRows.map((r) => ({ zoneId: r.zoneId, name: r.name, count: r.count })),
    };
  });
}
