import { describe, expect, it } from "vitest";
import {
  BIND_PAYLOAD_RE,
  MERCHANT_ACCEPT_RE,
  MERCHANT_REJECT_RE,
  PREP_OPTIONS,
  merchantAcceptCb,
  merchantBindKey,
  merchantBindPayload,
  merchantRejectCb,
} from "./merchant-flow.js";

// §3/§4.4 — منطق صافٍ: callback_data (حد 64 بايت) وأنماط الالتقاط وكود الربط.
const ORDER = "019f7134-b957-7e76-947f-5154a9725cf2";

describe("merchant callback data", () => {
  it("accept: يبني ويلتقط orderId + مدة التحضير ذهاباً وإياباً", () => {
    for (const min of PREP_OPTIONS) {
      const data = merchantAcceptCb(ORDER, min);
      const m = MERCHANT_ACCEPT_RE.exec(data);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(ORDER);
      expect(Number.parseInt(m![2]!, 10)).toBe(min);
    }
  });

  it("reject: يبني ويلتقط orderId", () => {
    const m = MERCHANT_REJECT_RE.exec(merchantRejectCb(ORDER));
    expect(m).not.toBeNull();
    expect(m![1]).toBe(ORDER);
  });

  it("كل callback_data ضمن حد تيليغرام 64 بايت (§4.4)", () => {
    expect(Buffer.byteLength(merchantAcceptCb(ORDER, 45), "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(merchantRejectCb(ORDER), "utf8")).toBeLessThanOrEqual(64);
  });

  it("لا يخلط زرّي القبول والرفض", () => {
    expect(MERCHANT_REJECT_RE.exec(merchantAcceptCb(ORDER, 15))).toBeNull();
    expect(MERCHANT_ACCEPT_RE.exec(merchantRejectCb(ORDER))).toBeNull();
  });
});

describe("merchant bind", () => {
  it("payload الرابط العميق يطابق نمط الالتقاط", () => {
    const payload = merchantBindPayload("a1b2c3d4e5f6");
    const m = BIND_PAYLOAD_RE.exec(payload);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("a1b2c3d4e5f6");
  });

  it("يرفض حمولات غير كود الربط (فيمرّر لتدفق الزبون)", () => {
    expect(BIND_PAYLOAD_RE.exec("")).toBeNull();
    expect(BIND_PAYLOAD_RE.exec("mrc_")).toBeNull(); // أقصر من 6
    expect(BIND_PAYLOAD_RE.exec("hello")).toBeNull();
  });

  it("مفتاح Redis معزول بالمستأجر", () => {
    expect(merchantBindKey("t1", "code")).toBe("mbind:t1:code");
    expect(merchantBindKey("t1", "c")).not.toBe(merchantBindKey("t2", "c"));
  });
});
