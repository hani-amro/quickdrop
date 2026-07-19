import { describe, expect, it } from "vitest";
import { flattenCallbackBody } from "./payments.service.js";

// §11 — إسقاط جسم urlencoded لبوابة Billplz: نصوص فقط (قيم متداخلة/مصفوفات تُقصى —
// التوقيع يُحسب على أزواج نصية مسطّحة حصراً).

describe("flattenCallbackBody", () => {
  it("يبقي الأزواج النصية ويقصي المتداخل وغير النصي", () => {
    expect(
      flattenCallbackBody({ id: "bill_1", paid: "true", amount: "5000", nested: { a: "1" }, arr: ["x"], n: 5 }),
    ).toEqual({ id: "bill_1", paid: "true", amount: "5000" });
  });

  it("جسم غير كائن → فارغ (لا رمي على مدخل خارجي)", () => {
    expect(flattenCallbackBody(null)).toEqual({});
    expect(flattenCallbackBody("raw")).toEqual({});
    expect(flattenCallbackBody(undefined)).toEqual({});
  });
});
