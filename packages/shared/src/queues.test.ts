import { describe, expect, it } from "vitest";
import { scheduledJobId } from "./queues.js";

// §6.3 — انحدار: BullMQ يرمي "Custom Id cannot contain :" لأي custom jobId يحوي ':'
// (محجوز لمفاتيح Redis). كسر هذا يجعل كل طلب مجدول يرجع 500 ويُسقط الـ worker عند
// إعادة الجدولة. المصدر الواحد المشترك (api + worker) يمنع التباعد.
describe("scheduledJobId", () => {
  const id = "019f7120-c755-7438-bb63-d47faf2390d4";

  it("لا يحوي ':' أبداً (قيد BullMQ)", () => {
    expect(scheduledJobId(id)).not.toContain(":");
  });

  it("حتمي: نفس الطلب ⇒ نفس المعرّف (idempotency لإعادة جدولة الإقلاع)", () => {
    expect(scheduledJobId(id)).toBe(scheduledJobId(id));
  });

  it("مميّز لكل طلب ويحمل معرّفه", () => {
    expect(scheduledJobId(id)).toBe(`sched-${id}`);
    expect(scheduledJobId("a")).not.toBe(scheduledJobId("b"));
  });
});
