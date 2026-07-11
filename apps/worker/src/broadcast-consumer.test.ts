import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";
import {
  BROADCAST_MSG_INTERVAL_MS,
  broadcastText,
  isBlockedByUser,
  isRateLimited,
  retryAfterMs,
} from "./broadcast-consumer.js";

// §15 — وحدات: منطق صافٍ فقط، بلا أي اتصال قاعدة/Redis/تيليغرام.

function grammyError(code: number, description: string, parameters?: { retry_after?: number }): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description, ...(parameters !== undefined ? { parameters } : {}) },
    "sendMessage",
    {},
  );
}

describe("§4.3 نص البثّة — تهريب HTML وتنسيق العنوان", () => {
  it("يهرّب محارف HTML في النص (parse_mode HTML — منع كسر الرسالة)", () => {
    const text = broadcastText(null, 'عرض <b>خاص</b> & "اليوم"');
    expect(text).toBe('عرض &lt;b&gt;خاص&lt;/b&gt; &amp; &quot;اليوم&quot;');
  });

  it("العنوان عريض فوق النص، وكلاهما مُهرَّب", () => {
    const text = broadcastText("عرض <العيد>", "أهلاً");
    expect(text).toBe("<b>عرض &lt;العيد&gt;</b>\n\nأهلاً");
  });

  it("عنوان فارغ أو فراغات = النص وحده بلا سطر عنوان", () => {
    expect(broadcastText("", "مرحبا")).toBe("مرحبا");
    expect(broadcastText("   ", "مرحبا")).toBe("مرحبا");
    expect(broadcastText(null, "مرحبا")).toBe("مرحبا");
  });
});

describe("§4.3 تصنيف حدود تيليغرام", () => {
  it("403 = المستخدم حظر البوت", () => {
    expect(isBlockedByUser(grammyError(403, "Forbidden: bot was blocked by the user"))).toBe(true);
    expect(isBlockedByUser(grammyError(429, "Too Many Requests"))).toBe(false);
    expect(isBlockedByUser(new Error("network"))).toBe(false);
  });

  it("429 = تجاوز حدّ المعدل", () => {
    expect(isRateLimited(grammyError(429, "Too Many Requests: retry after 3"))).toBe(true);
    expect(isRateLimited(grammyError(403, "Forbidden"))).toBe(false);
  });
});

describe("§4.3 مدة الانتظار بعد 429 (retry_after)", () => {
  it("يقرأ retry_after (ثوانٍ→مللي) ويضيف jitter ضمن نافذة معلومة", () => {
    const ms = retryAfterMs(grammyError(429, "Too Many Requests", { retry_after: 3 }));
    expect(ms).toBeGreaterThanOrEqual(3000);
    expect(ms).toBeLessThan(3000 + 250);
  });

  it("بلا retry_after → ثانية افتراضية + jitter", () => {
    const ms = retryAfterMs(grammyError(429, "Too Many Requests"));
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThan(1000 + 250);
  });
});

describe("حدّ المعدل ثابت تحت سقف 30/s (§4.3)", () => {
  it("التأخير بين الرسائل يبقي المعدل دون 30 رسالة/ثانية", () => {
    // 1000 / الفاصل = المعدل الأقصى؛ يجب أن يكون < 30
    expect(1000 / BROADCAST_MSG_INTERVAL_MS).toBeLessThan(30);
  });
});
