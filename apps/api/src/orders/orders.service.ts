import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  NoPricingRuleError,
  createOrder,
  orders,
  quoteForTenant,
  tenants,
  users,
  withTenant,
  type DbHandle,
  type Quote,
} from "@quickdrop/db";
import { ORDER_STATUSES, SERVICES, secretsEqual, type OrderStatus } from "@quickdrop/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import type { ApiEnv } from "../env.js";
import { componentsToStrings, normalizePhoneE164, type PriceComponentStrings } from "./orders.util.js";

// §10.1 D15 — REST شاشة إنشاء الطلب اليدوي (زبون التلفون/الواتساب — النمط الأشيع بالسوق).
// §11: كل مدخل HTTP يمر بـ Zod؛ الرفض 400 برسالة عامة والتفاصيل باللوغ فقط.
// أمان مؤقت: Authorization: Bearer = STAFF_API_TOKEN من env — staff auth الحقيقي
// (جلسات + argon2id §10.2) يُبنى لاحقاً؛ غياب التوكن من env = 503، لا فتح مفتوح.

// —— Zod schemas (§11: الحدود) ——

const slugSchema = z.string().regex(/^[a-z0-9-]{2,32}$/); // نفس قيد provision-tenant

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
}

export interface ListOrdersResponse {
  orders: OrderSummary[];
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
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

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
      const { order, quote } = await createOrder(this.handle.db, tenant.id, {
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

  // استثناء RLS مسمّى (§2.4): البحث بالـ slug قبل معرفة المستأجر — نفس نمط بوابة الـ webhook
  private async resolveActiveTenant(slug: string): Promise<{ id: string }> {
    const rows = await this.handle.db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    const tenant = rows[0];
    if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
      // §11/§14: رسالة عامة — لا نميّز "غير موجود" عن "موقوف" للخارج
      throw new NotFoundException("not found");
    }
    return { id: tenant.id };
  }

  private assertStaffToken(authorization: string | undefined): void {
    const configured = this.env.STAFF_API_TOKEN;
    if (configured === undefined) {
      // إن غاب STAFF_API_TOKEN من env: المسار معطَّل بصوت عالٍ — ممنوع الفتح المفتوح
      throw new ServiceUnavailableException("staff API is not configured");
    }
    const bearer = authorization?.match(/^Bearer\s+(\S+)$/)?.[1];
    if (bearer === undefined || !secretsEqual(bearer, configured)) {
      // §4.1: مقارنة ثابتة الزمن — لا === على أسرار؛ ورسالة عامة (§11)
      throw new UnauthorizedException();
    }
  }

  // §11 — الرفض 400 برسالة عامة؛ التفاصيل (مسارات الحقول بلا قيم — لا PII) باللوغ فقط
  private parseOr400<S extends z.ZodTypeAny>(schema: S, data: unknown, action: string): z.output<S> {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      console.warn(
        JSON.stringify({
          action,
          outcome: "validation_failed",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
        }),
      );
      throw new BadRequestException("invalid request");
    }
    return parsed.data;
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
