import { describe, expect, it } from "vitest";
import { LOCATION_RETENTION_MS, retentionCutoffs, WEBHOOK_RETENTION_MS } from "./housekeeping.js";

describe("housekeeping retention cutoffs (§3/§16.25)", () => {
  it("webhook cutoff is 48h before now", () => {
    const now = new Date("2026-07-12T12:00:00Z");
    expect(now.getTime() - retentionCutoffs(now).webhooks.getTime()).toBe(WEBHOOK_RETENTION_MS);
  });

  it("location cutoff is 90 days before now", () => {
    const now = new Date("2026-07-12T12:00:00Z");
    expect(now.getTime() - retentionCutoffs(now).locations.getTime()).toBe(LOCATION_RETENTION_MS);
  });

  it("the two retentions differ (48h vs 90d)", () => {
    expect(LOCATION_RETENTION_MS).toBeGreaterThan(WEBHOOK_RETENTION_MS);
  });
});
