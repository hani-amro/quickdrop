import { scheduledJobId, tgUpdateJobId, waUpdateJobId } from "@quickdrop/shared";
import { describe, expect, it } from "vitest";
import { dispatchOrderJobId, offerTimeoutJobId } from "./dispatch-worker.js";

// انحدار: BullMQ يرمي "Custom Id cannot contain :" (مثبت تجريبياً ضد Redis الحي).
// الصيغ القديمة d:/ot:/tenantId:updateId كانت تُفشل كل enqueue بمسار الإنتاج —
// كل مولّدات jobId الحتمية بالنظام تُفحص هنا كي لا يعود ':' أبداً.

const UUID = "11111111-1111-4111-8111-111111111111";

describe("deterministic jobIds — ':'-free (BullMQ constraint)", () => {
  const ids = [
    dispatchOrderJobId(UUID, 3),
    offerTimeoutJobId(UUID),
    scheduledJobId(UUID),
    tgUpdateJobId(UUID, 123456789),
    waUpdateJobId(UUID),
  ];

  it("لا يحتوي أي jobId على ':'", () => {
    for (const id of ids) expect(id, id).not.toContain(":");
  });

  it("المولّدات حتمية ومميّزة بين الأنواع (لا تصادم بادئات)", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(dispatchOrderJobId(UUID, 3)).toBe(dispatchOrderJobId(UUID, 3));
  });
});
