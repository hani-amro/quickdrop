import { sql } from "drizzle-orm";
import {
  ATTACHMENT_KINDS,
  FULFILLMENTS,
  OFFER_STATUSES,
  ORDER_ACTOR_TYPES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  SERVICES,
} from "@quickdrop/shared";
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  geographyPoint,
  idPk,
  money,
  tenantId,
  timestamptz,
  updatedAt,
} from "./_common.js";
import { conversations } from "./conversations.js";
import { drivers } from "./drivers.js";
import { coupons } from "./loyalty.js";
import { merchants } from "./merchants.js";
import { users } from "./users.js";

// §3 v1.1 — orders. مكوّنات السعر NOT NULL DEFAULT 0 (CHECK مع NULL يمرّ بصمت — 8.3-1).
// المفاتيح الأجنبية بين جداول الأعمال مركّبة (tenant_id, id) — فحص الـ FK يتجاوز RLS (§2.3).
export const orders = pgTable(
  "orders",
  {
    id: idPk(),
    tenantId: tenantId(),
    publicCode: text("public_code").notNull(), // قصير للبشر؛ فريد ضمن المستأجر
    service: text("service", { enum: SERVICES }).notNull(),
    status: text("status", { enum: ORDER_STATUSES }).notNull().default("draft"),
    customerId: uuid("customer_id").notNull(),
    merchantId: uuid("merchant_id"),
    driverId: uuid("driver_id"), // يُكتب/يُمحى داخل ترانزاكشن transition حصراً
    pickupPoint: geographyPoint("pickup_point").notNull(),
    pickupText: text("pickup_text"),
    dropoffPoint: geographyPoint("dropoff_point").notNull(),
    dropoffText: text("dropoff_text"),
    dropoffAddressId: uuid("dropoff_address_id"),
    recipientPhone: text("recipient_phone"), // الطلب لشخص آخر (الفخ 16)
    scheduledAt: timestamptz("scheduled_at"),
    promisedAt: timestamptz("promised_at"), // لقطة الوعد لحظة confirmed — لا تُعاد كتابتها
    // §3 v1 — تبليغ/تأكيد التاجر (نسخة v1): الموزّع يتصل هاتفياً + زر "المطعم أكّد" بالداشبورد.
    // عمود عادي (وقت التأكيد) لا حالة — لا يمسّ transition()/D8؛ يُملأ مرة واحدة (IS NULL شرط).
    // ذو معنى لطلبات service='food' مع merchant_id فقط؛ يملؤه المكتب (زر الداشبورد) أو
    // التاجر من بوته (merchant-flow.ts: قبول الطلب يضبط هذا العمود + merchant_prep_minutes).
    merchantConfirmedAt: timestamptz("merchant_confirmed_at"),
    merchantPrepMinutes: integer("merchant_prep_minutes"), // §3 بوت التاجر — مدة التحضير المختارة عند القبول
    // —— دمج WaFlow (MERGE_PLAN §4.1) — أعمدة المفصل والدفع ——
    // pickup = استلام ذاتي بلا رحلة توصيل (لا يصل الإسناد أبداً). نقاط pickup/dropoff تبقى
    // NOT NULL بهذه المرحلة (طلب pickup يستخدم موقع المطعم للنقطتين)؛ جعلها NULLable مع
    // CHECK يهبط مع استيراد بيانات WaFlow بـ Phase 5 — لا مسار إنشاء ينتجها الآن.
    fulfillment: text("fulfillment", { enum: FULFILLMENTS }).notNull().default("delivery"),
    readyAt: timestamptz("ready_at"), // علم جهوز المطبخ — يُملأ مرة واحدة (transition→ready)
    // ختم الـ seam الوحيد (D-M1): write-once بـ UPDATE شرطي — صف outbox
    // order.ready_for_dispatch يُكتب فقط حين يصيب هذا الـ UPDATE صفاً واحداً (لا انبعاث مزدوج)
    dispatchRequestedAt: timestamptz("dispatch_requested_at"),
    goodsTax: money("goods_tax").notNull().default(sql`0`), // ضريبة البضاعة (WF tax×100)؛ الإجمالي مشتق لا يُخزَّن
    paymentStatus: text("payment_status", { enum: PAYMENT_STATUSES }).notNull().default("unpaid"),
    paymentRef: text("payment_ref"), // معرّف فاتورة Billplz (أو مرجع بوابة أخرى)
    paymentPaidAt: timestamptz("payment_paid_at"),
    conversationId: uuid("conversation_id"), // خيط المحادثة الذي وُلد منه الطلب (Brain A)
    source: text("source"), // إسناد المنشأ: 'ai' | 'staff' | 'bot' | 'miniapp' … (حارس بوابة البشر §3.2)
    deliveredAt: timestamptz("delivered_at"), // denormalized؛ يُملأ بترانزاكشن الانتقال
    weightG: integer("weight_g"), // للطرود الموزونة (per_kg)
    distanceM: integer("distance_m"),
    routeDurationS: integer("route_duration_s"),
    priceBase: money("price_base").notNull().default(sql`0`),
    priceDistance: money("price_distance").notNull().default(sql`0`),
    priceWeight: money("price_weight").notNull().default(sql`0`),
    priceSurge: money("price_surge").notNull().default(sql`0`),
    priceMinAdjustment: money("price_min_adjustment").notNull().default(sql`0`), // فرق الرفع لـ min_total
    priceDiscount: money("price_discount").notNull().default(sql`0`),
    priceTotal: money("price_total").notNull().default(sql`0`),
    goodsAmount: money("goods_amount").notNull().default(sql`0`), // ما دفعه السائق للتاجر (D13)
    codAmount: money("cod_amount").notNull().default(sql`0`), // المُحصَّل من الزبون = goods + توصيل
    codReceived: money("cod_received"), // المستلَم فعلياً عند التسليم (الفخ 18)
    couponId: uuid("coupon_id"),
    customerMsgId: bigint("customer_msg_id", { mode: "number" }),
    customerLiveMsgId: bigint("customer_live_msg_id", { mode: "number" }),
    originOrderId: uuid("origin_order_id"), // نسخة معدّلة (الفخ 17) أو إعادة توصيل
    cancelReason: text("cancel_reason"),
    failedReason: text("failed_reason"),
    notes: text("notes"),
    deletedAt: timestamptz("deleted_at"), // D10: soft delete
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_tenant_id_id_uq").on(t.tenantId, t.id), // أب لمفاتيح مركّبة
    uniqueIndex("orders_tenant_public_code_uq").on(t.tenantId, t.publicCode),
    index("orders_tenant_status_idx").on(t.tenantId, t.status), // §2.3: الفهارس تبدأ بالمستأجر
    index("orders_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("orders_tenant_driver_status_idx").on(t.tenantId, t.driverId, t.status), // ترشيح D14
    index("orders_tenant_conversation_idx").on(t.tenantId, t.conversationId), // §4.1 [adversary #16]
    foreignKey({ columns: [t.tenantId, t.conversationId], foreignColumns: [conversations.tenantId, conversations.id], name: "orders_conversation_fk" }),
    foreignKey({ columns: [t.tenantId, t.customerId], foreignColumns: [users.tenantId, users.id], name: "orders_customer_fk" }),
    foreignKey({ columns: [t.tenantId, t.merchantId], foreignColumns: [merchants.tenantId, merchants.id], name: "orders_merchant_fk" }),
    foreignKey({ columns: [t.tenantId, t.driverId], foreignColumns: [drivers.tenantId, drivers.id], name: "orders_driver_fk" }),
    foreignKey({ columns: [t.tenantId, t.couponId], foreignColumns: [coupons.tenantId, coupons.id], name: "orders_coupon_fk" }),
    foreignKey({ columns: [t.tenantId, t.originOrderId], foreignColumns: [t.tenantId, t.id], name: "orders_origin_fk" }),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: idPk(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    catalogItemId: uuid("catalog_item_id"),
    nameSnapshot: text("name_snapshot").notNull(), // لقطة وقت الطلب — لا FK حي للسعر
    qty: integer("qty").notNull(),
    unitPriceSnapshot: money("unit_price_snapshot").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("order_items_tenant_order_idx").on(t.tenantId, t.orderId),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_items_order_fk" }),
  ],
);

// append-only: REVOKE UPDATE/DELETE + trigger يرمي استثناء (بالترحيل المخصص)
export const orderEvents = pgTable(
  "order_events",
  {
    id: idPk(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    fromStatus: text("from_status", { enum: ORDER_STATUSES }),
    toStatus: text("to_status", { enum: ORDER_STATUSES }).notNull(),
    actorType: text("actor_type", { enum: ORDER_ACTOR_TYPES }).notNull(),
    actorId: uuid("actor_id"),
    point: geographyPoint("point"),
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [
    index("order_events_tenant_order_idx").on(t.tenantId, t.orderId),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_events_order_fk" }),
  ],
);

export const offers = pgTable(
  "offers",
  {
    id: idPk(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    driverId: uuid("driver_id").notNull(),
    status: text("status", { enum: OFFER_STATUSES }).notNull().default("pending"),
    expiresAt: timestamptz("expires_at").notNull(), // مصدر الحقيقة للمهلة — لا TTL المفتاح (§6.2)
    respondedAt: timestamptz("responded_at"),
    round: integer("round").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("offers_tenant_order_idx").on(t.tenantId, t.orderId),
    index("offers_tenant_driver_status_idx").on(t.tenantId, t.driverId, t.status),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id], name: "offers_order_fk" }),
    foreignKey({ columns: [t.tenantId, t.driverId], foreignColumns: [drivers.tenantId, drivers.id], name: "offers_driver_fk" }),
  ],
);

// §7 v1.1 — استثناء RLS مسمّى: زائر مجهول بلا tenant، البحث بالتوكن وحده، قراءة فقط
export const trackingTokens = pgTable("tracking_tokens", {
  token: text("token").primaryKey(), // 128-bit عشوائي hex
  tenantId: tenantId(),
  orderId: uuid("order_id").notNull(),
  expiresAt: timestamptz("expires_at").notNull(), // = delivered + ساعة
  createdAt: createdAt(),
});

export const orderAttachments = pgTable(
  "order_attachments",
  {
    id: idPk(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    kind: text("kind", { enum: ATTACHMENT_KINDS }).notNull(),
    objectKey: text("object_key").notNull(), // روابط S3 موقّعة قصيرة العمر (§11)
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("order_attachments_tenant_order_idx").on(t.tenantId, t.orderId),
    foreignKey({ columns: [t.tenantId, t.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_attachments_order_fk" }),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type Offer = typeof offers.$inferSelect;
