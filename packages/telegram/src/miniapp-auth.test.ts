import { describe, expect, it } from "vitest";
import { buildDataCheckString, signInitDataHash, verifyTelegramInitData } from "./miniapp-auth.js";

// §10.3 — تحقق initData: منطق صافٍ. نبني حمولة صحيحة بتوقيع توكن معلوم ثم نتحقق منها،
// ونؤكد الرفض عند: توكن مستأجر آخر (انتحال)، تلاعب، انتهاء، بلا user، صيغة فاسدة.

const BOT_A = "111111:AAA_token_for_tenant_A";
const BOT_B = "222222:BBB_token_for_tenant_B"; // مستأجر آخر

/** يبني initData موقّعاً بتوكن معطى عند auth_date معطى (يحاكي تيليغرام). */
function makeInitData(botToken: string, authUnix: number, user: object): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(authUnix));
  params.set("query_id", "AAH_test_query");
  params.set("user", JSON.stringify(user));
  const hash = signInitDataHash(buildDataCheckString(params), botToken);
  params.set("hash", hash);
  return params.toString();
}

const NOW = new Date("2026-07-18T12:00:00Z");
const FRESH = Math.floor(NOW.getTime() / 1000) - 30; // قبل 30 ثانية
const USER = { id: 42, first_name: "زبون", username: "cust" };

describe("verifyTelegramInitData", () => {
  it("يقبل initData صحيحاً موقّعاً بتوكن نفس المستأجر", () => {
    const initData = makeInitData(BOT_A, FRESH, USER);
    const r = verifyTelegramInitData(initData, BOT_A, { maxAgeSeconds: 300, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user.id).toBe(42);
  });

  it("يرفض التحقق بتوكن مستأجر آخر (انتحال عابر للمستأجرين §10.3)", () => {
    const initData = makeInitData(BOT_A, FRESH, USER); // موقّع بـ A
    const r = verifyTelegramInitData(initData, BOT_B, { maxAgeSeconds: 300, now: NOW }); // نتحقق بـ B
    expect(r).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("يرفض التلاعب بأي حقل بعد التوقيع", () => {
    const initData = makeInitData(BOT_A, FRESH, USER);
    const tampered = new URLSearchParams(initData);
    tampered.set("user", JSON.stringify({ id: 999, first_name: "مهاجم" })); // بدّل الهوية
    const r = verifyTelegramInitData(tampered.toString(), BOT_A, { maxAgeSeconds: 300, now: NOW });
    expect(r).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("يرفض auth_date أقدم من النافذة (منع إعادة التشغيل)", () => {
    const stale = Math.floor(NOW.getTime() / 1000) - 600; // قبل 10 دقائق
    const r = verifyTelegramInitData(makeInitData(BOT_A, stale, USER), BOT_A, { maxAgeSeconds: 300, now: NOW });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("يرفض غياب hash أو صيغته الفاسدة", () => {
    expect(verifyTelegramInitData("auth_date=1&user=%7B%7D", BOT_A, { maxAgeSeconds: 300, now: NOW }).ok).toBe(false);
    expect(verifyTelegramInitData("hash=xyz&auth_date=1", BOT_A, { maxAgeSeconds: 300, now: NOW })).toEqual({
      ok: false,
      reason: "bad_format",
    });
  });

  it("يرفض حمولة صحيحة التوقيع لكن بلا user", () => {
    const params = new URLSearchParams();
    params.set("auth_date", String(FRESH));
    params.set("hash", signInitDataHash(buildDataCheckString(params), BOT_A));
    const r = verifyTelegramInitData(params.toString(), BOT_A, { maxAgeSeconds: 300, now: NOW });
    expect(r).toEqual({ ok: false, reason: "no_user" });
  });

  it("data_check_string يستثني hash ويفرز بالمفتاح", () => {
    const p = new URLSearchParams();
    p.set("b", "2");
    p.set("a", "1");
    p.set("hash", "ZZ");
    expect(buildDataCheckString(p)).toBe("a=1\nb=2");
  });
});
