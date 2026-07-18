import { describe, expect, it } from "vitest";
import { audienceFilterSchema, journeyStepsSchema, matchesAudience, type AudienceProfile } from "./journeys-service.js";

const prof = (o: Partial<AudienceProfile> = {}): AudienceProfile => ({ lifecycleStage: "active", rfmScore: 50, tags: [], ...o });

describe("matchesAudience (نقية)", () => {
  it("بلا فلتر → يطابق الجميع", () => {
    expect(matchesAudience(prof(), null)).toBe(true);
  });
  it("lifecycleStage: يطابق إن كانت المرحلة ضمن القائمة", () => {
    expect(matchesAudience(prof({ lifecycleStage: "at_risk" }), { lifecycleStage: ["at_risk", "churned"] })).toBe(true);
    expect(matchesAudience(prof({ lifecycleStage: "active" }), { lifecycleStage: ["at_risk"] })).toBe(false);
    expect(matchesAudience(prof({ lifecycleStage: null }), { lifecycleStage: ["at_risk"] })).toBe(false);
  });
  it("minRfm: يطابق إن كان rfm ≥ العتبة", () => {
    expect(matchesAudience(prof({ rfmScore: 80 }), { minRfm: 75 })).toBe(true);
    expect(matchesAudience(prof({ rfmScore: 60 }), { minRfm: 75 })).toBe(false);
    expect(matchesAudience(prof({ rfmScore: null }), { minRfm: 1 })).toBe(false);
  });
  it("tags: يطابق إن احتوى الملف كل الوسوم المطلوبة", () => {
    expect(matchesAudience(prof({ tags: ["vip", "ramadan"] }), { tags: ["vip"] })).toBe(true);
    expect(matchesAudience(prof({ tags: ["vip"] }), { tags: ["vip", "ramadan"] })).toBe(false);
  });
  it("شروط مركّبة: كلها يجب أن تتحقق", () => {
    expect(matchesAudience(prof({ lifecycleStage: "loyal", rfmScore: 90, tags: ["vip"] }), { lifecycleStage: ["loyal"], minRfm: 75, tags: ["vip"] })).toBe(true);
    expect(matchesAudience(prof({ lifecycleStage: "loyal", rfmScore: 60, tags: ["vip"] }), { lifecycleStage: ["loyal"], minRfm: 75, tags: ["vip"] })).toBe(false);
  });
});

describe("journeyStepsSchema (Zod عند الحدود)", () => {
  it("خطوات صالحة تمر", () => {
    const r = journeyStepsSchema.safeParse([
      { type: "send_message", delayHours: 0, template: "مرحبا {name}" },
      { type: "wait", delayHours: 24 },
      { type: "add_tag", delayHours: 0, tag: "followed_up" },
    ]);
    expect(r.success).toBe(true);
  });
  it("send_message بلا قالب يُرفض", () => {
    expect(journeyStepsSchema.safeParse([{ type: "send_message", delayHours: 0 }]).success).toBe(false);
  });
  it("نوع خطوة مجهول يُرفض", () => {
    expect(journeyStepsSchema.safeParse([{ type: "webhook", delayHours: 0 }]).success).toBe(false);
  });
  it("قائمة فارغة أو أطول من 20 تُرفض", () => {
    expect(journeyStepsSchema.safeParse([]).success).toBe(false);
  });
});

describe("audienceFilterSchema", () => {
  it("حقول معروفة فقط (strict)", () => {
    expect(audienceFilterSchema.safeParse({ minRfm: 50 }).success).toBe(true);
    expect(audienceFilterSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(audienceFilterSchema.safeParse({ minRfm: 150 }).success).toBe(false); // خارج 0..100
  });
});
