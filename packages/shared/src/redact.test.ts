import { describe, expect, it } from "vitest";
import { REDACTED, REDACTED_TOKEN, redactSecrets } from "./redact.js";

// §11/§4.2 — الـ redactor: توكنات بوت، هواتف E.164، وحقول token/password/secret بأي JSON نصي.

const TOKEN = "123456789:AAF0aBcDeFgHiJkLmNoPqRsTuVwXyZ01234";

describe("redactSecrets — توكن بوت تيليغرام (§4.2)", () => {
  it("redacts a bare bot token", () => {
    expect(redactSecrets(`failed for ${TOKEN} now`)).toBe(`failed for ${REDACTED_TOKEN} now`);
  });

  it("redacts a token inside an HttpError-style URL", () => {
    const msg = `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`;
    const out = redactSecrets(msg);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(`/bot${REDACTED_TOKEN}/sendMessage`);
  });

  it("redacts a token at the 30-char body boundary exactly", () => {
    const minimal = `42:${"a".repeat(30)}`;
    expect(redactSecrets(minimal)).toBe(REDACTED_TOKEN);
  });

  it("leaves short digit:word pairs alone — timestamps and ratios are not tokens", () => {
    expect(redactSecrets("at 12:30 ratio 1:2 key 99:tooShortBody")).toBe("at 12:30 ratio 1:2 key 99:tooShortBody");
  });

  it("redacts multiple tokens in one text", () => {
    const out = redactSecrets(`${TOKEN} and 55:${"B".repeat(31)}`);
    expect(out).toBe(`${REDACTED_TOKEN} and ${REDACTED_TOKEN}`);
  });
});

describe("redactSecrets — هواتف E.164 (§11: تُعرض مقنّعة، آخر خانتين فقط)", () => {
  it("masks a Syrian number keeping prefix and last two digits", () => {
    expect(redactSecrets("call +963991234542 now")).toBe("call +963•••••42 now");
  });

  it("masks the shortest E.164 form (8 digits)", () => {
    expect(redactSecrets("+12345678")).toBe("+123•••••78");
  });

  it("masks the longest E.164 form (15 digits)", () => {
    expect(redactSecrets("+123456789012345")).toBe("+123•••••45");
  });

  it("uses a fixed-length mask — real length does not leak", () => {
    const short = redactSecrets("+96311223344");
    const long = redactSecrets("+963112233445566");
    expect(short.length).toBe("+963•••••44".length);
    expect(long.length).toBe("+963•••••66".length);
  });

  it("leaves too-short (+7 digits) and too-long (16+ digits) runs untouched — not E.164", () => {
    expect(redactSecrets("+1234567")).toBe("+1234567");
    expect(redactSecrets("+1234567890123456")).toBe("+1234567890123456");
  });

  it("leaves plain digit runs without + untouched", () => {
    expect(redactSecrets("order 963991234542")).toBe("order 963991234542");
  });

  it("masks a phone embedded in an Arabic sentence", () => {
    expect(redactSecrets("الزبون رقمه +963991112233 ما ردّ")).toBe("الزبون رقمه +963•••••33 ما ردّ");
  });
});

describe("redactSecrets — حقول token/password/secret بأي JSON نصي (§11)", () => {
  it("redacts values of token/password/secret keys", () => {
    expect(redactSecrets('{"token":"abc","password":"hunter2","secret":"s3cr3t"}')).toBe(
      `{"token":"${REDACTED}","password":"${REDACTED}","secret":"${REDACTED}"}`,
    );
  });

  it("matches key names containing the words, case-insensitively", () => {
    expect(redactSecrets('{"BOT_TOKEN":"x","clientSecret":"y","UserPassword":"z"}')).toBe(
      `{"BOT_TOKEN":"${REDACTED}","clientSecret":"${REDACTED}","UserPassword":"${REDACTED}"}`,
    );
  });

  it("preserves whitespace around the colon", () => {
    expect(redactSecrets('{"api_token" : "abc"}')).toBe(`{"api_token" : "${REDACTED}"}`);
  });

  it("redacts values containing escaped quotes fully", () => {
    expect(redactSecrets('{"password":"a\\"b\\"c"}')).toBe(`{"password":"${REDACTED}"}`);
  });

  it("leaves non-string values untouched — token-shaped strings are still caught by the pattern pass", () => {
    expect(redactSecrets('{"token":123,"count":5}')).toBe('{"token":123,"count":5}');
  });

  it("leaves unrelated JSON fields untouched", () => {
    expect(redactSecrets('{"status":"pending","note":"وصل"}')).toBe('{"status":"pending","note":"وصل"}');
  });

  it("redacts a token value even when it does not look like a Telegram token", () => {
    expect(redactSecrets('{"password":"short"}')).toBe(`{"password":"${REDACTED}"}`);
  });
});

describe("redactSecrets — تركيب وسلامة", () => {
  it("handles a log line with all three secret kinds at once", () => {
    const line = `GrammyError at https://api.telegram.org/bot${TOKEN}/sendMessage payload {"phone":"+963991234542","bot_token":"${TOKEN}"} for +963991234542`;
    const out = redactSecrets(line);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("+963991234542");
    expect(out).toContain(REDACTED_TOKEN);
    expect(out).toContain(`"bot_token":"${REDACTED}"`);
    expect(out).toContain("+963•••••42");
  });

  it("is idempotent — applying twice changes nothing more", () => {
    const line = `t=${TOKEN} p=+963991234542 j={"secret":"x"}`;
    const once = redactSecrets(line);
    expect(redactSecrets(once)).toBe(once);
  });

  it("returns plain Arabic text unchanged", () => {
    expect(redactSecrets("صار خطأ مؤقت بالشبكة")).toBe("صار خطأ مؤقت بالشبكة");
  });

  it("returns the empty string unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });
});
