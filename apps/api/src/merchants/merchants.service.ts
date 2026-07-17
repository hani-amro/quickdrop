import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  CatalogItemNotFoundError,
  MerchantNotFoundError,
  createMerchant,
  listCatalog,
  listMerchants,
  setItemAvailability,
  upsertCatalogItem,
  type CatalogItemView,
  type DbHandle,
  type MerchantView,
} from "@quickdrop/db";
import { MERCHANT_CATEGORIES, type MerchantCategory } from "@quickdrop/shared";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";
import { normalizePhoneE164 } from "../orders/orders.util.js";

// §3 — إدارة التجار وكتالوجهم من الداشبورد (شاشة المطاعم):
//   GET  /api/merchants                                 : قائمة التجار
//   POST /api/merchants                                 : إنشاء تاجر (نقطة على الخريطة)
//   GET  /api/merchants/:id/catalog                     : أصناف مطعم
//   POST /api/merchants/:id/catalog                     : إنشاء/تحديث صنف
//   POST /api/merchants/:id/catalog/:itemId/availability: قلب توفّر صنف
// نفس التخويل المؤقت (Bearer STAFF_API_TOKEN — §10.2 جلسة عبر الحارس) وانضباط Zod (§11)
// وحلّ المستأجر بالـ slug — نمط orders/drivers حرفياً. المال يعبر الـ JSON string (D5).

// —— Zod schemas (§11: الحدود) ——

const listQuerySchema = z.object({ tenantSlug: slugSchema });

const pointSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

// نفس تطبيع E.164 لشاشة الطلب اليدوي والسائقين (مصدر واحد — orders.util)
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

// D5 — المال بالـ JSON سلسلة أرقام صحيحة (لا أرقام JSON للمال)؛ bigint↔string عند الحافة
const moneyStringSchema = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform((s) => BigInt(s));

const createMerchantBodySchema = z.object({
  tenantSlug: slugSchema,
  name: z.string().trim().min(1).max(120),
  category: z.enum(MERCHANT_CATEGORIES),
  point: pointSchema,
  phone: phoneSchema.optional(),
  prepMinutesDefault: z.number().int().positive().max(600).optional(), // دقائق تحضير منطقية ≤ 10 ساعات
});

const upsertItemBodySchema = z.object({
  tenantSlug: slugSchema,
  id: uuidSchema.optional(), // موجود = تحديث؛ غائب = إنشاء
  nameAr: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200).optional(),
  price: moneyStringSchema, // D5
  sortOrder: z.number().int().gte(0).max(100000).optional(),
});

const availabilityBodySchema = z.object({
  tenantSlug: slugSchema,
  isAvailable: z.boolean(),
});

// —— أشكال الاستجابة (كل مال string — D5) ——

export interface MerchantResponseView {
  id: string;
  name: string;
  phone: string | null;
  category: MerchantCategory;
  isActive: boolean;
  prepMinutesDefault: number | null;
  point: { lat: number; lng: number }; // الفخ 6: نقطة واحدة
  createdAt: string;
}

