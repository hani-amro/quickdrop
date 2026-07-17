import { randomBytes } from "node:crypto";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  createOrder,
  findOrCreateTelegramUser,
  listAvailableCatalog,
  listActiveRestaurants,
  tenants,
  type DbHandle,
} from "@quickdrop/db";
import { makePoint } from "@quickdrop/shared";
import { decryptBotToken, verifyTelegramInitData } from "@quickdrop/telegram";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DB, ENV, REDIS } from "../app.module.js";
import { parseOr400, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";
import { Redis } from "ioredis";

// §10.3 — واجهة الـ Mini App: تحقق initData بتوكن بوت **هذا المستأجر** (منع الانتحال
// العابر للمستأجرين) ← إصدار توكن مجهول قصير العمر بـ Redis (مثل جلسات الطاقم، لا JWT —
// نفس بنية الكود: قابل للإبطال، بلا مفاتيح توقيع) يحمل tenant_id + user_id. كل مسارات
// البيانات محروسة بالتوكن، والمستأجر/الزبون منه لا من الجسم (لا اختيار مستأجر من العميل).

const MINI_TOKEN_PREFIX = "mini:";
const MINI_TOKEN_TTL_S = 900; // §10.3 — 15 دقيقة
const INIT_DATA_MAX_AGE_S = 300; // §10.3 — رفض auth_date أقدم من 5 دقائق

const authBodySchema = z.object({
  tenantSlug: slugSchema,
  initData: z.string().min(1).max(8192),
});

// §10.3 — طلب طعام من التطبيق: المطعم + الأصناف + موقع التسليم (المستأجر/الزبون من التوكن)
const createOrderBodySchema = z.object({
  merchantId: uuidSchema,
  items: z.array(z.object({ catalogItemId: uuidSchema, qty: z.number().int().positive().max(99) })).min(1).max(50),
  dropoff: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }),
  dropoffText: z.string().trim().min(1).max(500).optional(),
});

// §11 — قيمة توكن Redis مدخل خارجي (بنيوياً): تمر بـ Zod عند القراءة
const miniSessionSchema = z.object({ tenantId: z.string().uuid(), userId: z.string().uuid() });

export interface MiniappAuthResponse {
  token: string;
  expiresInSeconds: number;
  user: { id: string; firstName: string | null };
}
export interface MiniappRestaurantsResponse {
  restaurants: { id: string; name: string; point: { lat: number; lng: number }; prepMinutesDefault: number | null }[];
}
export interface MiniappCatalogResponse {
  items: { id: string; nameAr: string; price: string; isAvailable: boolean }[];
}
export interface MiniappOrderResponse {
  order: { id: string; publicCode: string; status: string; priceTotal: string; codAmount: string };
}

@Injectable()
export class MiniappService {
  private readonly masterKey: Buffer;

  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.masterKey = Buffer.from(this.env.MASTER_KEY, "hex");
  }

  // §10.3 — تبادل initData بتوكن جلسة. كل الأخطاء 401 عامة (§11: لا نميّز الأسباب للخارج).
  async auth(body: unknown): Promise<MiniappAuthResponse> {
    const input = parseOr400(authBodySchema, body, "miniapp_auth");
    const rows = await this.handle.db
      .select({ id: tenants.id, status: tenants.status, botTokenEncrypted: tenants.botTokenEncrypted })
      .from(tenants)
      .where(eq(tenants.slug, input.tenantSlug))
      .limit(1);
    const tenant = rows[0];
    if (!tenant || tenant.status === "suspended" || tenant.status === "churned" || !tenant.botTokenEncrypted) {
      throw new UnauthorizedException(); // مستأجر مجهول/موقوف/بلا بوت — رسالة عامة
    }

    const botToken = decryptBotToken(tenant.botTokenEncrypted, this.masterKey);
    const result = verifyTelegramInitData(input.initData, botToken, { maxAgeSeconds: INIT_DATA_MAX_AGE_S });
    if (!result.ok) {
      console.warn(JSON.stringify({ action: "miniapp_auth", outcome: "rejected", reason: result.reason }));
      throw new UnauthorizedException();
    }

    const user = await findOrCreateTelegramUser(
      this.handle.db,
      tenant.id,
      result.user.id,
      result.user.first_name,
    );
    const token = randomBytes(16).toString("hex"); // 128-bit مجهول
    await this.redis.set(
      MINI_TOKEN_PREFIX + token,
      JSON.stringify({ tenantId: tenant.id, userId: user.userId }),
      "EX",
      MINI_TOKEN_TTL_S,
    );
    console.log(JSON.stringify({ action: "miniapp_auth", outcome: "ok", tenant_id: tenant.id }));
    return { token, expiresInSeconds: MINI_TOKEN_TTL_S, user: { id: user.userId, firstName: user.firstName } };
  }

  // §10.3 — حلّ توكن الجلسة → {tenantId, userId}. غياب/فساد/انتهاء = 401.
  private async resolveToken(authorization: string | undefined): Promise<{ tenantId: string; userId: string }> {
    const bearer = authorization?.match(/^Bearer\s+([0-9a-f]{32})$/)?.[1];
    if (bearer === undefined) throw new UnauthorizedException();
    const raw = await this.redis.get(MINI_TOKEN_PREFIX + bearer);
    if (raw === null) throw new UnauthorizedException();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new UnauthorizedException();
    }
    const parsed = miniSessionSchema.safeParse(json);
    if (!parsed.success) throw new UnauthorizedException();
    return parsed.data;
  }

  async restaurants(authorization: string | undefined): Promise<MiniappRestaurantsResponse> {
    const session = await this.resolveToken(authorization);
    const restaurants = await listActiveRestaurants(this.handle.db, session.tenantId);
    return { restaurants };
  }

  async catalog(authorization: string | undefined, merchantId: string): Promise<MiniappCatalogResponse> {
    const session = await this.resolveToken(authorization);
    const id = parseOr400(uuidSchema, merchantId, "miniapp_catalog_id");
    const items = await listAvailableCatalog(this.handle.db, session.tenantId, id);
    return { items: items.map((i) => ({ id: i.id, nameAr: i.nameAr, price: String(i.price), isAvailable: i.isAvailable })) };
  }

  // §10.3 — إنشاء طلب طعام: المستأجر والزبون من التوكن حصراً (لا من الجسم — عزل).
  async createOrder(authorization: string | undefined, body: unknown): Promise<MiniappOrderResponse> {
    const session = await this.resolveToken(authorization);
    const input = parseOr400(createOrderBodySchema, body, "miniapp_order");

    const { order } = await createOrder(this.handle.db, session.tenantId, {
      service: "food",
      customerId: session.userId,
      merchantId: input.merchantId,
      items: input.items,
      pickup: makePoint(0, 0), // مُتجاهَل للطعام (يُشتق من موقع المطعم) لكنه مطلوب بالنوع
      dropoff: makePoint(input.dropoff.lat, input.dropoff.lng),
      ...(input.dropoffText !== undefined ? { dropoffText: input.dropoffText } : {}),
      createdBy: { type: "customer", id: session.userId },
    });
    return {
      order: {
        id: order.id,
        publicCode: order.publicCode,
        status: order.status,
        priceTotal: String(order.priceTotal),
        codAmount: String(order.codAmount),
      },
    };
  }
}
