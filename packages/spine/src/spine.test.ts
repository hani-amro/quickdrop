import { describe, expect, it, vi } from "vitest";
import { parseSpineEvent } from "./consume.js";
import { publishSpineEvent } from "./publish.js";
import { SPINE_TOPICS, isSpineTopic } from "./topics.js";
import type { Tx } from "@quickdrop/db";

// tx مزيف يلتقط insert(outbox).values(...).returning(...) — يكفي عقد writeOutbox
function makeFakeTx() {
  const captured: { values?: Record<string, unknown> } = {};
  const returning = vi.fn(() => Promise.resolve([{ id: "ob-spine-1" }]));
  const values = vi.fn((v: Record<string, unknown>) => {
    captured.values = v;
    return { returning };
  });
  const insert = vi.fn(() => ({ values }));
  return { tx: { insert } as unknown as Tx, captured, insert };
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";

describe("publishSpineEvent (D9 — صف outbox بنفس الترانزاكشن + تحقق Zod قبل الكتابة)", () => {
  it("حمولة صحيحة: تُكتب outbox بالموضوع والحمولة والمستأجر", async () => {
    const f = makeFakeTx();
    const result = await publishSpineEvent(f.tx, TENANT, "order.ready_for_dispatch", { orderId: ORDER });
    expect(result).toEqual({ id: "ob-spine-1" });
    expect(f.captured.values).toMatchObject({
      tenantId: TENANT,
      topic: "order.ready_for_dispatch",
      payload: { orderId: ORDER },
      status: "pending",
    });
  });

  it("حمولة فاسدة: رمي صاخب قبل أي كتابة (rollback نظيف — لا صف مسموم R-16)", async () => {
    const f = makeFakeTx();
    await expect(
      publishSpineEvent(f.tx, TENANT, "order.ready_for_dispatch", { orderId: "not-a-uuid" }),
    ).rejects.toThrow(/invalid payload for "order.ready_for_dispatch"/);
    expect(f.insert).not.toHaveBeenCalled();
  });

  it("حقول زائدة تُقصّ (Zod strip) — الحمولة المكتوبة هي المتحقَّق منها فقط", async () => {
    const f = makeFakeTx();
    await publishSpineEvent(f.tx, TENANT, "payment.paid", {
      orderId: ORDER,
      paymentRef: "bp-123",
      // @ts-expect-error — حقل دخيل متعمد: يجب ألا يصل القاعدة
      injected: "evil",
    });
    expect((f.captured.values!["payload"] as Record<string, unknown>)["injected"]).toBeUndefined();
  });
});

describe("parseSpineEvent (§1 — التحقق عند الاستهلاك)", () => {
  it("يفكّ حدثاً صالحاً كنوع مميّز", () => {
    const r = parseSpineEvent("order.ready_for_dispatch", { orderId: ORDER });
    expect(r).toEqual({ ok: true, event: { topic: "order.ready_for_dispatch", payload: { orderId: ORDER } } });
  });

  it("موضوع غريب (إشعارات قديمة بنفس outbox) = unknown_topic لا رمي", () => {
    const r = parseSpineEvent("order.status_changed", { orderId: ORDER, from: "pending", to: "confirmed" });
    expect(r).toEqual({ ok: false, reason: "unknown_topic" });
  });

  it("حمولة فاسدة = invalid_payload بتفصيل — قرار المعالجة للمستهلك (R-16)", () => {
    const r = parseSpineEvent("payment.paid", { orderId: ORDER }); // paymentRef ناقص
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_payload");
  });

  it("كل المواضيع المسجّلة تجتاز isSpineTopic والعكس", () => {
    for (const t of SPINE_TOPICS) expect(isSpineTopic(t)).toBe(true);
    expect(isSpineTopic("bogus.topic")).toBe(false);
  });
});
