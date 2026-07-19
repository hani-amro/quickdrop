import { describe, expect, it } from "vitest";
import { createBill, BillplzApiError } from "./client.js";
import { signBillplzParams, verifyBillplzSignature } from "./signature.js";

// دمج WaFlow — اختبارات التوقيع منقولة المعنى من packages/utils (كانت مختبَرة هناك).

const KEY = "test-x-signature-key";

function signedParams(base: Record<string, string>): Record<string, string> {
  return { ...base, x_signature: signBillplzParams(base, KEY) };
}

describe("verifyBillplzSignature", () => {
  const base = { id: "bill_1", collection_id: "col_1", paid: "true", amount: "5000", paid_at: "2026-07-19 12:00:00 +0800" };

  it("توقيع صحيح → يمر", () => {
    expect(verifyBillplzSignature(signedParams(base), KEY)).toBe(true);
  });

  it("تلاعب بأي قيمة بعد التوقيع → يفشل", () => {
    const p = signedParams(base);
    p["amount"] = "1";
    expect(verifyBillplzSignature(p, KEY)).toBe(false);
  });

  it("مفتاح مختلف → يفشل؛ x_signature غائب/فارغ/hex فاسد → يفشل بلا رمي", () => {
    expect(verifyBillplzSignature(signedParams(base), "wrong-key")).toBe(false);
    expect(verifyBillplzSignature(base, KEY)).toBe(false);
    expect(verifyBillplzSignature({ ...base, x_signature: "zz-not-hex" }, KEY)).toBe(false);
    expect(verifyBillplzSignature({ ...base, x_signature: "abcd" }, KEY)).toBe(false); // طول أقصر
  });

  it("x_signature نفسه مُقصى من مصدر التوقيع (وإلا ما طابق أبداً)", () => {
    const p = signedParams(base);
    // إعادة التحقق بعد إضافة x_signature للـ params — يجب أن يبقى ماراً (الفلتر يقصيه)
    expect(verifyBillplzSignature({ ...p }, KEY)).toBe(true);
  });
});

describe("createBill (fetch محقون — بلا شبكة)", () => {
  const config = { baseUrl: "https://sandbox.test/api/v3", apiKey: "k", collectionId: "col" };

  it("يرسل form-encoded بمبلغ نصي من bigint ويعيد id/url", async () => {
    let captured: { url: string; body: string; auth: string | null } | null = null;
    const fetchImpl = ((url: string, init: RequestInit) => {
      captured = { url, body: String(init.body), auth: (init.headers as Record<string, string>)["Authorization"] ?? null };
      return Promise.resolve(new Response(JSON.stringify({ id: "bill_9", url: "https://billplz.com/bills/bill_9" }), { status: 200 }));
    }) as unknown as typeof fetch;

    const bill = await createBill({ ...config, fetchImpl }, {
      name: "Sami",
      amountSen: 123_456n,
      description: "Order #1001",
      callbackUrl: "https://qd.test/payments/billplz/t1/callback",
      reference1: "order-uuid",
    });
    expect(bill).toEqual({ id: "bill_9", url: "https://billplz.com/bills/bill_9" });
    expect(captured!.url).toBe("https://sandbox.test/api/v3/bills");
    const params = new URLSearchParams(captured!.body);
    expect(params.get("amount")).toBe("123456"); // D5: نص، لا float
    expect(params.get("collection_id")).toBe("col");
    expect(params.get("reference_1")).toBe("order-uuid");
    expect(captured!.auth).toBe(`Basic ${Buffer.from("k:").toString("base64")}`);
  });

  it("مبلغ ≤ 0 → RangeError قبل أي نداء؛ حالة غير ok → BillplzApiError؛ شكل استجابة غريب → خطأ", async () => {
    await expect(
      createBill(config, { name: "x", amountSen: 0n, description: "d", callbackUrl: "https://cb.test" }),
    ).rejects.toThrow(RangeError);

    const fail = (() => Promise.resolve(new Response("nope", { status: 401 }))) as unknown as typeof fetch;
    await expect(
      createBill({ ...config, fetchImpl: fail }, { name: "x", amountSen: 1n, description: "d", callbackUrl: "https://cb.test" }),
    ).rejects.toThrow(BillplzApiError);

    const weird = (() => Promise.resolve(new Response(JSON.stringify({ nope: true }), { status: 200 }))) as unknown as typeof fetch;
    await expect(
      createBill({ ...config, fetchImpl: weird }, { name: "x", amountSen: 1n, description: "d", callbackUrl: "https://cb.test" }),
    ).rejects.toThrow(/unexpected response shape/);
  });
});
