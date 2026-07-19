import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { InvalidTransitionError, transition } from "./state-machine.js";
import { catalogItems, merchantOperators, merchants, orders, tenants } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §3 (مرحلة بوت التاجر) — منطق ربط حساب تيليغرام بمطعم، وقبول/رفض التاجر لطلب الطعام.
// كل شيء عبر withTenant (app_user, RLS §2.2). القبول = عمود merchant_confirmed_at
// (لا حالة — لا يمسّ D8)؛ الرفض = إلغاء عبر transition() الوحيدة (D8) بفاعل staff.

/** ربط (أو إعادة ربط) مشغّل تيليغرام بمطعم. يرجع اسم المطعم، أو null إن كان المطعم مجهولاً. */
export async function bindMerchantOperator(
  db: Db,
  tenantId: string,
  merchantId: string,
  telegramUserId: number,
): Promise<{ merchantName: string } | null> {
  return withTenant(db, tenantId, async (tx) => {
    const m = await tx
      .select({ name: merchants.name })
      .from(merchants)
      .where(and(eq(merchants.tenantId, tenantId), eq(merchants.id, merchantId)))
      .limit(1);
    const merchant = m[0];
    if (!merchant) return null; // كود ربط لمطعم غير موجود (نادر — سباق حذف) — رفض هادئ

    // مشغّل واحد ⇒ مطعم واحد: إعادة الربط تستبدل الصف (unique على tenant+tg)
    await tx
      .insert(merchantOperators)
      .values({ tenantId, merchantId, telegramUserId })
      .onConflictDoUpdate({
        target: [merchantOperators.tenantId, merchantOperators.telegramUserId],
        set: { merchantId },
      });
    return { merchantName: merchant.name };
  });
}

/**
 * §3 — سياق توليد كود الربط بالـ api: يتحقق من وجود المطعم ويجلب botUsername (لبناء
 * الرابط العميق). tenants استثناء RLS مسمّى لكن قراءته داخل withTenant بدور app_user
 * تعمل (سياسة القراءة الذاتية للمستأجر — كما يقرؤه state-machine). null = مطعم مجهول.
 */
export async function merchantBindContext(
  db: Db,
  tenantId: string,
  merchantId: string,
): Promise<{ merchantName: string; botUsername: string | null } | null> {
  return withTenant(db, tenantId, async (tx) => {
    const m = await tx
      .select({ name: merchants.name })
      .from(merchants)
      .where(and(eq(merchants.tenantId, tenantId), eq(merchants.id, merchantId)))
      .limit(1);
    if (!m[0]) return null;
    const t = await tx.select({ botUsername: tenants.botUsername }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return { merchantName: m[0].name, botUsername: t[0]?.botUsername ?? null };
  });
}

/** المطعم الذي يديره مشغّل تيليغرام ضمن المستأجر — null إن لم يكن مربوطاً. */
export async function resolveMerchantOperator(
  db: Db,
  tenantId: string,
  telegramUserId: number,
): Promise<{ merchantId: string; merchantName: string } | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ merchantId: merchantOperators.merchantId, merchantName: merchants.name })
      .from(merchantOperators)
      .innerJoin(
        merchants,
        and(eq(merchants.tenantId, merchantOperators.tenantId), eq(merchants.id, merchantOperators.merchantId)),
      )
      .where(and(eq(merchantOperators.tenantId, tenantId), eq(merchantOperators.telegramUserId, telegramUserId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** معرّفات دردشات تيليغرام لكل مشغّلي مطعم — يستهلكها مُبلِّغ الإشعارات (fan-out). */
export async function listOperatorChatsForMerchant(
  db: Db,
  tenantId: string,
  merchantId: string,
): Promise<number[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ tg: merchantOperators.telegramUserId })
      .from(merchantOperators)
      .where(and(eq(merchantOperators.tenantId, tenantId), eq(merchantOperators.merchantId, merchantId)));
    return rows.map((r) => r.tg);
  });
}

export type MerchantAcceptOutcome =
  | { outcome: "accepted"; publicCode: string }
  | { outcome: "not_operator" } // المرسِل غير مربوط بأي مطعم
  | { outcome: "wrong_merchant" } // الطلب ليس لمطعم هذا المشغّل
  | { outcome: "already" } // بالمطبخ سلفاً (idempotent — ضغطتان)
  | { outcome: "too_late" } // تجاوز مرحلة القبول (أُلغي/أُسند…)
  | { outcome: "not_found" };

