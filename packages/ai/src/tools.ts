import {
  createOrder,
  customerFacts,
  catalogItems,
  InvalidFoodOrderError,
  merchants,
  orders,
  withTenant,
  type Db,
} from "@quickdrop/db";
import { makePoint } from "@quickdrop/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { LlmToolDef } from "./llm.js";

// دمج WaFlow (MERGE_PLAN §3.2) — أدوات v2 «مُفرَّغة»:
// - **D11 (قاعدة حاكمة)**: create_order يقبل {catalog_item_id, qty}[] **حصراً** — لا حقل
//   سعر بالسكيما، وstrict يرفض أي مفتاح محقون. الأسعار يحلّها الخادم من الكتالوج عبر
//   **نفس مسار الاستقبال** (createOrder — لقطات + transition + قفل + outbox مجاناً).
//   WaFlow كان يدع النموذج يكتب السعر بنفسه — الثغرة الأخطر بالتدقيق.
// - **نطاق الزبون**: userId/conversationId من سياق التنفيذ حصراً — النموذج لا يمرّر
//   هويات (حقن برومبت لا يصل زبائن آخرين — كان org-scoped بـ WaFlow).
// - كل مدخل يمر Zod strict (يقتل ثغرة `as never`).

export interface ToolContext {
  db: Db;
  tenantId: string;
  /** زبون المحادثة — النطاق الإجباري لكل الأدوات. */
  userId: string;
  conversationId: string;
}

// —— سكيمات المدخلات (strict — أي مفتاح زائد يُرفض) ——

const getMenuSchema = z.object({}).strict();

const createOrderSchema = z
  .object({
    merchant_id: z.string().uuid(),
    items: z.array(z.object({ catalog_item_id: z.string().uuid(), qty: z.number().int().min(1).max(20) }).strict()).min(1).max(20),
    fulfillment: z.enum(["delivery", "pickup"]),
    note: z.string().max(500).optional(),
  })
  .strict();

const orderStatusSchema = z.object({}).strict();

const rememberFactSchema = z
  .object({
    key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, "key: snake_case فقط"),
    value: z.string().min(1).max(500),
  })
  .strict();

/** تعريفات الأدوات بصيغة Anthropic (JSON Schema يدوي — مطابق لسكيمات Zod أعلاه). */
export const TOOL_DEFS: LlmToolDef[] = [
  {
    name: "get_menu",
    description: "قائمة المطاعم المتاحة وأصنافها بالأسعار — استخدمها قبل إنشاء أي طلب.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_order",
    description:
      "إنشاء طلب للزبون الحالي بعد تأكيده. مرّر معرّفات الأصناف والكميات فقط — الأسعار يحسبها النظام من الكتالوج. fulfillment: delivery (يتطلب موقعاً مشاركاً من الزبون) أو pickup (استلام ذاتي من المطعم).",
    input_schema: {
      type: "object",
      properties: {
        merchant_id: { type: "string", description: "معرّف المطعم من get_menu" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              catalog_item_id: { type: "string" },
              qty: { type: "integer", minimum: 1, maximum: 20 },
            },
            required: ["catalog_item_id", "qty"],
            additionalProperties: false,
          },
          minItems: 1,
        },
        fulfillment: { type: "string", enum: ["delivery", "pickup"] },
        note: { type: "string" },
      },
      required: ["merchant_id", "items", "fulfillment"],
      additionalProperties: false,
    },
  },
  {
    name: "order_status",
    description: "حالة آخر طلب للزبون الحالي.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "remember_fact",
    description: "حفظ معلومة دائمة عن الزبون (تفضيل، حساسية، عنوان وصفي…) — key بصيغة snake_case.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
      additionalProperties: false,
    },
  },
];

/** مفتاح حقيقة الموقع الأخير (يكتبها مستهلك WA عند رسالة موقع) — مصدر dropoff للتوصيل. */
export const LAST_LOCATION_FACT_KEY = "last_location";

const lastLocationSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/**
 * تنفيذ أداة باسمها ومدخلها (مدخل النموذج — لا يوثَق به): Zod strict ثم التنفيذ بنطاق
 * الزبون. **النتيجة نص** يعود للنموذج (tool_result). فشل التحقق يعيد رسالة خطأ نصية
 * (النموذج يصحح نفسه) — لا رمي إلا لأخطاء النظام الحقيقية (§16.12).
 */
