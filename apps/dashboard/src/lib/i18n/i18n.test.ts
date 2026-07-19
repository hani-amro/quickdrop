import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isLocale, LOCALES, localeDir, resolveLocale } from "./locales";
import { getMessages, translate } from "./messages";

// §26 — أساس ثنائي الاتجاه: منطق اللغة/الاتجاه/الرسائل نقيّ. يشمل حارساً أمنياً: قيمة
// كوكي عشوائية/خبيثة → الافتراضي (لا تُحقن باللغة ولا بالاتجاه).

describe("locales — ثنائي الاتجاه (§26)", () => {
  it("en/ms → LTR، ar → RTL (zh مؤجّلة)", () => {
    expect(localeDir("en")).toBe("ltr");
    expect(localeDir("ms")).toBe("ltr");
    expect(localeDir("ar")).toBe("rtl");
  });

  it("الافتراضي en (LTR أساسي بقرار المالك)", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(localeDir(DEFAULT_LOCALE)).toBe("ltr");
  });

  it("حارس: قيمة كوكي غير صالحة/خبيثة → الافتراضي (لا تسرّب/حقن)", () => {
    expect(resolveLocale("ar")).toBe("ar");
    expect(resolveLocale("zh")).toBe(DEFAULT_LOCALE); // مؤجّلة — غير مدعومة بعد
    expect(resolveLocale("<script>")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(123)).toBe(DEFAULT_LOCALE);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
  });
});

describe("messages — fallback للـ en + استبدال المتغيّرات", () => {
  it("كل لغة تحمل كل مفاتيح en (لا مفتاح خام يظهر)", () => {
    const enKeys = Object.keys(getMessages("en"));
    for (const locale of LOCALES) {
      const m = getMessages(locale);
      for (const k of enKeys) expect(m[k]).toBeTruthy();
    }
  });

  it("مفتاح ناقص بلغة يسقط لنص en لا للمفتاح الخام", () => {
    // نحاكي نقصاً: مفتاح غير موجود بأي لغة → المفتاح نفسه؛ موجود بـ en → نص en
    const ar = getMessages("ar");
    expect(translate(ar, "nav.orders")).not.toBe("nav.orders"); // مُترجَم
    expect(translate(ar, "does.not.exist")).toBe("does.not.exist");
  });

  it("استبدال {var}", () => {
    expect(translate({ greet: "Hi {name}" }, "greet", { name: "Aina" })).toBe("Hi Aina");
    expect(translate({ greet: "Hi {name}" }, "greet")).toBe("Hi {name}"); // بلا vars — كما هو
  });
});