/**
 * دمج WaFlow (§4.2 D-M6 / adversary #20) — قبول التاجر = **transition(confirmed→preparing,
 * فاعل merchant)** حصراً: ترميز واحد للحقيقة. transition يملأ merchant_confirmed_at (مرة
 * واحدة)؛ مدة التحضير عمود عادي يُضبط بنفس الترانزاكشن. طلب معلّق (paid/بانتظار المكتب):
 * قبول التاجر هو بوابة البشر (§3.2) — pending→confirmed ثم confirmed→preparing بنفس
 * الترانزاكشن. مقيَّد بمطعم المشغّل (عزل داخل المستأجر).
 */
export async function merchantAcceptOrder(
  db: Db,
  tenantId: string,
  telegramUserId: number,
  orderId: string,
  prepMinutes: number,
): Promise<MerchantAcceptOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const opRows = await tx
      .select({ merchantId: merchantOperators.merchantId })
      .from(merchantOperators)
      .where(and(eq(merchantOperators.tenantId, tenantId), eq(merchantOperators.telegramUserId, telegramUserId)))
      .limit(1);
    const op = opRows[0];
    if (!op) return { outcome: "not_operator" as const };

    // ملكية/حالة مبكرة لرسالة دقيقة (القفل الحاسم داخل transition)
    const row = await tx
      .select({ merchantId: orders.merchantId, service: orders.service, status: orders.status, publicCode: orders.publicCode })
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);
    const order = row[0];
    if (!order) return { outcome: "not_found" as const };
    if (order.merchantId !== op.merchantId) return { outcome: "wrong_merchant" as const };
    if (order.service !== "food") return { outcome: "not_found" as const };
    if (order.status === "preparing" || order.status === "ready") return { outcome: "already" as const };
    if (order.status !== "pending" && order.status !== "confirmed") return { outcome: "too_late" as const };

    const actor = { type: "merchant" as const };
    const meta = { by: "merchant", telegramUserId, prepMinutes };
    try {
      if (order.status === "pending") {
        // بوابة البشر (§3.2): قبول التاجر يؤكّد الطلب المعلّق ثم يبدأ التحضير — ترانزاكشن واحدة
        await transition(tx, { orderId, to: "confirmed", actor, meta });
      }
      await transition(tx, { orderId, to: "preparing", actor, meta });
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        // سباق: أُلغي/أُسند/سبقنا مشغّل آخر بين القراءة والقفل — من صف القاعدة (D16)
        return { outcome: "too_late" as const };
      }
      throw error;
    }
    await tx
      .update(orders)
      .set({ merchantPrepMinutes: prepMinutes, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.merchantId, op.merchantId)));
    return { outcome: "accepted" as const, publicCode: order.publicCode };
  });
}

export type MerchantReadyOutcome =
  | { outcome: "ready"; publicCode: string }
  | { outcome: "not_operator" }
  | { outcome: "wrong_merchant" }
  | { outcome: "already" } // جاهز سلفاً (idempotent)
  | { outcome: "too_late" } // أُلغي/تجاوز
  | { outcome: "not_found" };

/**
 * §4.2 — جهوز المطبخ: transition(preparing→ready، فاعل merchant) — يملأ ready_at
 * (write-once) وعندها يُختم المفصل ويصدر order.ready_for_dispatch (المُطلِق الافتراضي).
 * الطلب المُسنَد سلفاً (dispatch_trigger='confirmed' والسائق انطلق) → "already" هادئة.
 */
export async function merchantMarkReady(
  db: Db,
  tenantId: string,
  telegramUserId: number,
  orderId: string,
): Promise<MerchantReadyOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const opRows = await tx
      .select({ merchantId: merchantOperators.merchantId })
      .from(merchantOperators)
      .where(and(eq(merchantOperators.tenantId, tenantId), eq(merchantOperators.telegramUserId, telegramUserId)))
      .limit(1);
    const op = opRows[0];
    if (!op) return { outcome: "not_operator" as const };

    const row = await tx
      .select({ merchantId: orders.merchantId, status: orders.status, readyAt: orders.readyAt, publicCode: orders.publicCode })
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);
    const order = row[0];
    if (!order) return { outcome: "not_found" as const };
    if (order.merchantId !== op.merchantId) return { outcome: "wrong_merchant" as const };
    if (order.status === "ready" || order.readyAt !== null) return { outcome: "already" as const };
    if (order.status !== "preparing") return { outcome: "too_late" as const };

    try {
      await transition(tx, { orderId, to: "ready", actor: { type: "merchant" }, meta: { by: "merchant", telegramUserId } });
    } catch (error) {
      if (error instanceof InvalidTransitionError) {
        return { outcome: "too_late" as const }; // سباق بين القراءة والقفل
      }
      throw error;
    }
    return { outcome: "ready" as const, publicCode: order.publicCode };
  });
}

