import { GrammyError } from "grammy";
import { describe, expect, it } from "vitest";
import {
  BROADCAST_DELIVERED_TTL_S,
  BROADCAST_MSG_INTERVAL_MS,
  broadcastText,
  failedSetKey,
  isAlreadyDelivered,
  isBlockedByUser,
  isRateLimited,
  recordInDeliverySet,
  retryAfterMs,
  sentSetKey,
  type BroadcastSetRedis,
} from "./broadcast-consumer.js";

// §15 — وحدات: منطق صافٍ فقط، بلا أي اتصال قاعدة/Redis/تيليغرام.

/** §15 — Redis مزيّف لمجموعات التسليم: Map<string, Set<string>> بلا أي اتصال. */
class FakeBroadcastRedis implements BroadcastSetRedis {
  readonly sets = new Map<string, Set<string>>();
  readonly ttls = new Map<string, number>();

  sismember(key: string, member: string): Promise<number> {
    return Promise.resolve(this.sets.get(key)?.has(member) === true ? 1 : 0);
  }
  sadd(key: string, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const isNew = !set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return Promise.resolve(isNew ? 1 : 0);
  }
  scard(key: string): Promise<number> {
    return Promise.resolve(this.sets.get(key)?.size ?? 0);
  }
  expire(key: string, ttlSeconds: number): Promise<unknown> {
    this.ttls.set(key, ttlSeconds);
    return Promise.resolve(1);
  }
}

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

describe("§12 استئناف البث — مجموعة المُسلَّم إليهم بـ Redis (منطق التخطّي الصافي)", () => {
  const BID = "0197c5e8-0000-7000-8000-0000000000aa";
  const OTHER = "0197c5e8-0000-7000-8000-0000000000bb";

  it("مفاتيح المجموعات مشتقّة من معرّف البثّة (عزل لكل بثّة)", () => {
    expect(sentSetKey(BID)).toBe(`bcast:sent:${BID}`);
    expect(failedSetKey(BID)).toBe(`bcast:failed:${BID}`);
  });

  it("قبل أي تسليم: لا أحد مُسلَّم إليه", async () => {
    const redis = new FakeBroadcastRedis();
    expect(await isAlreadyDelivered(redis, BID, "u1")).toBe(false);
  });

  it("بعد التسجيل: يُتخطّى العضو، وبثّة أخرى/عضو آخر غير متأثر (عزل بالمعرّف)", async () => {
    const redis = new FakeBroadcastRedis();
    await recordInDeliverySet(redis, sentSetKey(BID), "u1");
    expect(await isAlreadyDelivered(redis, BID, "u1")).toBe(true);
    expect(await isAlreadyDelivered(redis, BID, "u2")).toBe(false);
    expect(await isAlreadyDelivered(redis, OTHER, "u1")).toBe(false);
  });

  it("recordInDeliverySet يضبط TTL أسبوع وهو idempotent (SADD مكرّر لا يضاعف الحجم)", async () => {
    const redis = new FakeBroadcastRedis();
    await recordInDeliverySet(redis, sentSetKey(BID), "u1");
    await recordInDeliverySet(redis, sentSetKey(BID), "u1"); // تكرار — لا يضاعف
    expect(redis.ttls.get(sentSetKey(BID))).toBe(BROADCAST_DELIVERED_TTL_S);
    expect(BROADCAST_DELIVERED_TTL_S).toBe(7 * 24 * 60 * 60);
    expect(await redis.scard(sentSetKey(BID))).toBe(1);
  });

  it("محاكاة الاستئناف: الجولة الثانية تتخطّى ما سُلِّم وترسل الذيل فقط، والعدّ مطلق لا لكل جولة", async () => {
    const redis = new FakeBroadcastRedis();
    const audience = ["u1", "u2", "u3", "u4"];

    // الجولة 1: سُلِّم u1,u2 ثم "انهيار" قبل u3,u4 (قبل recordBroadcastResult)
    const run1Sent: string[] = [];
    for (const u of audience) {
      if (await isAlreadyDelivered(redis, BID, u)) continue;
      if (u === "u3") break; // انهيار قبل إرسال الذيل
      await recordInDeliverySet(redis, sentSetKey(BID), u);
      run1Sent.push(u);
    }
    expect(run1Sent).toEqual(["u1", "u2"]);
    expect(await redis.scard(sentSetKey(BID))).toBe(2);

    // الجولة 2 (إعادة تشغيل): نفس الجمهور كاملاً — يُتخطّى u1,u2 ويُرسَل u3,u4
    const run2Sent: string[] = [];
    const skipped: string[] = [];
    for (const u of audience) {
      if (await isAlreadyDelivered(redis, BID, u)) {
        skipped.push(u);
        continue;
      }
      await recordInDeliverySet(redis, sentSetKey(BID), u);
      run2Sent.push(u);
    }
    expect(skipped).toEqual(["u1", "u2"]); // لا إعادة إرسال للكل — هذا جوهر الإصلاح
    expect(run2Sent).toEqual(["u3", "u4"]);
    // العدّ النهائي مطلق من المجموعة = 4 (لا 2 لكل جولة) → recordBroadcastResult idempotent
    expect(await redis.scard(sentSetKey(BID))).toBe(4);
  });
});
