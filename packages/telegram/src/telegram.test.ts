import { describe, expect, it } from "vitest";
import { assertTokenShape } from "./api.js";
import { assertBotMatchesEnvironment, generateWebhookSecret } from "./secrets.js";

describe("generateWebhookSecret", () => {
  it("produces 64 hex chars, unique per call", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("assertTokenShape", () => {
  it("accepts a well-formed token", () => {
    expect(() => assertTokenShape("7000000001:AAHrX9examplebotTOKENexample12345")).not.toThrow();
  });

  it("rejects garbage without echoing it back", () => {
    try {
      assertTokenShape("not-a-token");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("not-a-token");
    }
  });
});

describe("assertBotMatchesEnvironment (trap 24)", () => {
  it("allows dev bot outside production", () => {
    expect(() => assertBotMatchesEnvironment("office_a_dev_bot", "development")).not.toThrow();
  });

  it("allows production bot in production", () => {
    expect(() => assertBotMatchesEnvironment("office_a_bot", "production")).not.toThrow();
  });

  it("refuses a production bot in development — real customers get test messages", () => {
    expect(() => assertBotMatchesEnvironment("office_a_bot", "development")).toThrow(/trap 24/);
  });

  it("refuses a dev bot in production", () => {
    expect(() => assertBotMatchesEnvironment("office_a_dev_bot", "production")).toThrow(/production/);
  });
});
