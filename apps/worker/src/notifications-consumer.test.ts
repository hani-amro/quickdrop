import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";
import { DISPATCH_JOB_OPTS, dispatchOrderJobId, offerTimeoutJobId } from "./dispatch-worker.js";
import {
  isBlockedByUser,
  isMessageNotModified,
  offerAcceptCallbackData,
  offerCreatedPayloadSchema,
  offerRejectCallbackData,
  offerTimeoutDelayMs,
  orderStatusChangedPayloadSchema,
  supportReplyPayloadSchema,
} from "./notifications-consumer.js";

// §15 — وحدات: منطق صافٍ فقط، بلا أي اتصال قاعدة/Redis/تيليغرام.

function grammyError(code: number, description: string): GrammyError {
  return new GrammyError(`Call to 'sendMessage' failed! (${code}: ${description})`, {
    ok: false,
    error_code: code,
    description,
  }, "sendMessage", {});
}

const OFFER_ID = "0198c2e6-1111-7abc-8def-123456789abc";
const ORDER_ID = "0198c2e6-2222-7abc-8def-123456789abc";
const DRIVER_ID = "0198c2e6-3333-7abc-8def-123456789abc";

describe("offerTimeoutDelayMs", () => {
  it("يرجع الفارق الموجب بين expires_at والآن", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const expiresAt = new Date("2026-01-01T12:00:45Z");
    expect(offerTimeoutDelayMs(expiresAt, now)).toBe(45_000);
  });

  it("مهلة فاتت (صف outbox تأخر) → 0 أي تنفيذ فوري، لا delay سالب", () => {
    const now = new Date("2026-01-01T12:01:00Z");
    const expiresAt = new Date("2026-01-01T12:00:45Z");
    expect(offerTimeoutDelayMs(expiresAt, now)).toBe(0);
  });

  it("لحظة الانتهاء بالضبط → 0", () => {
    const at = new Date("2026-01-01T12:00:45Z");
    expect(offerTimeoutDelayMs(at, at)).toBe(0);
  });
});

describe("§4.3 تصنيف أخطاء تيليغرام", () => {
  it("400 'message is not modified' تُلتقط وتُتجاهل", () => {
    const err = grammyError(400, "Bad Request: message is not modified");
    expect(isMessageNotModified(err)).toBe(true);
    expect(isBlockedByUser(err)).toBe(false);
  });

  it("400 بوصف آخر ليست not-modified", () => {
    const err = grammyError(400, "Bad Request: message to edit not found");
    expect(isMessageNotModified(err)).toBe(false);
  });

  it("403 (المستخدم حظر البوت) → blocked ولا إعادة محاولة", () => {
    const err = grammyError(403, "Forbidden: bot was blocked by the user");
    expect(isBlockedByUser(err)).toBe(true);
    expect(isMessageNotModified(err)).toBe(false);
  });

  it("خطأ عادي (شبكة/برمجي) ليس أياً منهما — يُعاد رميه للـ retry", () => {
    const err = new Error("ECONNRESET");
    expect(isMessageNotModified(err)).toBe(false);
    expect(isBlockedByUser(err)).toBe(false);
  });
});

describe("§4.4 callback_data ≤ 64 بايت", () => {
  it("off:acc/off:rej مع UUID ضمن الحد", () => {
    const acc = offerAcceptCallbackData(OFFER_ID);
    const rej = offerRejectCallbackData(OFFER_ID);
    expect(acc).toBe(`off:acc:${OFFER_ID}`);
    expect(rej).toBe(`off:rej:${OFFER_ID}`);
    expect(Buffer.byteLength(acc, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(rej, "utf8")).toBeLessThanOrEqual(64);
  });
});

describe("معرّفات مهام الإسناد (إزالة تكرار at-least-once §12)", () => {
  it("حتمية: نفس المدخلات → نفس jobId", () => {
    expect(dispatchOrderJobId(ORDER_ID, 1)).toBe(`d:${ORDER_ID}:1`);
    expect(dispatchOrderJobId(ORDER_ID, 3)).toBe(`d:${ORDER_ID}:3`);
    expect(offerTimeoutJobId(OFFER_ID)).toBe(`ot:${OFFER_ID}`);
  });

  it("خيارات BullMQ الموحّدة (§12): attempts/backoff/removeOnComplete", () => {
    expect(DISPATCH_JOB_OPTS.attempts).toBe(5);
    expect(DISPATCH_JOB_OPTS.backoff).toEqual({ type: "exponential", delay: 1000 });
    expect(DISPATCH_JOB_OPTS.removeOnComplete).toEqual({ count: 1000 });
  });
});

describe("§11 تحقق حمولات الطوابير عند الاستهلاك", () => {
  it("order.status_changed: حمولة سليمة تمر", () => {
    const parsed = orderStatusChangedPayloadSchema.parse({ orderId: ORDER_ID, from: "pending", to: "confirmed" });
    expect(parsed.to).toBe("confirmed");
  });

  it("order.status_changed: حالة خارج ORDER_STATUSES تُرفض", () => {
    expect(() =>
      orderStatusChangedPayloadSchema.parse({ orderId: ORDER_ID, from: "pending", to: "busy" }),
    ).toThrow();
  });

  it("offer.created: expiresAt نص ISO (jsonb) يُعاد Date", () => {
    const parsed = offerCreatedPayloadSchema.parse({
      offerId: OFFER_ID,
      orderId: ORDER_ID,
      driverId: DRIVER_ID,
      round: 2,
      expiresAt: "2026-01-01T12:00:45.000Z",
    });
    expect(parsed.expiresAt).toBeInstanceOf(Date);
    expect(parsed.expiresAt.toISOString()).toBe("2026-01-01T12:00:45.000Z");
  });

  it("offer.created: round صفر أو سالب يُرفض (الجولات تبدأ من 1 §6.2)", () => {
    expect(() =>
      offerCreatedPayloadSchema.parse({
        offerId: OFFER_ID,
        orderId: ORDER_ID,
        driverId: DRIVER_ID,
        round: 0,
        expiresAt: "2026-01-01T12:00:45.000Z",
      }),
    ).toThrow();
  });

  it("support.reply: threadId + نص غير فارغ يمر", () => {
    const parsed = supportReplyPayloadSchema.parse({ threadId: ORDER_ID, text: "أهلاً، كيف نساعدك؟" });
    expect(parsed.text).toBe("أهلاً، كيف نساعدك؟");
  });

  it("support.reply: نص فارغ أو threadId غير UUID يُرفض (§11)", () => {
    expect(() => supportReplyPayloadSchema.parse({ threadId: ORDER_ID, text: "" })).toThrow();
    expect(() => supportReplyPayloadSchema.parse({ threadId: "not-a-uuid", text: "مرحبا" })).toThrow();
  });
});
