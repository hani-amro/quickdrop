import {
  ROAD_DISTANCE_FALLBACK_FACTOR,
  computePrice,
  haversineMeters,
  toPostgisWkt,
  type Point,
  type PriceComponents,
  type Service,
} from "@quickdrop/shared";
import { osrmRoute } from "@quickdrop/geo";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { pricingRules, zones } from "./schema/index.js";
import type { Tx } from "./with-tenant.js";

// §3 pricing_rules + §8.3-1 — طبقة القاعدة لمحرك التسعير: اختيار القاعدة المطابقة
// ثم الحساب الصافي عبر computePrice من @quickdrop/shared. تُستدعى داخل withTenant حصراً (§2.2).

export interface Quote {
  components: PriceComponents;
  distanceM: number;
  durationS: number;
  ruleId: string | null;
}

/** لا قاعدة تسعير فعّالة تطابق الخدمة/المنطقة — خطأ صريح، لا سعر صفري صامت (§16.12). */
export class NoPricingRuleError extends Error {
  readonly service: Service;

  constructor(service: Service) {
    super(`no active pricing rule matches service "${service}" (§3 pricing_rules)`);
    this.name = "NoPricingRuleError";
    this.service = service;
  }
}

// §7: تقدير مؤقت حتى تشغيل OSRM بالمرحلة 2 — سرعة حضرية 25 كم/س.
const URBAN_SPEED_M_PER_S = 25_000 / 3_600;

export async function quoteOrder(
  tx: Tx,
  input: { service: Service; pickup: Point; dropoff: Point; weightG?: number | null; osrmBase?: string },
): Promise<Quote> {
  // §7 — مسافة/مدة الطريق: OSRM إن هُيّئ (معامل صريح أو OSRM_URL بالبيئة)، وإلا
  // هافرساين×1.4 (الفخ 5: تقدير لا مسافة طريق حقيقية).
  const osrmBase = input.osrmBase ?? process.env["OSRM_URL"]?.trim();
  let distanceM: number;
  let durationS: number;
  const osrm = osrmBase ? await osrmRoute(osrmBase, input.pickup, input.dropoff) : null;
  if (osrm !== null) {
    distanceM = osrm.distanceM;
    durationS = osrm.durationS;
  } else {
    if (osrmBase) {
      // §7 — OSRM مُهيّأ لكنه سقط: سجّل تحذيراً ولا توقف استقبال الطلبات (تسقط للتقدير)
      console.warn(JSON.stringify({ action: "osrm_route", outcome: "fallback_haversine" }));
    }
    distanceM = Math.round(haversineMeters(input.pickup, input.dropoff) * ROAD_DISTANCE_FALLBACK_FACTOR);
    durationS = Math.round(distanceM / URBAN_SPEED_M_PER_S);
  }

  const dropoffWkt = toPostgisWkt(input.dropoff); // D7: WKT بترتيب lng lat

  // v1.1: المطابقة بمنطقة نقطة التسليم (dropoff) حصراً؛ zone_id NULL = قاعدة عامة.
  // WHERE: الخدمة + النافذة الزمنية (now() القاعدة — D6: UTC) + (قاعدة عامة أو منطقة فعّالة تغطي الـ dropoff).
  // ORDER BY: قواعد المنطقة المطابقة أولاً، ثم العامة، ثم priority DESC — خذ الأولى.
  const rows = await tx
    .select({ rule: pricingRules })
    .from(pricingRules)
    .leftJoin(zones, and(eq(zones.tenantId, pricingRules.tenantId), eq(zones.id, pricingRules.zoneId)))
    .where(
      and(
        eq(pricingRules.service, input.service),
        sql`(${pricingRules.activeFrom} IS NULL OR ${pricingRules.activeFrom} <= now())`,
        sql`(${pricingRules.activeTo} IS NULL OR ${pricingRules.activeTo} > now())`,
        or(
          isNull(pricingRules.zoneId),
          and(eq(zones.isActive, true), sql`ST_Covers(${zones.polygon}, ST_GeogFromText(${dropoffWkt}))`),
        ),
      ),
    )
    .orderBy(sql`(${pricingRules.zoneId} IS NOT NULL) DESC`, desc(pricingRules.priority))
    .limit(1);

  const matched = rows[0];
  if (!matched) {
    throw new NoPricingRuleError(input.service);
  }

  const components = computePrice(matched.rule, distanceM, input.weightG ?? null);
  return { components, distanceM, durationS, ruleId: matched.rule.id };
}
