import { makePoint, toPostgisWkt, type MerchantCategory, type Point } from "@quickdrop/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { catalogItems, merchants } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §3 — إدارة التجار (المطاعم/المحال) وكتالوجهم من الداشبورد. كل الوصول عبر
// withTenant (§2.2)؛ المال bigint حصراً (D5) والنقطة WKT بترتيب lng lat (D7).
// بوت التاجر (قبول/رفض/قلب is_available من التاجر) مرحلة لاحقة — هنا الإدارة المكتبية.

/** §3 — التاجر كما تعرضه طبقة الإدارة: الموقع مُفكَّك إلى {lat,lng} (الفخ 6). */
export interface MerchantView {
  id: string;
  name: string;
  phone: string | null;
  category: MerchantCategory;
  isActive: boolean;
  prepMinutesDefault: number | null;
  point: Point;
  createdAt: Date;
}

/** §3 — صنف كتالوج؛ السعر bigint (D5 — يُحوَّل string عند حافة الـ API). */
export interface CatalogItemView {
  id: string;
  merchantId: string;
  nameAr: string;
  nameEn: string | null;
  price: bigint;
  isAvailable: boolean;
  sortOrder: number;
  createdAt: Date;
}

export interface CreateMerchantInput {
  name: string;
  phone?: string;
  category: MerchantCategory;
  point: Point;
  prepMinutesDefault?: number;
}

export interface UpsertCatalogItemInput {
  id?: string; // موجود = تحديث؛ غائب = إنشاء
  merchantId: string;
  nameAr: string;
  nameEn?: string;
  price: bigint; // D5: أصغر وحدة
  sortOrder?: number;
}

/** §3 — تاجر غير موجود لهذا المستأجر (تُترجَم إلى 404 بحدود الـ API). */
export class MerchantNotFoundError extends Error {
  constructor() {
    super("merchant not found");
    this.name = "MerchantNotFoundError";
  }
}

/** §3 — صنف كتالوج غير موجود لهذا المستأجر/المطعم (تُترجَم إلى 404 بحدود الـ API). */
export class CatalogItemNotFoundError extends Error {
  constructor() {
    super("catalog item not found");
    this.name = "CatalogItemNotFoundError";
  }
}

// أعمدة العرض المشتركة للأصناف — مصدر واحد لتفادي انحراف الحقول بين الدوال.
const catalogItemColumns = {
  id: catalogItems.id,
  merchantId: catalogItems.merchantId,
  nameAr: catalogItems.nameAr,
  nameEn: catalogItems.nameEn,
  price: catalogItems.price,
  isAvailable: catalogItems.isAvailable,
  sortOrder: catalogItems.sortOrder,
  createdAt: catalogItems.createdAt,
} as const;

/**
 * §3 — قائمة تجار المستأجر: الموقع يُقرأ ST_Y/ST_X على geography عبر geometry cast
 * (نفس نمط resolveFoodOrder — لا قراءة WKB خام عبر الـ ORM). ترتيب أبجدي حتمي.
 */
export async function listMerchants(db: Db, tenantId: string): Promise<MerchantView[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: merchants.id,
        name: merchants.name,
        phone: merchants.phone,
        category: merchants.category,
        isActive: merchants.isActive,
        prepMinutesDefault: merchants.prepMinutesDefault,
        lat: sql<number>`ST_Y(${merchants.point}::geometry)`,
        lng: sql<number>`ST_X(${merchants.point}::geometry)`,
        createdAt: merchants.createdAt,
      })
      .from(merchants)
      .where(eq(merchants.tenantId, tenantId)) // فوق RLS
      .orderBy(asc(merchants.name)),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    category: r.category,
    isActive: r.isActive,
    prepMinutesDefault: r.prepMinutesDefault,
    point: makePoint(r.lat, r.lng), // الفخ 6: نقطة واحدة، لا أزواج عارية
    createdAt: r.createdAt,
  }));
}

