import { describe, expect, it } from "vitest";
import {
  clearConv,
  convKey,
  CONV_TTL_SECONDS,
  loadConv,
  saveConv,
  type ConvRedis,
  type ConvState,
} from "./conversation.js";
import { escapeHtml, orderCard, ORDER_STATUS_LABELS_AR, quoteCard } from "./html.js";

// §15 — اختبارات منطق صافٍ بلا أي اتصالات: mock Redis بـ Map.

class FakeRedis implements ConvRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string, _expiryMode: "EX", ttlSeconds: number): Promise<unknown> {
    this.store.set(key, value);
    this.ttls.set(key, ttlSeconds);
    return Promise.resolve("OK");
  }

  del(key: string): Promise<number> {
    const existed = this.store.delete(key);
    this.ttls.delete(key);
    return Promise.resolve(existed ? 1 : 0);
  }
}

const TENANT = "0197c5e8-0000-7000-8000-000000000001";
const CHAT = 987654321;

describe("escapeHtml (§4.3)", () => {
  it('neutralizes the doc example: اسم "أحمد <b>" بيكسر الرسالة', () => {
    expect(escapeHtml("أحمد <b>")).toBe("أحمد &lt;b&gt;");
  });

  it("escapes all four HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });

  it("escapes & first — no double escaping", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves Arabic text and emoji untouched", () => {
    expect(escapeHtml("طلب توصيل 🛵")).toBe("طلب توصيل 🛵");
  });
});

describe("orderCard", () => {
  it("renders an Arabic RTL card with escaped code and status label", () => {
    const card = orderCard({ publicCode: "1042", status: "pending", priceTotal: 15000n, currency: "SYP" });
    expect(card).toContain("قيد المراجعة");
    expect(card).toContain("#1042");
    expect(card).toContain("<b>");
    expect(card).toMatchSnapshot();
  });

  it("escapes a hostile public code instead of breaking the message", () => {
    const card = orderCard({ publicCode: "<img>", status: "delivered", priceTotal: 0n, currency: "SYP" });
    expect(card).not.toContain("<img>");
    expect(card).toContain("&lt;img&gt;");
    expect(card).toContain(ORDER_STATUS_LABELS_AR.delivered);
  });

  it("has an Arabic label for every order status", () => {
    for (const label of Object.values(ORDER_STATUS_LABELS_AR)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("quoteCard (§4.4: السعر مفصّلاً قبل التأكيد)", () => {
  const components = {
    base: 2000n,
    distance: 3500n,
    weight: 0n,
    surge: 1100n,
    minAdjustment: 0n,
    discount: 0n,
    total: 6600n,
  };

  it("shows only non-zero components plus the total", () => {
    const card = quoteCard({ components, distanceM: 4210, currency: "SYP" });
    expect(card).toContain("الأجرة الأساسية");
    expect(card).toContain("أجرة المسافة");
    expect(card).toContain("زيادة الذروة");
    expect(card).not.toContain("أجرة الوزن");
    expect(card).not.toContain("الخصم");
    expect(card).toContain("الإجمالي");
    expect(card).toContain("4.2 كم");
    expect(card).toMatchSnapshot();
  });
});

describe("conversation state round-trip (§4.4)", () => {
  it("uses the documented key shape conv:{tenantId}:{chatId}", () => {
    expect(convKey(TENANT, CHAT)).toBe(`conv:${TENANT}:${CHAT}`);
  });

  it("serializes and restores a full mid-flow state, with TTL 3600", async () => {
    const redis = new FakeRedis();
    const state: ConvState = {
      step: "awaiting_confirm",
      service: "parcel",
      pickup: { lat: 33.51, lng: 36.29 },
      dropoff: { lat: 33.52, lng: 36.31 },
      quoteTotal: "6600", // D5: bigint يُنقل نصاً — JSON لا يعرف bigint
    };
    await saveConv(redis, TENANT, CHAT, state);
    expect(redis.ttls.get(convKey(TENANT, CHAT))).toBe(CONV_TTL_SECONDS);
    expect(CONV_TTL_SECONDS).toBe(3600);

    const restored = await loadConv(redis, TENANT, CHAT);
    expect(restored).toEqual(state);
  });

  it("returns idle when no state exists (restart أو TTL انتهى — §4.4: ليس بالذاكرة)", async () => {
    const redis = new FakeRedis();
    expect(await loadConv(redis, TENANT, CHAT)).toEqual({ step: "idle" });
  });

  it("resets corrupt JSON to idle and deletes the key instead of wedging the bot", async () => {
    const redis = new FakeRedis();
    redis.store.set(convKey(TENANT, CHAT), "{not json");
    expect(await loadConv(redis, TENANT, CHAT)).toEqual({ step: "idle" });
    expect(redis.store.has(convKey(TENANT, CHAT))).toBe(false);
  });

  it("rejects a state written by an incompatible (future/old) shape via zod (§11)", async () => {
    const redis = new FakeRedis();
    redis.store.set(convKey(TENANT, CHAT), JSON.stringify({ step: "awaiting_signature" }));
    expect(await loadConv(redis, TENANT, CHAT)).toEqual({ step: "idle" });
  });

  it("clearConv reports whether a state was claimed — الفخ 7: ضغطتا تأكيد متسابقتان", async () => {
    const redis = new FakeRedis();
    await saveConv(redis, TENANT, CHAT, { step: "awaiting_pickup", service: "p2p" });
    expect(await clearConv(redis, TENANT, CHAT)).toBe(true);
    expect(await clearConv(redis, TENANT, CHAT)).toBe(false); // الضغطة الثانية لا تكسب شيئاً
  });
});
