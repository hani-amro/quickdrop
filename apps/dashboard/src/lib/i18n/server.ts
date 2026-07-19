import { cookies } from "next/headers";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locales";

// قراءة اللغة خادمياً (كوكي) — يُستدعى بالـ layout لضبط <html lang dir> وتمرير اللغة
// للمزوّد. غياب الكوكي → الافتراضي (en، LTR). Server Component only (next/headers).

export async function getServerLocale(): Promise<Locale> {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}
