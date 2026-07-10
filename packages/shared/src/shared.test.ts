import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, secretsEqual } from "./crypto.js";
import { fromTelegram, toPostgisWkt } from "./geo.js";
import { newId } from "./ids.js";
import { tenantDay } from "./time.js";

describe("crypto", () => {
  const key = randomBytes(32);

  it("roundtrips a bot token", () => {
    const token = "7000000001:AAHrX9examplebotTOKENexample_dev_bot";
    const encrypted = encryptSecret(token, key);
    expect(decryptSecret(encrypted, key)).toBe(token);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptSecret("secret", key);
    encrypted[encrypted.length - 1]! ^= 0xff;
    expect(() => decryptSecret(encrypted, key)).toThrow();
  });

  it("rejects a short master key", () => {
    expect(() => encryptSecret("x", randomBytes(16))).toThrow(RangeError);
  });

  it("compares secrets safely", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "ab")).toBe(false);
  });
});

describe("tenantDay", () => {
  it("splits the day at the tenant timezone, not the server one", () => {
    // 22:30 UTC = 01:30 بدمشق (UTC+3 صيفاً) — يوم جديد عند المستأجر
    const ts = new Date("2026-07-09T22:30:00Z");
    expect(tenantDay("Asia/Damascus", ts)).toBe("2026-07-10");
    expect(tenantDay("UTC", ts)).toBe("2026-07-09");
  });
});

describe("geo", () => {
  it("converts telegram order (lat,lng) to WKT order (lng lat)", () => {
    const point = fromTelegram({ latitude: 33.5138, longitude: 36.2765 });
    expect(toPostgisWkt(point)).toBe("POINT(36.2765 33.5138)");
  });

  it("rejects out-of-range coordinates", () => {
    expect(() => fromTelegram({ latitude: 91, longitude: 0 })).toThrow(RangeError);
  });
});

describe("ids", () => {
  it("generates sortable v7 ids", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
