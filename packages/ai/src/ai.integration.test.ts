import {
  createDb,
  createMerchant,
  createOrder,
  customerFacts,
  orders,
  outbox,
  pricingRules,
  setAiBudget,
  spendAiBudget,
  tenants,
  upsertCatalogItem,
  users,
  withTenant,
  type DbHandle,
} from "@quickdrop/db";
import { makePoint } from "@quickdrop/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent, roundCostSen, DEFAULT_TOKEN_RATES, type AgentDeps } from "./engine.js";
import { LAST_LOCATION_FACT_KEY } from "./tools.js";
import type { LlmClient, LlmCompleteArgs, LlmResponse } from "./llm.js";

// المرحلة 3 (§3.2) — وكيل الـ AI على قاعدة حية بنموذج **مبرمَج** (لا شبكة):
// D11: create_order بلا أسعار (حقن price يُرفض strict)؛ النطاق زبون المحادثة حصراً؛
// الميزانية ذرّية (نفاد يوقف، سباق لا يتجاوز السقف)؛ الرد النهائي = outbox agent.reply.

const hasDb = Boolean(process.env["DATABASE_URL"]);
const POINT = makePoint(33.5138, 36.2765);
const DROP = { lat: 33.5588, lng: 36.2765 };

/** نموذج مبرمَج: يعيد الاستجابات بالترتيب؛ يسجّل ما استُدعي به. */
function scriptedLlm(responses: LlmResponse[]): LlmClient & { calls: LlmCompleteArgs[] } {
  const calls: LlmCompleteArgs[] = [];
  let i = 0;
  return {
    calls,
    complete(args: LlmCompleteArgs): Promise<LlmResponse> {
      calls.push(args);
      const res = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return Promise.resolve(res);
    },
  };
}

const USAGE = { inputTokens: 1000, outputTokens: 200 };

function textResponse(text: string): LlmResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn", usage: USAGE };
}

function toolResponse(name: string, input: unknown, id = "tu_1"): LlmResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage: USAGE };
}

