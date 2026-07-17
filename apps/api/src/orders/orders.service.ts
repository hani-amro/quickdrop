import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  InvalidTransitionError,
  NoPricingRuleError,
  assignManually,
  createOrder,
  drivers,
  merchants,
  offers,
  orderAttachments,
  orderEvents,
  orders,
  quoteForTenant,
  transition,
  users,
  withTenant,
  type DbHandle,
  type Quote,
  type Tx,
} from "@quickdrop/db";
import { createStorageClient, tryLoadStorageConfig, type StorageClient } from "@quickdrop/storage";
import {
  ORDER_STATUSES,
  SERVICES,
  type OfferStatus,
  type OrderActorType,
  type OrderStatus,
  type ScheduledOrderJob,
  type Service,
} from "@quickdrop/shared";
import { Queue } from "bullmq";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { DB, ENV, SCHEDULED_Q } from "../app.module.js";
import {
  assertStaffToken,
  parseOr400,
  resolveActiveTenant,
  slugSchema,
  uuidSchema,
  type ActiveTenant,
} from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";
import {
  PROMISE_MARGIN_MINUTES,
  componentsToStrings,
  computePromisedAt,
  normalizePhoneE164,
  type PriceComponentStrings,
} from "./orders.util.js";

// §10.1 D15 — REST شاشة إنشاء الطلب اليدوي (زبون التلفون/الواتساب — النمط الأشيع بالسوق).
// §11: كل مدخل HTTP يمر بـ Zod؛ الرفض 400 برسالة عامة والتفاصيل باللوغ فقط.
// أمان مؤقت: Authorization: Bearer = STAFF_API_TOKEN من env — staff auth الحقيقي
// (جلسات + argon2id §10.2) يُبنى لاحقاً؛ غياب التوكن من env = 503، لا فتح مفتوح.

// —— Zod schemas (§11: الحدود) —— slugSchema/uuidSchema مشتركة من common/staff-http

const pointSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

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

// D5 — المال بالـ JSON سلسلة أرقام عشرية (bigint↔string عند الحافة؛ لا أرقام JSON للمال)
const moneyStringSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform((s) => BigInt(s));

const weightGSchema = z.number().int().positive().max(1_000_000); // غرام؛ سقف منطقي 1 طن

// D6 — ISO 8601 مع إزاحة صريحة؛ يُخزَّن UTC. طلب مجدول = موعد مستقبلي (§5)
const scheduledAtSchema = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() > Date.now(), { message: "scheduledAt must be in the future" });

const quoteBodySchema = z.object({
  tenantSlug: slugSchema,
  service: z.enum(SERVICES),
  pickup: pointSchema,
  dropoff: pointSchema,
  weightG: weightGSchema.optional(),
});

const createBodySchema = z.object({
  tenantSlug: slugSchema,
  service: z.enum(SERVICES),
  customerPhone: phoneSchema,
  customerName: z.string().trim().min(1).max(120).optional(),
  pickup: pointSchema,
  dropoff: pointSchema,
  dropoffText: z.string().trim().min(1).max(500).optional(),
  recipientPhone: phoneSchema.optional(), // الطلب لشخص آخر (الفخ 16)
  weightG: weightGSchema.optional(),
  goodsAmount: moneyStringSchema.optional(),
  notes: z.string().trim().min(1).max(1000).optional(),
  scheduledAt: scheduledAtSchema.optional(),
});

// query strings: قيمة فارغة = غير مُرسلة
const listQuerySchema = z.object({
  tenantSlug: slugSchema,
  status: z.preprocess((v) => (v === "" ? undefined : v), z.enum(ORDER_STATUSES).optional()),
});

const detailQuerySchema = z.object({ tenantSlug: slugSchema });

const confirmBodySchema = z.object({ tenantSlug: slugSchema });

// §5 — إلغاء المكتب بسبب مسمّى إلزاماً (يُسجَّل بـ order_events.meta وعمود cancel_reason)
const cancelBodySchema = z.object({
  tenantSlug: slugSchema,
  reason: z.string().trim().min(2).max(500),
});

