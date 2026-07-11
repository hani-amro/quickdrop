import { randomBytes } from "node:crypto";
import { newId, toPostgisWkt, type OrderActorType, type Point, type Service } from "@quickdrop/shared";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { applyCouponToOrder } from "./coupons.js";
import { quoteOrder, type Quote } from "./pricing.js";
import { counters, orders, trackingTokens, type Order } from "./schema/index.js";
import { transition } from "./state-machine.js";
import { withTenant, type Tx } from "./with-tenant.js";

// §10.1 D15 + §4.4 — خدمة الطلبات: نقطة الدخول الوحيدة لإنشاء طلب من أي قناة
// (شاشة D15 بالداشبورد، بوت الزبون لاحقاً) — محرك تسعير واحد ومسار إنشاء واحد
// (مصدر حقيقة واحد §10.1). كل الوصول للقاعدة عبر withTenant (§2.2).

export interface QuoteInput {
  service: Service;
  pickup: Point;
  dropoff: Point;
  weightG?: number;
}

export interface CreateOrderInput {
  service: Service;
  customerId: string;
  pickup: Point;
  pickupText?: string;
  dropoff: Point;
  dropoffText?: string;
  recipientPhone?: string; // الطلب لشخص آخر (الفخ 16)
  weightG?: number;
  goodsAmount?: bigint; // D5: مال bigint حصراً
  notes?: string;
  scheduledAt?: Date; // D6: يُخزَّن TIMESTAMPTZ بتوقيت UTC
  couponCode?: string; // §8.3-4: إن مُرِّر، يُحجَز ويُخصَم ضمن ترانزاكشن الإنشاء
  createdBy: { type: OrderActorType; id?: string };
}

/**
 * §3 — public_code: عدّاد لكل مستأجر مُثبَّت بالقاعدة (لا Redis — Redis بيضيع).
 * أول طلب للمستأجر = 1000، وكل upsert لاحق يزيد 1 ذرّياً — صف العدّاد يُقفَل
 * ضمنياً بالـ UPDATE فلا تتصادم طلبات متزامنة على نفس الرقم.
 */
export async function nextPublicCode(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx
    .insert(counters)
    .values({ tenantId, key: "order_public_code", value: 1000n })
    .onConflictDoUpdate({
      target: [counters.tenantId, counters.key],
      set: { value: sql`${counters.value} + 1` },
    })
    .returning({ value: counters.value });
  const row = rows[0];
  if (!row) {
    // §16.12 — لا ابتلاع: upsert مع RETURNING بلا صف = حالة مستحيلة تستحق فشلاً صاخباً
    throw new Error("nextPublicCode: INSERT ... ON CONFLICT ... RETURNING returned no row");
  }
  return String(row.value);
}

/**
 * §4.4 — عرض السعر قبل التأكيد إلزامي: الواجهة تستدعي هذه قبل createOrder
 * وتعرض التفصيل، ثم تؤكد. نفس quoteOrder الذي يستخدمه الإنشاء — لا محرك ثانٍ.
 */
export async function quoteForTenant(db: Db, tenantId: string, input: QuoteInput): Promise<Quote> {
  return withTenant(db, tenantId, (tx) => quoteOrder(tx, input));
}

/** §7 — عمر رابط التتبع الابتدائي: 72 ساعة من الإنشاء؛ يُقلَّص إلى ساعة بعد التسليم. */
export const TRACKING_TOKEN_INITIAL_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * D15 — إنشاء طلب: ترانزاكشن withTenant واحدة تجمع التسعير + العدّاد + INSERT
 * + الانتقال الأول — إمّا كله أو لا شيء (لا طلب بلا سعر ولا عدّاد محروق على طلب فاشل).
 *
 * الحالة الأولى draft ثم transition() فوراً إلى pending (أو scheduled لطلب بموعد §5) —
 * لا UPDATE حالة خارج transition أبداً (D8)، وهي من تكتب order_events وصف الـ outbox
 * بنفس الترانزاكشن (D9: الإرسال بعد الالتزام عند العامل).
 */
