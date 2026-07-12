import { describe, expect, it } from "vitest";
import { bumpOrderRate, isOverLimit, ORDER_LIMIT_PER_HOUR } from "./rate-limit.js";
import { computeSendDelay, newThrottleState } from "./throttler.js";

describe("throttler computeSendDelay (§4.3)", () => {
  const opts = { globalPerSec: 25, perChatPerSec: 1 };

  it("first send has no delay", () => {
    expect(computeSendDelay(newThrottleState(), "100", 1000, opts)).toBe(0);
  });

  it("enforces a 1s gap for the same chat", () => {
    const state = newThrottleState();
    computeSendDelay(state, "100", 1000, opts);
    expect(computeSendDelay(state, "100", 1000, opts)).toBe(1000);
  });

  it("enforces the global gap across different chats", () => {
    const state = newThrottleState();
    computeSendDelay(state, "1", 1000, opts); // global next at 1040
    expect(computeSendDelay(state, "2", 1000, opts)).toBe(40); // 1000/25
  });

  it("no delay once enough time has passed", () => {
    const state = newThrottleState();
    computeSendDelay(state, "100", 1000, opts);
    expect(computeSendDelay(state, "100", 5000, opts)).toBe(0);
  });

  it("chatless methods only pay the global gap", () => {
    const state = newThrottleState();
    computeSendDelay(state, null, 1000, opts);
    expect(computeSendDelay(state, null, 1000, opts)).toBe(40);
  });
});

describe("bot order rate limit (§11)", () => {
  it("isOverLimit triggers strictly above the cap", () => {
    expect(isOverLimit(ORDER_LIMIT_PER_HOUR)).toBe(false); // 5th allowed
    expect(isOverLimit(ORDER_LIMIT_PER_HOUR + 1)).toBe(true); // 6th blocked
  });

  it("bumpOrderRate sets the TTL only on the first order of the window", async () => {
    let value = 0;
    const expireCalls: number[] = [];
    const redis = {
      get: async (): Promise<string | null> => null,
      set: async (): Promise<string> => "OK",
      del: async (): Promise<number> => 0,
      incr: async (): Promise<number> => ++value,
      expire: async (_k: string, ttl: number): Promise<number> => {
        expireCalls.push(ttl);
        return 1;
      },
    };
    await bumpOrderRate(redis, "t1", 42);
    await bumpOrderRate(redis, "t1", 42);
    expect(expireCalls).toEqual([3600]);
  });
});
