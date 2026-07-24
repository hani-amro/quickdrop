import { getMessages, translate } from "./messages";
import { getServerLocale } from "./server";

// ترجمة خادمية (Server Components / generateMetadata): تقرأ اللغة من الكوكي وتُرجع
// دالة t متزامنة. للعناوين والميتاداتا بصفحات app/ التي لا تستطيع استدعاء useT (hook).
export async function getServerT(): Promise<(key: string, vars?: Record<string, string | number>) => string> {
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  return (key, vars) => translate(messages, key, vars);
}
