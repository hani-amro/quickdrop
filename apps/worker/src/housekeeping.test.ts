import { describe, expect, it } from "vitest";
import {
  LOCATION_RETENTION_MS,
  OUTBOX_FAILED_RETENTION_MS,
  OUTBOX_SENT_RETENTION_MS,
  retentionCutoffs,
  WEBHOOK_RETENTION_MS,
} from "./housekeeping.js";

describe("housekeeping retention cutoffs (§3/§16.25/R-16)", () => {
  const now = new Date("2026-07-12T12:00:00Z");

  it("webhook cutoff is 48h before now", () => {
    expect(now.getTime() - retentionCutoffs(now).webhooks.getTime()).toBe(WEBHOOK_RETENTION_MS);
  });

  it("location cutoff is 90 days before now", () => {
    expect(now.getTime() - retentionCutoffs(now).locations.getTime()).toBe(LOCATION_RETENTION_MS);
  });

  it("outbox sent cutoff is 7 days, failed 30 days (R-16 — كانت sent تتراكم للأبد)", () => {
    expect(now.getTime() - retentionCutoffs(now).outboxSent.getTime()).toBe(OUTBOX_SENT_RETENTION_MS);
    expect(now.getTime() - retentionCutoffs(now).outboxFailed.getTime()).toBe(OUTBOX_FAILED_RETENTION_MS);
    expect(OUTBOX_FAILED_RETENTION_MS).toBeGreaterThan(OUTBOX_SENT_RETENTION_MS); // failed أطول للتشخيص
  });

  it("the retentions differ (48h vs 90d)", () => {
    expect(LOCATION_RETENTION_MS).toBeGreaterThan(WEBHOOK_RETENTION_MS);
  });
});