export async function executeTool(ctx: ToolContext, name: string, input: unknown): Promise<string> {
  switch (name) {
    case "get_menu": {
      const v = getMenuSchema.safeParse(input ?? {});
      if (!v.success) return `خطأ مدخل: ${v.error.issues[0]?.message ?? "invalid"}`;
      const rows = await withTenant(ctx.db, ctx.tenantId, (tx) =>
        tx
          .select({
            merchantId: merchants.id,
            merchantName: merchants.name,
            itemId: catalogItems.id,
            itemName: catalogItems.nameAr,
            price: catalogItems.price,
            isAvailable: catalogItems.isAvailable,
          })
          .from(merchants)
          .innerJoin(catalogItems, and(eq(catalogItems.tenantId, merchants.tenantId), eq(catalogItems.merchantId, merchants.id)))
          .where(and(eq(merchants.tenantId, ctx.tenantId), eq(merchants.isActive, true), eq(catalogItems.isAvailable, true)))
          .limit(120),
      );
      if (rows.length === 0) return "لا مطاعم متاحة حالياً.";
      const byMerchant = new Map<string, { name: string; items: string[] }>();
      for (const r of rows) {
        const entry = byMerchant.get(r.merchantId) ?? { name: r.merchantName, items: [] };
        entry.items.push(`  - ${r.itemName} | id=${r.itemId} | ${r.price.toString()} سنت`);
        byMerchant.set(r.merchantId, entry);
      }
      return [...byMerchant.entries()]
        .map(([id, m]) => `مطعم: ${m.name} | id=${id}\n${m.items.join("\n")}`)
        .join("\n\n");
    }

    case "create_order": {
      const v = createOrderSchema.safeParse(input);
      if (!v.success) return `خطأ مدخل: ${v.error.issues[0]?.message ?? "invalid"} — الأسعار لا تُمرَّر أبداً؛ معرّفات وكميات فقط.`;
      const args = v.data;

      // dropoff للتوصيل = آخر موقع شاركه الزبون (حقيقة last_location) — لا نقاط من النموذج
      let dropoff: { lat: number; lng: number } | undefined;
      if (args.fulfillment === "delivery") {
        const factRows = await withTenant(ctx.db, ctx.tenantId, (tx) =>
          tx
            .select({ value: customerFacts.value })
            .from(customerFacts)
            .where(and(eq(customerFacts.tenantId, ctx.tenantId), eq(customerFacts.userId, ctx.userId), eq(customerFacts.key, LAST_LOCATION_FACT_KEY)))
            .limit(1),
        );
        const fact = factRows[0];
        const loc = fact ? lastLocationSchema.safeParse(safeJson(fact.value)) : null;
        if (!loc || !loc.success) {
          return "NEED_LOCATION: لا موقع محفوظاً للزبون — اطلب منه مشاركة موقعه من واتساب (مشبك ← الموقع) ثم أعد المحاولة.";
        }
        dropoff = loc.data;
      }

      try {
        const created = await createOrder(ctx.db, ctx.tenantId, {
          service: "food",
          customerId: ctx.userId, // النطاق من السياق حصراً — لا من النموذج
          merchantId: args.merchant_id,
          items: args.items.map((i) => ({ catalogItemId: i.catalog_item_id, qty: i.qty })),
          fulfillment: args.fulfillment,
          pickup: makePoint(0, 0), // يُستبدل بموقع المطعم داخل createOrder (food)
          ...(dropoff !== undefined ? { dropoff: makePoint(dropoff.lat, dropoff.lng) } : {}),
          ...(args.note !== undefined ? { notes: args.note } : {}),
          conversationId: ctx.conversationId,
          source: "ai",
          createdBy: { type: "customer", id: ctx.userId },
        });
        const o = created.order;
        return `تم إنشاء الطلب #${o.publicCode} — الإجمالي على الزبون ${o.codAmount.toString()} سنت (بضاعة ${o.goodsAmount.toString()} + توصيل ${o.priceTotal.toString()}). ${args.fulfillment === "pickup" ? "استلام ذاتي من المطعم." : "سيصله بعد تأكيد المطعم."} ينتظر الدفع/التأكيد.`;
      } catch (error) {
        if (error instanceof InvalidFoodOrderError) {
          return `تعذّر إنشاء الطلب: ${error.reason} — تحقق من المعرّفات عبر get_menu.`;
        }
        throw error; // خطأ نظام حقيقي — يصعد (§16.12)
      }
    }

    case "order_status": {
      const v = orderStatusSchema.safeParse(input ?? {});
      if (!v.success) return `خطأ مدخل: ${v.error.issues[0]?.message ?? "invalid"}`;
      const rows = await withTenant(ctx.db, ctx.tenantId, (tx) =>
        tx
          .select({ publicCode: orders.publicCode, status: orders.status, codAmount: orders.codAmount, paymentStatus: orders.paymentStatus })
          .from(orders)
          .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.customerId, ctx.userId))) // نطاق الزبون حصراً
          .orderBy(desc(orders.createdAt))
          .limit(1),
      );
      const o = rows[0];
      if (!o) return "لا طلبات سابقة لهذا الزبون.";
      return `آخر طلب #${o.publicCode}: الحالة ${o.status}، الدفع ${o.paymentStatus}، المستحق ${o.codAmount.toString()} سنت.`;
    }

    case "remember_fact": {
      const v = rememberFactSchema.safeParse(input);
      if (!v.success) return `خطأ مدخل: ${v.error.issues[0]?.message ?? "invalid"}`;
      const { key, value } = v.data;
      await withTenant(ctx.db, ctx.tenantId, (tx) =>
        tx
          .insert(customerFacts)
          .values({ tenantId: ctx.tenantId, userId: ctx.userId, key, value, source: "ai" })
          .onConflictDoUpdate({
            target: [customerFacts.tenantId, customerFacts.userId, customerFacts.key],
            set: { value, source: "ai", updatedAt: new Date() },
          }),
      );
      return `حُفظت: ${key}.`;
    }

    default:
      return `أداة مجهولة: ${name}`; // نموذج هلوس اسم أداة — رسالة تصحيح، لا رمي
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