/** §3 — إنشاء تاجر: النقطة WKT بترتيب lng lat (D7). يعود بالتاجر كامل الحقول. */
export async function createMerchant(
  db: Db,
  tenantId: string,
  input: CreateMerchantInput,
): Promise<MerchantView> {
  const inserted = await withTenant(db, tenantId, (tx) =>
    tx
      .insert(merchants)
      .values({
        tenantId,
        name: input.name,
        point: toPostgisWkt(input.point), // D7: WKT بترتيب lng lat
        category: input.category,
        // exactOptionalPropertyTypes: لا نمرّر undefined صريحاً
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.prepMinutesDefault !== undefined ? { prepMinutesDefault: input.prepMinutesDefault } : {}),
      })
      .returning({
        id: merchants.id,
        name: merchants.name,
        phone: merchants.phone,
        category: merchants.category,
        isActive: merchants.isActive,
        prepMinutesDefault: merchants.prepMinutesDefault,
        createdAt: merchants.createdAt,
      }),
  );
  const row = inserted[0];
  if (!row) {
    // §16.12 — لا ابتلاع: upsert/insert مع RETURNING بلا صف = حالة مستحيلة
    throw new Error("createMerchant: INSERT merchants ... RETURNING returned no row");
  }
  // النقطة المدخلة صالحة (تحقق الـ API/makePoint) — نعيدها كما هي بلا قراءة ثانية.
  return { ...row, point: input.point };
}

/** §3 — كتالوج مطعم: مرتّب بـ sort_order ثم الاسم العربي (فهرس tenant+merchant §2.3). */
export async function listCatalog(db: Db, tenantId: string, merchantId: string): Promise<CatalogItemView[]> {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select(catalogItemColumns)
      .from(catalogItems)
      .where(and(eq(catalogItems.tenantId, tenantId), eq(catalogItems.merchantId, merchantId)))
      .orderBy(asc(catalogItems.sortOrder), asc(catalogItems.nameAr)),
  );
  return rows;
}

/**
 * §3 — إنشاء/تحديث صنف كتالوج. نتحقق أولاً أن المطعم يخص المستأجر (تفادي انتهاك FK
 * صامت → 500؛ نرمي خطأً مفهوماً 404). id موجود = تحديث ضمن (المستأجر، المطعم)؛
 * غائب = إدراج. تعديل السعر/الاسم هنا لا يمسّ لقطات الطلبات الماضية (§3: لا FK حي للسعر).
 */
export async function upsertCatalogItem(
  db: Db,
  tenantId: string,
  input: UpsertCatalogItemInput,
): Promise<CatalogItemView> {
  return withTenant(db, tenantId, async (tx) => {
    const owner = await tx
      .select({ id: merchants.id })
      .from(merchants)
      .where(and(eq(merchants.tenantId, tenantId), eq(merchants.id, input.merchantId)))
      .limit(1);
    if (!owner[0]) throw new MerchantNotFoundError();

    if (input.id !== undefined) {
      const updated = await tx
        .update(catalogItems)
        .set({
          nameAr: input.nameAr,
          price: input.price,
          updatedAt: new Date(), // D6: UTC
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        })
        // القيد على (tenant, id, merchant): تحديث صنف مطعم آخر مستحيل حتى بمعرّف صحيح
        .where(
          and(
            eq(catalogItems.tenantId, tenantId),
            eq(catalogItems.id, input.id),
            eq(catalogItems.merchantId, input.merchantId),
          ),
        )
        .returning(catalogItemColumns);
      const row = updated[0];
      if (!row) throw new CatalogItemNotFoundError();
      return row;
    }

    const inserted = await tx
      .insert(catalogItems)
      .values({
        tenantId,
        merchantId: input.merchantId,
        nameAr: input.nameAr,
        price: input.price,
        ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      })
      .returning(catalogItemColumns);
    const row = inserted[0];
    if (!row) {
      throw new Error("upsertCatalogItem: INSERT catalog_items ... RETURNING returned no row");
    }
    return row;
  });
}

/** §3 — قلب توفّر صنف (المكتب v1؛ قلب التاجر من بوته لاحقاً). يعود بالصنف المحدَّث. */
export async function setItemAvailability(
  db: Db,
  tenantId: string,
  itemId: string,
  isAvailable: boolean,
): Promise<CatalogItemView> {
  return withTenant(db, tenantId, async (tx) => {
    const updated = await tx
      .update(catalogItems)
      .set({ isAvailable, updatedAt: new Date() }) // D6: UTC
      .where(and(eq(catalogItems.tenantId, tenantId), eq(catalogItems.id, itemId)))
      .returning(catalogItemColumns);
    const row = updated[0];
    if (!row) throw new CatalogItemNotFoundError();
    return row;
  });
}
