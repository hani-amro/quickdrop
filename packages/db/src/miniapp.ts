import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { catalogItems, merchants, users } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §10.3 — دوال بيانات الـ Mini App: هوية الزبون (find-or-create بمعرّف تيليغرام)، مطاعم
// فعّالة، وكتالوج متوفّر. كلها عبر withTenant (RLS §2.2). النقطة تُقرأ ST_Y/ST_X (D7 lng,lat).

/**
 * §10.3/D15 — الزبون بمعرّف تيليغرام: يُبحَث بأي دور (شخص واحد = صف users واحد بفضل
 * الفهرس الجزئي الفريد (tenant, tg) WHERE NOT NULL)، ويُنشأ بدور customer إن غاب.
 * آمن ضد السباق: onConflictDoNothing + إعادة قراءة (نفس نمط خيوط الدعم).
 */
export async function findOrCreateTelegramUser(
  db: Db,
  tenantId: string,
  telegramUserId: number,
  firstName?: string,
): Promise<{ userId: string; phoneE164: string | null; firstName: string | null }> {
  return withTenant(db, tenantId, async (tx) => {
    const found = await tx
      .select({ id: users.id, phone: users.phoneE164, firstName: users.firstName })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.telegramUserId, telegramUserId)))
      .limit(1);
    if (found[0]) return { userId: found[0].id, phoneE164: found[0].phone, firstName: found[0].firstName };

    const inserted = await tx
      .insert(users)
      .values({
        tenantId,
        telegramUserId,
        role: "customer",
        ...(firstName !== undefined ? { firstName } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (inserted[0]) return { userId: inserted[0].id, phoneE164: null, firstName: firstName ?? null };

    // خسر السباق: الفائز التزم — أعد القراءة (READ COMMITTED يراه الآن)
    const reselect = await tx
      .select({ id: users.id, phone: users.phoneE164, firstName: users.firstName })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.telegramUserId, telegramUserId)))
      .limit(1);
    const row = reselect[0];
    if (!row) throw new Error("findOrCreateTelegramUser: user vanished after ON CONFLICT");
    return { userId: row.id, phoneE164: row.phone, firstName: row.firstName };
  });
}

export interface MiniappRestaurant {
  id: string;
  name: string;
  point: { lat: number; lng: number };
  prepMinutesDefault: number | null;
}

/** §10.3 — المطاعم الفعّالة للعرض بالتطبيق (category='restaurant' AND is_active). */
export async function listActiveRestaurants(db: Db, tenantId: string): Promise<MiniappRestaurant[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: merchants.id,
        name: merchants.name,
        lat: sql<number>`ST_Y(${merchants.point}::geometry)`,
        lng: sql<number>`ST_X(${merchants.point}::geometry)`,
        prepMinutesDefault: merchants.prepMinutesDefault,
      })
      .from(merchants)
      .where(and(eq(merchants.tenantId, tenantId), eq(merchants.isActive, true), eq(merchants.category, "restaurant")))
      .orderBy(asc(merchants.name));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      point: { lat: r.lat, lng: r.lng },
      prepMinutesDefault: r.prepMinutesDefault,
    }));
  });
}

export interface MiniappCatalogItem {
  id: string;
  nameAr: string;
  price: bigint;
  isAvailable: boolean;
}

/** §10.3 — أصناف الكتالوج المتوفّرة لمطعم (is_available فقط تُعرض للطلب). */
export async function listAvailableCatalog(db: Db, tenantId: string, merchantId: string): Promise<MiniappCatalogItem[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: catalogItems.id,
        nameAr: catalogItems.nameAr,
        price: catalogItems.price,
        isAvailable: catalogItems.isAvailable,
      })
      .from(catalogItems)
      .where(
        and(
          eq(catalogItems.tenantId, tenantId),
          eq(catalogItems.merchantId, merchantId),
          eq(catalogItems.isAvailable, true),
        ),
      )
      .orderBy(asc(catalogItems.sortOrder), asc(catalogItems.nameAr));
    return rows;
  });
}