export async function createOrder(
  db: Db,
  tenantId: string,
  input: CreateOrderInput,
): Promise<{ order: Order; quote: Quote; trackingToken: string }> {
  return withTenant(db, tenantId, async (tx) => {
    const quote = await quoteOrder(tx, {
      service: input.service,
      pickup: input.pickup,
      dropoff: input.dropoff,
      weightG: input.weightG ?? null,
    });
    const publicCode = await nextPublicCode(tx, tenantId);

    // §3: cod_amount ≠ price_total — المُحصَّل من الزبون = قيمة البضاعة + التوصيل (D13)
    const goodsAmount = input.goodsAmount ?? 0n;
    const c = quote.components;

    // §8.3-4 — نولّد معرّف الطلب مسبقاً (D11) كي نربط حجز الكوبون به قبل الإدراج:
    // coupon_redemptions بلا FK إلى orders (تفادي حلقة الاستيراد §schema)، فترتيب
    // الإدراج لا يهم — الحجز والطلب ذرّيان بنفس الترانزاكشن (لا حرق على طلب فاشل).
    const orderId = newId();

    // §8.3-4: الخصم من الكوبون (إن مُرِّر) على إجمالي التوصيل — subtotal = quote.total.
    // computePrice يضع discount = 0؛ الكوبون هو مصدر الخصم الوحيد بمسار الإنشاء.
    let discount = c.discount;
    let couponId: string | undefined;
    if (input.couponCode !== undefined) {
      const applied = await applyCouponToOrder(tx, tenantId, {
        couponCode: input.couponCode,
        userId: input.customerId,
        orderId,
        subtotal: c.total,
      });
      discount = applied.discount;
      couponId = applied.couponId;
    }

    // §8.3-1 (invariant): price_total = base + distance + weight + surge + minAdjustment − discount.
    const priceTotal = c.base + c.distance + c.weight + c.surge + c.minAdjustment - discount;

    const inserted = await tx
      .insert(orders)
      .values({
        id: orderId,
        tenantId,
        publicCode,
        service: input.service,
        status: "draft", // الانتقال الأول عبر transition() أدناه — لا اختصار (D8)
        customerId: input.customerId,
        pickupPoint: toPostgisWkt(input.pickup), // D7: WKT بترتيب lng lat
        dropoffPoint: toPostgisWkt(input.dropoff),
        ...(input.pickupText !== undefined ? { pickupText: input.pickupText } : {}),
        ...(input.dropoffText !== undefined ? { dropoffText: input.dropoffText } : {}),
        ...(input.recipientPhone !== undefined ? { recipientPhone: input.recipientPhone } : {}),
        ...(input.weightG !== undefined ? { weightG: input.weightG } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
        ...(couponId !== undefined ? { couponId } : {}),
        distanceM: quote.distanceM,
        routeDurationS: quote.durationS,
        // §8.3-1 — لقطة مكوّنات السعر بالأعمدة المسمّاة لحظة الإنشاء (§3: لقطات الأسعار)
        priceBase: c.base,
        priceDistance: c.distance,
        priceWeight: c.weight,
        priceSurge: c.surge,
        priceMinAdjustment: c.minAdjustment,
        priceDiscount: discount,
        priceTotal,
        goodsAmount,
        codAmount: goodsAmount + priceTotal,
      })
      .returning({ id: orders.id });

    const row = inserted[0];
    if (!row) {
      // §16.12 — لا ابتلاع أخطاء
      throw new Error("createOrder: INSERT orders ... RETURNING returned no row");
    }

    // §5 — طلب بموعد مستقبلي يدخل scheduled (مهمة الجدولة تطلقه لاحقاً §6.3)، وإلا pending
    const order = await transition(tx, {
      orderId: row.id,
      to: input.scheduledAt !== undefined ? "scheduled" : "pending",
      actor: input.createdBy,
    });

    // §7 — رابط التتبع العام /t/{token}: توكن 128-bit عشوائي (16 بايت hex) لكل طلب،
    // بنفس ترانزاكشن الإنشاء (لا طلب بلا رابط تتبع). tracking_tokens استثناء RLS
    // مسمّى (§2.3): القراءة العامة بالتوكن وحده، والإدراج هنا داخل ترانزاكشن المستأجر.
    // expires_at الابتدائي 72 ساعة — يُقلَّص إلى «التسليم + ساعة» عند delivered (§7).
    const trackingToken = randomBytes(16).toString("hex");
    await tx.insert(trackingTokens).values({
      token: trackingToken,
      tenantId,
      orderId: row.id,
      expiresAt: new Date(Date.now() + TRACKING_TOKEN_INITIAL_TTL_MS), // D6: UTC
    });

    return { order, quote, trackingToken };
  });
}
