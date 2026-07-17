import { describe, expect, it } from "vitest";
import { InvalidAdjustmentError, validateAdjustment } from "./settlement.js";

// §15 — وحدة: منطق صافٍ فقط (إشارة قيد التصحيح). لا اتصال قاعدة —
// validateAdjustment يعكس CHECK ledger_entries_sign_ck ليُرفَض الإدخال قبل ضرب القاعدة.
// §8.2: adjustment ≠ 0 (± حسب من المدين)؛ payout < 0 (المكتب يدفع للسائق).

describe("validateAdjustment — إشارة قيد التصحيح اليدوي (§8.1/§8.2)", () => {
  it("adjustment موجب أو سالب يمرّ (± مسموح ما دام ≠ 0)", () => {
    expect(() => validateAdjustment("adjustment", 1n)).not.toThrow();
    expect(() => validateAdjustment("adjustment", -1n)).not.toThrow();
    expect(() => validateAdjustment("adjustment", 500_000n)).not.toThrow();
    expect(() => validateAdjustment("adjustment", -500_000n)).not.toThrow();
  });

  it("adjustment صفري مرفوض — عبث بلا معنى محاسبي (§8.3)", () => {
    expect(() => validateAdjustment("adjustment", 0n)).toThrow(InvalidAdjustmentError);
  });

  it("payout سالب يمرّ — المكتب يدفع للسائق (قيد سالب بالمنظور المُلزم §8.1)", () => {
    expect(() => validateAdjustment("payout", -1n)).not.toThrow();
    expect(() => validateAdjustment("payout", -12_000n)).not.toThrow();
  });

  it("payout صفري أو موجب مرفوض — CHECK يطلب < 0 حصراً", () => {
    expect(() => validateAdjustment("payout", 0n)).toThrow(InvalidAdjustmentError);
    expect(() => validateAdjustment("payout", 1n)).toThrow(InvalidAdjustmentError);
    expect(() => validateAdjustment("payout", 12_000n)).toThrow(InvalidAdjustmentError);
  });
});