describe.skipIf(!hasDb)("وكيل الـ AI (تكامل، قاعدة حية، نموذج مبرمَج)", () => {
  let app: DbHandle;
  let tenantId: string;
  let customerId: string;
  let otherCustomerId: string;
  let conversationId: string;
  let merchantId: string;
  let itemId: string;

  beforeAll(async () => {
    app = createDb(process.env["DATABASE_URL"]!);
    const t = await app.db
      .insert(tenants)
      .values({ slug: `ai-${Date.now().toString(36)}`, name: "AI QA", nameAr: "وكيل", plan: "growth" })
      .returning({ id: tenants.id });
    tenantId = t[0]!.id;
    await withTenant(app.db, tenantId, async (tx) => {
      const u = await tx.insert(users).values({ tenantId, role: "customer", waId: "60155566777", firstName: "Zain" }).returning({ id: users.id });
      customerId = u[0]!.id;
      const u2 = await tx.insert(users).values({ tenantId, role: "customer", waId: "60155566888", firstName: "Omar" }).returning({ id: users.id });
      otherCustomerId = u2[0]!.id;
      await tx.insert(pricingRules).values({ tenantId, service: "food", base: 5_000n, perKm: 1_000n, perKg: 0n, minTotal: 0n, surgeMultiplierBp: 10_000, priority: 0 });
      // خيط المحادثة
      const conv = await tx.execute(
        (await import("drizzle-orm")).sql`INSERT INTO conversations (id, tenant_id, user_id) VALUES (gen_random_uuid(), ${tenantId}::uuid, ${customerId}::uuid) RETURNING id`,
      );
      conversationId = (conv.rows[0] as { id: string }).id;
    });
    const m = await createMerchant(app.db, tenantId, { name: "مطعم الوكيل", point: POINT, category: "restaurant" });
    merchantId = m.id;
    const item = await upsertCatalogItem(app.db, tenantId, { merchantId, nameAr: "منسف", price: 45_000n });
    itemId = item.id;
    await setAiBudget(app.db, tenantId, 10_000n); // ميزانية سخية للاختبارات الافتراضية
  });

  afterAll(async () => {
    await app.close(); // عالم بمستأجر معزول — resetDb بسويت db يجرف البقايا
  });

  function deps(llm: LlmClient): AgentDeps {
    return { db: app.db, llm };
  }

  const runInput = () => ({
    tenantId,
    userId: customerId,
    conversationId,
    inboundText: "بدي منسف",
    systemPrompt: "أنت وكيل مطعم.",
  });

  async function orderCountFor(userId: string): Promise<number> {
    return withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, userId)));
      return rows.length;
    });
  }

  it("roundCostSen: قسمة سقفية bigint — لا float", () => {
    expect(roundCostSen({ inputTokens: 1_000_000, outputTokens: 0 }, DEFAULT_TOKEN_RATES)).toBe(500n);
    expect(roundCostSen({ inputTokens: 1, outputTokens: 0 }, DEFAULT_TOKEN_RATES)).toBe(1n); // سقفية: أي كسر → 1
    expect(roundCostSen({ inputTokens: 0, outputTokens: 0 }, DEFAULT_TOKEN_RATES)).toBe(0n);
  });

  it("الحلقة الكاملة: get_menu ← create_order (pickup، معرّفات فقط) ← نص نهائي = agent.reply — والسعر من الخادم", async () => {
    const before = await orderCountFor(customerId);
    const llm = scriptedLlm([
      toolResponse("get_menu", {}),
      toolResponse("create_order", { merchant_id: merchantId, items: [{ catalog_item_id: itemId, qty: 2 }], fulfillment: "pickup" }, "tu_2"),
      textResponse("تم يا زين! طلبك محجوز — منسفان 🍖"),
    ]);
    const result = await runAgent(deps(llm), runInput());
    expect(result.outcome).toBe("replied");

    // القائمة وصلت للنموذج كنتيجة أداة بالجولة الثانية
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain("منسف");

    // الطلب: سعر الخادم حصراً (منسف 45000×2)، بنطاق زبون المحادثة، source='ai'
    const row = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ goodsAmount: orders.goodsAmount, codAmount: orders.codAmount, priceTotal: orders.priceTotal, source: orders.source, customerId: orders.customerId, conversationId: orders.conversationId, fulfillment: orders.fulfillment })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, customerId)));
      return rows[rows.length - 1]!;
    });
    expect(await orderCountFor(customerId)).toBe(before + 1);
    expect(row.goodsAmount).toBe(90_000n); // 45000×2 من الكتالوج — النموذج لم يمرّر سعراً
    expect(row.priceTotal).toBe(0n); // pickup: لا سعر توصيل
    expect(row.codAmount).toBe(90_000n);
    expect(row.source).toBe("ai");
    expect(row.customerId).toBe(customerId);
    expect(row.conversationId).toBe(conversationId);

    // الرد النهائي كُتب صف agent.reply
    const replies = await withTenant(app.db, tenantId, (tx) =>
      tx.select({ payload: outbox.payload }).from(outbox).where(and(eq(outbox.tenantId, tenantId), eq(outbox.topic, "agent.reply"))),
    );
    expect(replies.some((r) => JSON.stringify(r.payload).includes("منسفان"))).toBe(true);
  });

  it("D11 (حاكم): حقن سعر بمدخل create_order → يُرفض strict، لا طلب يُنشأ، والنموذج يُصحَّح", async () => {
    const before = await orderCountFor(customerId);
    const llm = scriptedLlm([
      toolResponse("create_order", {
        merchant_id: merchantId,
        items: [{ catalog_item_id: itemId, qty: 1, unit_price: 1 }], // حقن سعر بالسطر
        fulfillment: "pickup",
        total: 1, // وحقن إجمالي
      }),
      textResponse("عذراً، صار خطأ."),
    ]);
    const result = await runAgent(deps(llm), runInput());
    expect(result.outcome).toBe("replied");
    expect(await orderCountFor(customerId)).toBe(before); // ⛔ لا طلب
    // النموذج تلقّى رسالة الرفض
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain("خطأ مدخل");
  });

  it("توصيل بلا موقع محفوظ → NEED_LOCATION ولا طلب؛ وبموقع محفوظ → طلب توصيل بسعر توصيل", async () => {
    const before = await orderCountFor(customerId);
    const llm1 = scriptedLlm([
      toolResponse("create_order", { merchant_id: merchantId, items: [{ catalog_item_id: itemId, qty: 1 }], fulfillment: "delivery" }),
      textResponse("شاركني موقعك لو سمحت 📍"),
    ]);
    await runAgent(deps(llm1), runInput());
    expect(await orderCountFor(customerId)).toBe(before);
    expect(JSON.stringify(llm1.calls[1]!.messages)).toContain("NEED_LOCATION");

    // موقع محفوظ (يكتبه مستهلك WA عند رسالة موقع) → التوصيل يمر بسعر من محرك التسعير
    await withTenant(app.db, tenantId, (tx) =>
      tx.insert(customerFacts).values({ tenantId, userId: customerId, key: LAST_LOCATION_FACT_KEY, value: JSON.stringify(DROP), source: "system" }),
    );
    const llm2 = scriptedLlm([
      toolResponse("create_order", { merchant_id: merchantId, items: [{ catalog_item_id: itemId, qty: 1 }], fulfillment: "delivery" }),
      textResponse("تم — طلبك بالطريق قريباً 🚀"),
    ]);
    await runAgent(deps(llm2), runInput());
    expect(await orderCountFor(customerId)).toBe(before + 1);
    const last = await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx.select({ priceTotal: orders.priceTotal, fulfillment: orders.fulfillment }).from(orders).where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, customerId)));
      return rows[rows.length - 1]!;
    });
    expect(last.fulfillment).toBe("delivery");
    expect(last.priceTotal > 0n).toBe(true); // سعر التوصيل من المحرك (D11)
  });

  it("النطاق: order_status يعيد طلبات زبون المحادثة حصراً (لا طلبات زبون آخر)", async () => {
    // طلب لزبون آخر بمبلغ مميّز
    await createOrder(app.db, tenantId, {
      service: "food",
      customerId: otherCustomerId,
      merchantId,
      items: [{ catalogItemId: itemId, qty: 3 }],
      fulfillment: "pickup",
      pickup: POINT,
      createdBy: { type: "staff" },
    });
    const llm = scriptedLlm([toolResponse("order_status", {}), textResponse("حالة طلبك أعلاه.")]);
    await runAgent(deps(llm), runInput());
    const toolResult = JSON.stringify(llm.calls[1]!.messages);
    expect(toolResult).not.toContain("135000"); // 45000×3 طلب الزبون الآخر — يجب ألا يظهر
  });

  it("الميزانية: نفاد يوقف الحلقة بلا رد؛ لا صف = معطّل؛ والخصم المتزامن لا يتجاوز السقف", async () => {
    // مستأجر بميزانية 1 سنت — الجولة الأولى (كلفتها ~1 سنت) تمر والثانية تُستنفد
    const t2 = await app.db.insert(tenants).values({ slug: `ai2-${Date.now().toString(36)}`, name: "AI Tiny", nameAr: "ضيق" }).returning({ id: tenants.id });
    const tinyTenant = t2[0]!.id;
    let tinyUser = "";
    await withTenant(app.db, tinyTenant, async (tx) => {
      const u = await tx.insert(users).values({ tenantId: tinyTenant, role: "customer", waId: "60100000001" }).returning({ id: users.id });
      tinyUser = u[0]!.id;
    });
    await setAiBudget(app.db, tinyTenant, 1n);
    const llm = scriptedLlm([toolResponse("get_menu", {}), toolResponse("get_menu", {}), textResponse("مرحبا")]);
    const r = await runAgent(deps(llm), { tenantId: tinyTenant, userId: tinyUser, conversationId, inboundText: "hi", systemPrompt: "x" });
    expect(r.outcome).toBe("budget_exhausted"); // الجولة 2 تجاوزت السقف — توقف بلا رد

    // لا صف ميزانية = معطّل من أول جولة
    const t3 = await app.db.insert(tenants).values({ slug: `ai3-${Date.now().toString(36)}`, name: "AI None", nameAr: "بلا" }).returning({ id: tenants.id });
    const r2 = await runAgent(deps(scriptedLlm([textResponse("hi")])), { tenantId: t3[0]!.id, userId: tinyUser, conversationId, inboundText: "hi", systemPrompt: "x" });
    expect(r2.outcome).toBe("budget_missing");

    // الذرّية تحت السباق: ميزانية 100، خصمان متزامنان 60+60 → واحد يمر والآخر exhausted
    const t4 = await app.db.insert(tenants).values({ slug: `ai4-${Date.now().toString(36)}`, name: "AI Race", nameAr: "سباق" }).returning({ id: tenants.id });
    const raceTenant = t4[0]!.id;
    await setAiBudget(app.db, raceTenant, 100n);
    const results = await Promise.all([
      spendAiBudget(app.db, raceTenant, 60n),
      spendAiBudget(app.db, raceTenant, 60n),
    ]);
    expect(results.filter((x) => x === "spent")).toHaveLength(1);
    expect(results.filter((x) => x === "exhausted")).toHaveLength(1);
  });

  it("security-M1: الفحص قبل النداء — لا صف/مستنفَد = **صفر نداء LLM** (لا دفع لمعطّل/مستنفَد)", async () => {
    // لا صف ميزانية = معطّل: يجب ألا يُنادى النموذج ولا مرة
    const t = await app.db.insert(tenants).values({ slug: `aip-${Date.now().toString(36)}`, name: "AI PreCall", nameAr: "قبل" }).returning({ id: tenants.id });
    const noBudgetTenant = t[0]!.id;
    let noBudgetUser = "";
    await withTenant(app.db, noBudgetTenant, async (tx) => {
      const u = await tx.insert(users).values({ tenantId: noBudgetTenant, role: "customer", waId: "60100000009" }).returning({ id: users.id });
      noBudgetUser = u[0]!.id;
    });
    const llm1 = scriptedLlm([textResponse("hi")]);
    const r1 = await runAgent(deps(llm1), { tenantId: noBudgetTenant, userId: noBudgetUser, conversationId, inboundText: "hi", systemPrompt: "x" });
    expect(r1.outcome).toBe("budget_missing");
    expect(llm1.calls).toHaveLength(0); // ⛔ صفر نداء — المفتاح المشترك لم يُدفع لمستأجر معطّل

    // مستنفَد سلفاً: صفر نداء أيضاً
    const t2 = await app.db.insert(tenants).values({ slug: `aiex-${Date.now().toString(36)}`, name: "AI Exhausted", nameAr: "مستنفَد" }).returning({ id: tenants.id });
    const exhTenant = t2[0]!.id;
    await setAiBudget(app.db, exhTenant, 10n);
    await spendAiBudget(app.db, exhTenant, 10n); // استنفد
    const llm2 = scriptedLlm([textResponse("hi")]);
    const r2 = await runAgent(deps(llm2), { tenantId: exhTenant, userId: noBudgetUser, conversationId, inboundText: "hi", systemPrompt: "x" });
    expect(r2.outcome).toBe("budget_exhausted");
    expect(llm2.calls).toHaveLength(0); // ⛔ صفر نداء
  });
});