const assignBodySchema = z.object({
  tenantSlug: slugSchema,
  driverId: uuidSchema,
});

const merchantConfirmBodySchema = z.object({ tenantSlug: slugSchema });

// —— أشكال الاستجابة (كل مال string — D5) ——

export interface QuoteResponse {
  components: PriceComponentStrings;
  distanceM: number;
  durationS: number;
}

export interface OrderSummary {
  id: string;
  publicCode: string;
  status: OrderStatus;
  priceTotal: string;
  createdAt: string;
}

export interface CreateOrderResponse {
  order: {
    id: string;
    publicCode: string;
    status: OrderStatus;
    priceTotal: string;
    codAmount: string;
    createdAt: string;
  };
  quote: QuoteResponse;
  // §7 — رابط التتبع العام /t/{token}: يُملى هاتفياً أو يُرسَل بأي قناة (D15 — زبون التلفون)
  trackingToken: string;
}

export interface ListOrdersResponse {
  orders: OrderSummary[];
}

// §3 — order_events سجل append-only: عرض للتدقيق باللوحة الجانبية
export interface OrderEventView {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: OrderActorType;
  actorId: string | null;
  meta: unknown;
  createdAt: string;
}

// §6.2 — عرض جولة الإسناد الحالية (الموزّع يرى من عُرض عليه وماذا رد)
export interface OfferView {
  id: string;
  driverId: string;
  driverName: string | null;
  status: OfferStatus;
  round: number;
  expiresAt: string;
  respondedAt: string | null;
  createdAt: string;
}

// §10.1 — تفاصيل اللوحة الجانبية: الطلب + آخر 20 حدثاً + عروض الجولة الحالية
export interface OrderDetailResponse {
  order: {
    id: string;
    publicCode: string;
    service: Service;
    status: OrderStatus;
    customer: { name: string | null; phone: string | null };
    driver: { id: string; name: string | null } | null;
    merchant: { name: string; phone: string | null } | null; // §3 v1
    merchantConfirmedAt: string | null;
    pickupText: string | null;
    dropoffText: string | null;
    recipientPhone: string | null;
    notes: string | null;
    weightG: number | null;
    distanceM: number | null;
    routeDurationS: number | null;
    price: PriceComponentStrings; // D5: كل مال string
    goodsAmount: string;
    codAmount: string;
    codReceived: string | null;
    cancelReason: string | null;
    failedReason: string | null;
    scheduledAt: string | null;
    promisedAt: string | null;
    deliveredAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  events: OrderEventView[];
  currentRoundOffers: OfferView[];
  attachments: OrderAttachmentView[]; // §11 — إثبات التسليم (روابط موقّعة قصيرة العمر)
}

export interface OrderAttachmentView {
  id: string;
  kind: string;
  createdAt: string;
  /** §11 — رابط GET موقّع قصير العمر؛ null إن لم يُهيَّأ التخزين (بلا S3). */
  url: string | null;
}

export interface ConfirmOrderResponse {
  order: { id: string; publicCode: string; status: OrderStatus; promisedAt: string | null };
}

export interface CancelOrderResponse {
  order: { id: string; publicCode: string; status: OrderStatus; cancelReason: string };
}

export interface AssignOrderResponse {
  order: { id: string; status: OrderStatus; driverId: string };
}

export interface MerchantConfirmResponse {
  order: { id: string; publicCode: string; merchantConfirmedAt: string };
}

function toQuoteResponse(quote: Quote): QuoteResponse {
  return {
    components: componentsToStrings(quote.components),
    distanceM: quote.distanceM,
    durationS: quote.durationS,
  };
}

@Injectable()
export class OrdersService {
  // §11 — عميل تخزين المرفقات (S3/MinIO)؛ null إن لم يُهيَّأ S3 (تدهور لطيف: مرفقات بلا روابط)
  private readonly storage: StorageClient | null;

  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(SCHEDULED_Q) private readonly scheduledQueue: Queue<ScheduledOrderJob>,
  ) {
    const cfg = tryLoadStorageConfig(process.env);
    this.storage = cfg !== null ? createStorageClient(cfg) : null;
  }