export type MerchantRejectOutcome =
  | { outcome: "rejected"; publicCode: string }
  | { outcome: "not_operator" }
  | { outcome: "wrong_merchant" }
  | { outcome: "too_late" } // الطلب تجاوز مرحلة الإلغاء (مُسنَد/مُسلَّم/مُلغى)
  | { outcome: "not_found" };

// §4.2.4 — الحالات التي يجوز فيها للتاجر الرفض (قبل الإسناد لسائق): تشمل حالتي المطبخ
// (adversary #9 — مطبخ عاجز عن التنفيذ يلغي preparing/ready) — بعدها القرار للمكتب/السائق
const REJECTABLE = new Set(["pending", "confirmed", "scheduled", "preparing", "ready"]);

/**
 * رفض التاجر لطلب طعام → إلغاء عبر transition() (D8) بفاعل merchant (§4.2 — فاعل مستقل)
 * مع meta يوثّق أنه رفض تاجر. مقيَّد بمطعم المشغّل وبالحالات القابلة للإلغاء.
 */
export async function merchantRejectOrder(
  db: Db,
  tenantId: string,
  telegramUserId: number,
  orderId: string,
): Promise<MerchantRejectOutcome> {
  return withTenant(db, tenantId, async (tx) => {
    const opRows = await tx
      .select({ merchantId: merchantOperators.merchantId })
      .from(merchantOperators)
      .where(and(eq(merchantOperators.tenantId, tenantId), eq(merchantOperators.telegramUserId, telegramUserId)))
      .limit(1);
    const op = opRows[0];
    if (!op) return { outcome: "not_operator" as const };

    // القفل عبر transition لاحقاً؛ هنا فحص ملكية/حالة مبكّر لرسالة دقيقة
    const row = await tx
      .select({ merchantId: orders.merchantId, status: orders.status, publicCode: orders.publicCode })
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);
    const order = row[0];
    if (!order) return { outcome: "not_found" as const };
    if (order.merchantId !== op.merchantId) return { outcome: "wrong_merchant" as const };
    if (!REJECTABLE.has(order.status)) return { outcome: "too_late" as const };

    await transition(tx, {
      orderId,
      to: "cancelled_by_office",
      actor: { type: "merchant" },
      meta: { reason: "merchant_rejected", by: "merchant", telegramUserId },
    });
    await tx
      .update(orders)
      .set({ cancelReason: "رفض المطعم الطلب", updatedAt: new Date() })
      .where(eq(orders.id, orderId));
    return { outcome: "rejected" as const, publicCode: order.publicCode };
  });
}

/**
 * قلب توفّر صنف كتالوج (نفدت الكمية) — مقيَّد بمطعم المشغّل. يرجع الحالة الجديدة أو null.
 */
export async function toggleCatalogItemAvailability(
  db: Db,
  tenantId: string,
  telegramUserId: number,
  itemId: string,
): Promise<{ nameAr: string; isAvailable: boolean } | null> {
  return withTenant(db, tenantId, async (tx) => {
    const opRows = await tx
      .select({ merchantId: merchantOperators.merchantId })
      .from(merchantOperators)
      .where(and(eq(merchantOperators.tenantId, tenantId), eq(merchantOperators.telegramUserId, telegramUserId)))
      .limit(1);
    const op = opRows[0];
    if (!op) return null;

    const cur = await tx
      .select({ isAvailable: catalogItems.isAvailable, nameAr: catalogItems.nameAr })
      .from(catalogItems)
      .where(
        and(eq(catalogItems.tenantId, tenantId), eq(catalogItems.id, itemId), eq(catalogItems.merchantId, op.merchantId)),
      )
      .limit(1);
    const item = cur[0];
    if (!item) return null;

    const next = !item.isAvailable;
    await tx
      .update(catalogItems)
      .set({ isAvailable: next, updatedAt: new Date() })
      .where(and(eq(catalogItems.tenantId, tenantId), eq(catalogItems.id, itemId), eq(catalogItems.merchantId, op.merchantId)));
    return { nameAr: item.nameAr, isAvailable: next };
  });
}