export interface CatalogItemResponseView {
  id: string;
  merchantId: string;
  nameAr: string;
  nameEn: string | null;
  price: string; // D5: bigint→string عند الحافة
  isAvailable: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface ListMerchantsResponse {
  merchants: MerchantResponseView[];
}

export interface CreateMerchantResponse {
  merchant: MerchantResponseView;
}

export interface ListCatalogResponse {
  items: CatalogItemResponseView[];
}

export interface CatalogItemResponse {
  item: CatalogItemResponseView;
}

function toMerchantResponse(m: MerchantView): MerchantResponseView {
  return {
    id: m.id,
    name: m.name,
    phone: m.phone,
    category: m.category,
    isActive: m.isActive,
    prepMinutesDefault: m.prepMinutesDefault,
    point: { lat: m.point.lat, lng: m.point.lng },
    createdAt: m.createdAt.toISOString(), // D6: ISO 8601
  };
}

function toCatalogItemResponse(i: CatalogItemView): CatalogItemResponseView {
  return {
    id: i.id,
    merchantId: i.merchantId,
    nameAr: i.nameAr,
    nameEn: i.nameEn,
    price: String(i.price), // D5: bigint→string
    isAvailable: i.isAvailable,
    sortOrder: i.sortOrder,
    createdAt: i.createdAt.toISOString(),
  };
}

@Injectable()
export class MerchantsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  // §3 — قائمة التجار (المطاعم/المحال) للمستأجر.
  async list(authorization: string | undefined, query: unknown): Promise<ListMerchantsResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(listQuerySchema, query, "merchants_list");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const merchants = await listMerchants(this.handle.db, tenant.id);
    return { merchants: merchants.map(toMerchantResponse) };
  }

  // §3 — إنشاء تاجر بنقطة موقع تُختار على الخريطة (D7 — WKT بترتيب lng lat بطبقة القاعدة).
  async create(authorization: string | undefined, body: unknown): Promise<CreateMerchantResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(createMerchantBodySchema, body, "merchants_create");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const merchant = await createMerchant(this.handle.db, tenant.id, {
      name: input.name,
      category: input.category,
      point: input.point,
      // exactOptionalPropertyTypes: لا نمرّر undefined صريحاً
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.prepMinutesDefault !== undefined ? { prepMinutesDefault: input.prepMinutesDefault } : {}),
    });

    // §13 — لوغ منظّم بحقول ثابتة بلا PII (لا هاتف)
    console.log(
      JSON.stringify({
        action: "merchant_created",
        tenant_id: tenant.id,
        merchant_id: merchant.id,
        category: merchant.category,
        actor: "staff",
      }),
    );
    return { merchant: toMerchantResponse(merchant) };
  }

  // §3 — أصناف كتالوج مطعم.
  async listCatalog(authorization: string | undefined, id: string, query: unknown): Promise<ListCatalogResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const merchantId = parseOr400(uuidSchema, id, "merchants_catalog_id");
    const input = parseOr400(listQuerySchema, query, "merchants_catalog_list");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const items = await listCatalog(this.handle.db, tenant.id, merchantId);
    return { items: items.map(toCatalogItemResponse) };
  }

  // §3 — إنشاء/تحديث صنف كتالوج (merchantId من المسار، لا من الجسم). المال string→bigint (D5).
  async upsertCatalogItem(
    authorization: string | undefined,
    id: string,
    body: unknown,
  ): Promise<CatalogItemResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const merchantId = parseOr400(uuidSchema, id, "merchants_catalog_upsert_id");
    const input = parseOr400(upsertItemBodySchema, body, "merchants_catalog_upsert");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    try {
      const item = await upsertCatalogItem(this.handle.db, tenant.id, {
        merchantId,
        nameAr: input.nameAr,
        price: input.price,
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      });
      console.log(
        JSON.stringify({
          action: "catalog_item_upserted",
          tenant_id: tenant.id,
          merchant_id: merchantId,
          item_id: item.id,
          created: input.id === undefined,
          actor: "staff",
        }),
      );
      return { item: toCatalogItemResponse(item) };
    } catch (error) {
      throw this.mapNotFound(error);
    }
  }

  // §3 — قلب توفّر صنف (المكتب v1). idempotent فعلياً: نفس القيمة تعيد نفس الصف.
  async setItemAvailability(
    authorization: string | undefined,
    id: string,
    itemId: string,
    body: unknown,
  ): Promise<CatalogItemResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    // merchantId بالمسار للاتساق (والعزل بالـ RLS)؛ توفّر الصنف مفتاحه itemId ضمن المستأجر.
    parseOr400(uuidSchema, id, "merchants_availability_merchant_id");
    const catalogItemId = parseOr400(uuidSchema, itemId, "merchants_availability_item_id");
    const input = parseOr400(availabilityBodySchema, body, "merchants_availability");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    try {
      const item = await setItemAvailability(this.handle.db, tenant.id, catalogItemId, input.isAvailable);
      console.log(
        JSON.stringify({
          action: "catalog_item_availability_set",
          tenant_id: tenant.id,
          item_id: item.id,
          is_available: item.isAvailable,
          actor: "staff",
        }),
      );
      return { item: toCatalogItemResponse(item) };
    } catch (error) {
      throw this.mapNotFound(error);
    }
  }

  // §11 — معرّف من المستخدم غير موجود (تاجر/صنف) = 404 حالة عمل برسالة عامة؛
  // أي خطأ آخر يُعاد رميه كما هو — §16.12: لا ابتلاع.
  private mapNotFound(error: unknown): unknown {
    if (error instanceof MerchantNotFoundError || error instanceof CatalogItemNotFoundError) {
      return new NotFoundException("not found");
    }
    return error;
  }
}