  /** §11 — TTL روابط إثبات التسليم الموقّعة: 5 دقائق تكفي للعرض ولا تسرّب وصولاً دائماً. */
  private static readonly POD_URL_TTL_S = 300;

  // §4.4 — عرض السعر قبل الحفظ: الداشبورد تستدعي quote ثم تعرض التفصيل ثم create
  async quote(authorization: string | undefined, body: unknown): Promise<QuoteResponse> {
    this.assertStaffToken(authorization);
    const input = this.parseOr400(quoteBodySchema, body, "orders_quote");
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    try {
      const quote = await quoteForTenant(this.handle.db, tenant.id, {
        service: input.service,
        pickup: input.pickup,
        dropoff: input.dropoff,
        // exactOptionalPropertyTypes: لا نمرّر undefined صريحاً
        ...(input.weightG !== undefined ? { weightG: input.weightG } : {}),
      });
      return toQuoteResponse(quote);
    } catch (error) {
      throw this.mapPricingError(error);
    }
  }

  // D15 — إنشاء يدوي: ابحث/أنشئ الزبون بالهاتف ثم createOrder بفاعل staff
  async create(authorization: string | undefined, body: unknown): Promise<CreateOrderResponse> {
    this.assertStaffToken(authorization);
    const input = this.parseOr400(createBodySchema, body, "orders_create");
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const customerId = await this.findOrCreateCustomer(tenant.id, input.customerPhone, input.customerName);

    try {
      const { order, quote, trackingToken } = await createOrder(this.handle.db, tenant.id, {
        service: input.service,
        customerId,
        pickup: input.pickup,
        dropoff: input.dropoff,
        ...(input.dropoffText !== undefined ? { dropoffText: input.dropoffText } : {}),
        ...(input.recipientPhone !== undefined ? { recipientPhone: input.recipientPhone } : {}),
        ...(input.weightG !== undefined ? { weightG: input.weightG } : {}),
        ...(input.goodsAmount !== undefined ? { goodsAmount: input.goodsAmount } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
        // أمان مؤقت: لا هوية موظف مع التوكن الثابت — actor.id يُملأ مع staff auth §10.2
        createdBy: { type: "staff" },
      });

      // §6.3 — طلب بموعد مستقبلي (status='scheduled'): ادفع مهمة مؤجّلة تطلقه عند الموعد.
      // jobId حتمي = 'sched:{orderId}' → idempotent مع إعادة جدولة الـ worker عند الإقلاع.
      if (order.status === "scheduled" && input.scheduledAt !== undefined) {
        await this.scheduledQueue.add(
          "fire-scheduled",
          { tenantId: tenant.id, orderId: order.id },
          {
            jobId: `sched:${order.id}`,
            delay: Math.max(0, input.scheduledAt.getTime() - Date.now()),
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: { count: 1000 },
          },
        );
      }

      // §13: لوغ منظّم بحقول ثابتة — بلا PII (لا هاتف ولا اسم)
      console.log(
        JSON.stringify({
          action: "order_created",
          tenant_id: tenant.id,
          order_id: order.id,
          actor: "staff",
          status: order.status,
        }),
      );
      return {
        order: {
          id: order.id,
          publicCode: order.publicCode,
          status: order.status,
          priceTotal: String(order.priceTotal),
          codAmount: String(order.codAmount),
          createdAt: order.createdAt.toISOString(),
        },
        quote: toQuoteResponse(quote),
        trackingToken, // §7 — التوكن لا يُسجَّل باللوغ: سر قصير العمر بيد الزبون فقط
      };
    } catch (error) {
      throw this.mapPricingError(error);
    }
  }

  // §10.1 — قائمة مختصرة بترقيم من الخادم: LIMIT 50 الأحدث أولاً؛ ممنوع SELECT *
  async list(authorization: string | undefined, query: unknown): Promise<ListOrdersResponse> {
    this.assertStaffToken(authorization);
    const input = this.parseOr400(listQuerySchema, query, "orders_list");
    const tenant = await this.resolveActiveTenant(input.tenantSlug);

    const conditions = [eq(orders.tenantId, tenant.id), isNull(orders.deletedAt)]; // D10: soft delete لا يظهر
    if (input.status !== undefined) {
      conditions.push(eq(orders.status, input.status));
    }

    const rows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({
          id: orders.id,
          publicCode: orders.publicCode,
          status: orders.status,
          priceTotal: orders.priceTotal,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(and(...conditions))
        .orderBy(desc(orders.createdAt)) // فهرس (tenant_id, created_at)
        .limit(50),
    );

    return {
      orders: rows.map((r) => ({
        id: r.id,
        publicCode: r.publicCode,
        status: r.status,
        priceTotal: String(r.priceTotal), // D5: bigint→string عند الحافة
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  // §10.1 — تفاصيل الطلب للوحة الجانبية. §16.10: لا N+1 — ثلاث قوائم = ثلاثة
  // استعلامات مسطّحة (join واحد لكل قائمة) داخل ترانزاكشن واحدة (لقطة متسقة).
  async detail(authorization: string | undefined, id: string, query: unknown): Promise<OrderDetailResponse> {
    this.assertStaffToken(authorization);
    const orderId = this.parseOr400(uuidSchema, id, "orders_detail_id");
    const input = this.parseOr400(detailQuerySchema, query, "orders_detail");
    const tenant = await this.resolveActiveTenant(input.tenantSlug);

    // اسم السائق يمر بجدول users مرة ثانية (drivers.user_id) — alias إلزامي
    const driverUsers = alias(users, "driver_users");

    return withTenant(this.handle.db, tenant.id, async (tx) => {
      const orderRows = await tx
        .select({
          id: orders.id,
          publicCode: orders.publicCode,
          service: orders.service,
          status: orders.status,
          driverId: orders.driverId,
          pickupText: orders.pickupText,
          dropoffText: orders.dropoffText,
          recipientPhone: orders.recipientPhone,
          notes: orders.notes,
          weightG: orders.weightG,
          distanceM: orders.distanceM,
          routeDurationS: orders.routeDurationS,
          priceBase: orders.priceBase,
          priceDistance: orders.priceDistance,
          priceWeight: orders.priceWeight,
          priceSurge: orders.priceSurge,
          priceMinAdjustment: orders.priceMinAdjustment,
          priceDiscount: orders.priceDiscount,
          priceTotal: orders.priceTotal,
          goodsAmount: orders.goodsAmount,
          codAmount: orders.codAmount,
          codReceived: orders.codReceived,
          cancelReason: orders.cancelReason,
          failedReason: orders.failedReason,
          scheduledAt: orders.scheduledAt,
          promisedAt: orders.promisedAt,
          deliveredAt: orders.deliveredAt,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
          customerName: users.firstName,
          customerPhone: users.phoneE164,
          driverName: driverUsers.firstName,
          merchantConfirmedAt: orders.merchantConfirmedAt, // §3 v1
          merchantName: merchants.name,
          merchantPhone: merchants.phone, // §3 — الموزّع يتصل بالتاجر
        })
        .from(orders)
        .innerJoin(users, and(eq(users.tenantId, orders.tenantId), eq(users.id, orders.customerId)))
        .leftJoin(drivers, and(eq(drivers.tenantId, orders.tenantId), eq(drivers.id, orders.driverId)))
        .leftJoin(driverUsers, and(eq(driverUsers.tenantId, orders.tenantId), eq(driverUsers.id, drivers.userId)))
        .leftJoin(merchants, and(eq(merchants.tenantId, orders.tenantId), eq(merchants.id, orders.merchantId)))
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt))) // D10: soft delete لا يظهر
        .limit(1);
      const row = orderRows[0];
      if (!row) {
        throw new NotFoundException("not found"); // §11: رسالة عامة
      }

      // آخر 20 حدثاً — الأحدث أولاً؛ فهرس (tenant_id, order_id)
      const eventRows = await tx
        .select({
          id: orderEvents.id,
          fromStatus: orderEvents.fromStatus,
          toStatus: orderEvents.toStatus,
          actorType: orderEvents.actorType,
          actorId: orderEvents.actorId,
          meta: orderEvents.meta,
          createdAt: orderEvents.createdAt,
        })
        .from(orderEvents)
        .where(eq(orderEvents.orderId, orderId))
        .orderBy(desc(orderEvents.createdAt))
        .limit(20);

      // عروض الجولة الحالية (= أعلى round للطلب) مع اسم السائق — استعلام واحد §16.10
      const offerRows = await tx
        .select({
          id: offers.id,
          driverId: offers.driverId,
          driverName: users.firstName,
          status: offers.status,
          round: offers.round,
          expiresAt: offers.expiresAt,
          respondedAt: offers.respondedAt,
          createdAt: offers.createdAt,
        })
        .from(offers)
        .innerJoin(drivers, and(eq(drivers.tenantId, offers.tenantId), eq(drivers.id, offers.driverId)))
        .innerJoin(users, and(eq(users.tenantId, drivers.tenantId), eq(users.id, drivers.userId)))
        .where(
          and(
            eq(offers.orderId, orderId),
            sql`${offers.round} = (SELECT max(o2.round) FROM offers o2 WHERE o2.tenant_id = ${offers.tenantId} AND o2.order_id = ${offers.orderId})`,
          ),
        )
        .orderBy(desc(offers.createdAt));

      // §11 — مرفقات إثبات التسليم + روابط GET موقّعة قصيرة العمر (بلا فتح البكت)
      const attachmentRows = await tx
        .select({
          id: orderAttachments.id,
          kind: orderAttachments.kind,
          objectKey: orderAttachments.objectKey,
          createdAt: orderAttachments.createdAt,
        })
        .from(orderAttachments)
        .where(eq(orderAttachments.orderId, orderId))
        .orderBy(desc(orderAttachments.createdAt));
      const attachments: OrderAttachmentView[] = await Promise.all(
        attachmentRows.map(async (a) => ({
          id: a.id,
          kind: a.kind,
          createdAt: a.createdAt.toISOString(),
          url: this.storage !== null ? await this.storage.getSignedGetUrl(a.objectKey, OrdersService.POD_URL_TTL_S) : null,
        })),
      );

      return {
        order: {
          id: row.id,
          publicCode: row.publicCode,
          service: row.service,
          status: row.status,
          customer: { name: row.customerName, phone: row.customerPhone },
          driver: row.driverId !== null ? { id: row.driverId, name: row.driverName } : null,
          merchant: row.merchantName !== null ? { name: row.merchantName, phone: row.merchantPhone } : null,
          merchantConfirmedAt: row.merchantConfirmedAt?.toISOString() ?? null,
          pickupText: row.pickupText,
          dropoffText: row.dropoffText,
          recipientPhone: row.recipientPhone,
          notes: row.notes,
          weightG: row.weightG,
          distanceM: row.distanceM,
          routeDurationS: row.routeDurationS,
          // D5: bigint→string عند حافة الـ JSON — نفس محوّل quote (مصدر واحد)
          price: componentsToStrings({
            base: row.priceBase,
            distance: row.priceDistance,
            weight: row.priceWeight,
            surge: row.priceSurge,
            minAdjustment: row.priceMinAdjustment,
            discount: row.priceDiscount,
            total: row.priceTotal,
          }),
          goodsAmount: String(row.goodsAmount),
          codAmount: String(row.codAmount),
          codReceived: row.codReceived !== null ? String(row.codReceived) : null,
          cancelReason: row.cancelReason,
          failedReason: row.failedReason,
          scheduledAt: row.scheduledAt?.toISOString() ?? null,
          promisedAt: row.promisedAt?.toISOString() ?? null,
          deliveredAt: row.deliveredAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
        events: eventRows.map((e) => ({
          id: e.id,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          actorType: e.actorType,
          actorId: e.actorId,
          meta: e.meta,
          createdAt: e.createdAt.toISOString(),
        })),
        currentRoundOffers: offerRows.map((o) => ({
          id: o.id,
          driverId: o.driverId,
          driverName: o.driverName,
          status: o.status,
          round: o.round,
          expiresAt: o.expiresAt.toISOString(),
          respondedAt: o.respondedAt?.toISOString() ?? null,
          createdAt: o.createdAt.toISOString(),
        })),
        attachments,
      };
    });
  }

  // §5/§7 — تأكيد المكتب: transition(confirmed بفاعل staff) وبنفس الترانزاكشن
  // لقطة الوعد promised_at (WHERE promised_at IS NULL — لا تُعاد كتابتها أبداً).
  async confirm(authorization: string | undefined, id: string, body: unknown): Promise<ConfirmOrderResponse> {
    this.assertStaffToken(authorization);
    const orderId = this.parseOr400(uuidSchema, id, "orders_confirm_id");
    const input = this.parseOr400(confirmBodySchema, body, "orders_confirm");
    const tenant = await this.resolveActiveTenant(input.tenantSlug);

    try {
      const result = await withTenant(this.handle.db, tenant.id, async (tx) => {
        // 404 لمعرّف غير موجود قبل transition — transition ترمي Error عاماً (باغ داخلي)
        // بينما المعرّف هنا مدخل مستخدم = حالة عمل (D10: المحذوف ناعماً غير موجود).
        await this.assertOrderExists(tx, orderId);

        // D8 — عبر transition() حصراً: تكتب order_events + outbox بنفس الترانزاكشن
        const order = await transition(tx, { orderId, to: "confirmed", actor: { type: "staff" } });

        // §7 — لقطة الوعد: now + المدة × eta_correction_bp/10000 + هامش 10 دقائق.
        // eta_correction_bp من tenants (استثناء RLS مسمّى — جاء مع resolveActiveTenant).
        // routeDurationS يُحسب دائماً عند الإنشاء؛ ?? 0 حارس دفاعي (طلب بلا مسار →
        // الوعد = الهامش وحده، أفضل من فشل التأكيد كله).
        const promisedAt = computePromisedAt(
          new Date(), // D6: UTC
          order.routeDurationS ?? 0,
          tenant.etaCorrectionBp,
          PROMISE_MARGIN_MINUTES,
        );
        const updated = await tx
          .update(orders)
          .set({ promisedAt, updatedAt: new Date() })
          .where(and(eq(orders.id, orderId), isNull(orders.promisedAt))) // لقطة — لا كتابة فوق موجود
          .returning({ promisedAt: orders.promisedAt });

        // صفر صفوف = الوعد مثبَّت سلفاً (لا يحدث بمسار v1 لكن العقد "لا تُعاد كتابتها")
        return { order, promisedAt: updated[0]?.promisedAt ?? order.promisedAt };
      });

      // §13: لوغ منظّم بحقول ثابتة — بلا PII
      console.log(
        JSON.stringify({
          action: "order_confirmed",
          tenant_id: tenant.id,
          order_id: result.order.id,
          actor: "staff",
          status: result.order.status,
        }),
      );

      return {
        order: {
          id: result.order.id,
          publicCode: result.order.publicCode,
          status: result.order.status,
          promisedAt: result.promisedAt?.toISOString() ?? null,
        },
      };
    } catch (error) {
      throw this.mapTransitionError(error);
    }
  }

  // §5 — إلغاء المكتب: transition(cancelled_by_office بفاعل staff، السبب بالـ meta)
  // + بنفس الترانزاكشن UPDATE cancel_reason (عمود عادي، ليس حالة).
  async cancel(authorization: string | undefined, id: string, body: unknown): Promise<CancelOrderResponse> {
    this.assertStaffToken(authorization);
    const orderId = this.parseOr400(uuidSchema, id, "orders_cancel_id");
    const input = this.parseOr400(cancelBodySchema, body, "orders_cancel");
    const tenant = await this.resolveActiveTenant(input.tenantSlug);

    try {
      const order = await withTenant(this.handle.db, tenant.id, async (tx) => {
        await this.assertOrderExists(tx, orderId);
        const updatedOrder = await transition(tx, {
          orderId,
          to: "cancelled_by_office",
          actor: { type: "staff" },
          meta: { reason: input.reason }, // §3: order_events يحمل السبب للتدقيق
        });
        await tx
          .update(orders)
          .set({ cancelReason: input.reason, updatedAt: new Date() })
          .where(eq(orders.id, orderId));
        return updatedOrder;
      });

      // §13 — بلا السبب باللوغ: نص حر قد يحمل PII؛ محفوظ بالقاعدة للتدقيق
      console.log(
        JSON.stringify({
          action: "order_cancelled_by_office",
          tenant_id: tenant.id,
          order_id: order.id,
          actor: "staff",
          status: order.status,
        }),
      );

      return {
        order: {
          id: order.id,
          publicCode: order.publicCode,
          status: order.status,
          cancelReason: input.reason,
        },
      };
    } catch (error) {
      throw this.mapTransitionError(error);
    }
  }

  // §10.1 — الإسناد اليدوي: القرار كله داخل ترانزاكشن assignManually (D16: أقفال
  // بالقاعدة، packages/db/src/dispatch.ts)؛ هنا فقط ترجمة النتيجة إلى HTTP —
  // Optimistic UI بالداشبورد يتراجع صراحةً على أي 4xx (§10.1)، والرسائل عامة (§11).
  async assign(authorization: string | undefined, id: string, body: unknown): Promise<AssignOrderResponse> {
    this.assertStaffToken(authorization);
    const orderId = this.parseOr400(uuidSchema, id, "orders_assign_id");
    const input = this.parseOr400(assignBodySchema, body, "orders_assign");
    const tenant = await this.resolveActiveTenant(input.tenantSlug);

    // أمان مؤقت: لا هوية موظف مع التوكن الثابت — staffId يُملأ مع staff auth §10.2
    const result = await assignManually(this.handle.db, tenant.id, orderId, input.driverId);
    switch (result.outcome) {
      case "accepted":
      case "already_yours": {
        // already_yours = مُسند لهذا السائق أصلاً: نجاح idempotent (§16.7 — ضغطة مكررة)
        console.log(
          JSON.stringify({
            action: "order_assigned_manually",
            tenant_id: tenant.id,
            order_id: orderId,
            actor: "staff",
            driver_id: input.driverId,
            outcome: result.outcome,
          }),
        );
        return { order: { id: orderId, status: "assigned", driverId: input.driverId } };
      }
      case "taken":
        // مُسند لسائق آخر (سباق مع قبول/dispatch) — 409 والداشبورد تحدّث اللوحة
        throw new ConflictException("order is already assigned");
      case "expired":
        // حالة الطلب لا تسمح، أو السائق بلا وردية/سعة (D14) — رسالة عامة §11
        throw new ConflictException("order or driver is not assignable right now");
      case "not_found":
        throw new NotFoundException("not found");
    }
  }

  // §3 v1 — تأكيد التاجر: عمود عادي (merchant_confirmed_at) لا حالة — لا يمسّ transition/D8.
  // ذو معنى لطلبات food مع merchant_id؛ يُملأ مرة واحدة (IS NULL شرط). 409 لغير المؤهل.
  async merchantConfirm(authorization: string | undefined, id: string, body: unknown): Promise<MerchantConfirmResponse> {
    this.assertStaffToken(authorization);
    const orderId = this.parseOr400(uuidSchema, id, "orders_merchant_confirm_id");
    const input = this.parseOr400(merchantConfirmBodySchema, body, "orders_merchant_confirm");
    const tenant = await this.resolveActiveTenant(input.tenantSlug);

    const result = await withTenant(this.handle.db, tenant.id, async (tx) => {
      const rows = await tx
        .update(orders)
        .set({ merchantConfirmedAt: new Date(), updatedAt: new Date() }) // D6: UTC
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.service, "food"),
            isNull(orders.merchantConfirmedAt), // يُملأ مرة واحدة
            isNull(orders.deletedAt),
          ),
        )
        .returning({ publicCode: orders.publicCode, merchantConfirmedAt: orders.merchantConfirmedAt });
      return rows[0];
    });

    if (!result || result.merchantConfirmedAt === null) {
      // لم يُحدَّث صف: غير موجود، أو ليس food، أو مؤكَّد سلفاً — نميّز 404 عن 409
      const exists = await withTenant(this.handle.db, tenant.id, (tx) =>
        tx.select({ id: orders.id }).from(orders).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).limit(1),
      );
      if (exists.length === 0) throw new NotFoundException("not found");
      throw new ConflictException("order is not a pending food order"); // §11 رسالة عامة
    }

    console.log(
      JSON.stringify({ action: "order_merchant_confirmed", tenant_id: tenant.id, order_id: orderId, actor: "staff" }),
    );
    return { order: { id: orderId, publicCode: result.publicCode, merchantConfirmedAt: result.merchantConfirmedAt.toISOString() } };
  }

  // D15 — البحث بفهرس (tenant_id, phone_e164) ضمن دور customer؛ غير موجود = إنشاء
  // بـ telegram_user_id NULL (زبون تلفون). سباق إنشاء متزامن لنفس الرقم قد يخلق
  // صفين (لا قيد فريد على الهاتف) — مقبول بشاشة يدوية؛ الدمج قرار تشغيلي لاحق.
  private async findOrCreateCustomer(tenantId: string, phoneE164: string, firstName?: string): Promise<string> {
    return withTenant(this.handle.db, tenantId, async (tx) => {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.phoneE164, phoneE164), eq(users.role, "customer")))
        .orderBy(users.createdAt) // حتمية الاختيار: الأقدم
        .limit(1);
      const found = existing[0];
      if (found) return found.id;

      const inserted = await tx
        .insert(users)
        .values({
          tenantId,
          role: "customer",
          phoneE164,
          telegramUserId: null, // D15: زبون تلفون بلا تيليغرام
          ...(firstName !== undefined ? { firstName } : {}),
        })
        .returning({ id: users.id });
      const row = inserted[0];
      if (!row) {
        // §16.12 — لا ابتلاع أخطاء
        throw new Error("findOrCreateCustomer: INSERT users ... RETURNING returned no row");
      }
      return row.id;
    });
  }

  // استثناء RLS مسمّى (§2.4) — التنفيذ المشترك بـ common/staff-http (يعيد أيضاً
  // eta_correction_bp للقطة الوعد §7)
  private resolveActiveTenant(slug: string): Promise<ActiveTenant> {
    return resolveActiveTenant(this.handle.db, slug);
  }

  // التخويل المؤقت المشترك (Bearer STAFF_API_TOKEN) — common/staff-http
  private assertStaffToken(authorization: string | undefined): void {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
  }

  // §11 — الرفض 400 برسالة عامة — common/staff-http
  private parseOr400<S extends z.ZodTypeAny>(schema: S, data: unknown, action: string): z.output<S> {
    return parseOr400(schema, data, action);
  }

  // معرّف من المستخدم: غير موجود (أو محذوف ناعماً D10) = 404 حالة عمل، لا باغ.
  // قراءة بلا قفل — transition تعيد القراءة FOR UPDATE وتحسم السباقات (§5).
  private async assertOrderExists(tx: Tx, orderId: string): Promise<void> {
    const existing = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);
    if (!existing[0]) {
      throw new NotFoundException("not found"); // الرمي داخل الترانزاكشن = rollback نظيف
    }
  }

  // §5 — انتقال غير مسموح (تأكيد مؤكَّد، إلغاء بعد الإسناد...) = تعارض حالة (409)
  // برسالة عامة؛ أي خطأ آخر يُعاد رميه كما هو — §16.12: لا ابتلاع.
  private mapTransitionError(error: unknown): unknown {
    if (error instanceof InvalidTransitionError) {
      return new ConflictException("order state does not allow this action");
    }
    return error;
  }

  // لا قاعدة تسعير فعّالة للخدمة/المنطقة (§3 pricing_rules) — خطأ أعمال مفهوم للداشبورد
  // (422)، وليس 500؛ أي خطأ آخر يُعاد رميه كما هو — §16.12: لا ابتلاع.
  private mapPricingError(error: unknown): unknown {
    if (error instanceof NoPricingRuleError) {
      return new UnprocessableEntityException("no active pricing rule matches this service/area");
    }
    return error;
  }
}
