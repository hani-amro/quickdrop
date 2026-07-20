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

  // P5.2 — MYR سنتات (sen) من طرف لطرف: المبلغ bigint بأصغر وحدة MYR ويُرسَل نصاً صحيحاً
  // بلا فاصلة عشرية ولا أثر float. Billplz تعرض على صفحتها قنوات الدفع الماليزية (FPX
  // ومنها DuitNow، والبطاقات) — تكاملنا محايد للقناة: نُنشئ فاتورة MYR والزبون يختار القناة.
  it("MYR sen طرف-لطرف: مبالغ واقعية تُرسَل أعداداً صحيحة بلا نقطة عشرية (لا float)", async () => {
    const cases: Array<{ ringgit: string; sen: bigint }> = [
      { ringgit: "RM 0.50", sen: 50n },
      { ringgit: "RM 10.00", sen: 1_000n },
      { ringgit: "RM 1,234.56", sen: 123_456n },
      { ringgit: "RM 9,999.99", sen: 999_999n },
    ];
    for (const c of cases) {
      let body = "";
      const fetchImpl = ((_url: string, init: RequestInit) => {
        body = String(init.body);
        return Promise.resolve(new Response(JSON.stringify({ id: "b", url: "https://billplz.com/bills/b" }), { status: 200 }));
      }) as unknown as typeof fetch;
      await createBill({ ...config, fetchImpl }, {
        name: "Ahmad",
        amountSen: c.sen,
        description: `Food order (${c.ringgit})`,
        callbackUrl: "https://qd.test/payments/billplz/t1/callback",
      });
      const amount = new URLSearchParams(body).get("amount");
      expect(amount).toBe(c.sen.toString()); // سنتات صحيحة
      expect(amount).not.toContain("."); // لا فاصلة عشرية — لا float بالمسار (D3)
      expect(amount).toMatch(/^\d+$/); // أرقام فقط
    }
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
