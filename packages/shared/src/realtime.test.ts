import { describe, expect, it, vi } from "vitest";
import {
  publishRt,
  roomForTenant,
  RT_BOARD_NAMESPACE,
  RT_EVENTS,
  RT_REDIS_CHANNEL,
  rtMessageSchema,
  type RtMessage,
  type RtPublishClient,
} from "./realtime.js";

// §15 — منطق صافٍ: الثوابت والأسماء عقد بين ثلاث عمليات (worker/api/dashboard)؛
// كسرها بتعديل عابر = أحداث تضيع بصمت. الاختبار يثبّت العقد.

describe("realtime rooms and names", () => {
  it("builds the tenant board room from the tenant id", () => {
    expect(roomForTenant("11111111-1111-4111-8111-111111111111")).toBe(
      "tenant:11111111-1111-4111-8111-111111111111:board",
    );
  });

  it("pins the wire names (contract across api/worker/dashboard)", () => {
    expect(RT_BOARD_NAMESPACE).toBe("/board");
    expect(RT_REDIS_CHANNEL).toBe("quickdrop:rt");
    expect(RT_EVENTS.orderChanged).toBe("order.changed");
    expect(RT_EVENTS.driverLocation).toBe("driver.location");
  });
});

describe("rtMessageSchema", () => {
  const tenantId = "22222222-2222-4222-8222-222222222222";

  it("roundtrips an order.changed message through JSON", () => {
    const message: RtMessage = {
      tenantId,
      event: RT_EVENTS.orderChanged,
      payload: { orderId: "33333333-3333-4333-8333-333333333333", to: "assigned" },
    };
    expect(rtMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it("roundtrips a driver.location message through JSON", () => {
    const message: RtMessage = {
      tenantId,
      event: RT_EVENTS.driverLocation,
      payload: {
        driverId: "44444444-4444-4444-8444-444444444444",
        lat: 33.5138,
        lng: 36.2765,
        recordedAt: "2026-07-10T12:00:00.000Z",
      },
    };
    expect(rtMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it("rejects unknown events and out-of-range coordinates", () => {
    expect(rtMessageSchema.safeParse({ tenantId, event: "order.deleted", payload: {} }).success).toBe(false);
    expect(
      rtMessageSchema.safeParse({
        tenantId,
        event: RT_EVENTS.driverLocation,
        payload: {
          driverId: "44444444-4444-4444-8444-444444444444",
          lat: 91, // خارج المدى — قلب lat/lng (الفخ 6) يُلتقط هنا
          lng: 36.2765,
          recordedAt: "2026-07-10T12:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });
});

describe("publishRt", () => {
  const message: RtMessage = {
    tenantId: "22222222-2222-4222-8222-222222222222",
    event: RT_EVENTS.orderChanged,
    payload: { orderId: "33333333-3333-4333-8333-333333333333", to: "delivered" },
  };

  it("publishes the JSON message on the shared channel", async () => {
    const calls: Array<{ channel: string; message: string }> = [];
    const client: RtPublishClient = {
      publish: async (channel, raw) => {
        calls.push({ channel, message: raw });
        return 1;
      },
    };
    await publishRt(client, message);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe(RT_REDIS_CHANNEL);
    expect(JSON.parse(calls[0]?.message ?? "")).toEqual(message);
  });

  it("is best-effort: a failing publish logs a warning and does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client: RtPublishClient = {
        publish: async () => {
          throw new Error("redis down");
        },
      };
      await expect(publishRt(client, message)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(warn.mock.calls[0]?.[0] as string) as { action: string };
      expect(logged.action).toBe("rt_publish_failed");
    } finally {
      warn.mockRestore();
    }
  });
});
