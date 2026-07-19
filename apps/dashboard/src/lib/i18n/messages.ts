import type { Locale } from "./locales";

// قاموس الرسائل — مفاتيح مسطّحة بنقاط. en المرجع (كل مفتاح موجود فيه)؛ ms/ar قد تنقص
// مفاتيح فتسقط للـ en (fallback). الصفحات المنقولة من WaFlow تضيف مفاتيحها هنا.
// zh مؤجّلة: تُضاف كملف رابع بنفس الشكل دون تغيير أي كود.

export type Messages = Record<string, string>;

const en: Messages = {
  "app.title": "QuickDrop — Office Dashboard",
  "nav.dispatch": "Dispatch",
  "nav.orders": "Orders",
  "nav.drivers": "Drivers",
  "nav.merchants": "Merchants",
  "nav.inbox": "Inbox",
  "nav.contacts": "Contacts",
  "nav.journeys": "Journeys",
  "nav.campaigns": "Campaigns",
  "nav.analytics": "Analytics",
  "nav.settlements": "Settlements",
  "nav.settings": "Settings",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.loading": "Loading…",
  "common.search": "Search",
  "common.retry": "Retry",
  "common.language": "Language",
};

const ms: Messages = {
  "app.title": "QuickDrop — Papan Pemuka Pejabat",
  "nav.dispatch": "Penghantaran",
  "nav.orders": "Pesanan",
  "nav.drivers": "Pemandu",
  "nav.merchants": "Peniaga",
  "nav.inbox": "Peti Masuk",
  "nav.contacts": "Kenalan",
  "nav.journeys": "Perjalanan",
  "nav.campaigns": "Kempen",
  "nav.analytics": "Analitik",
  "nav.settlements": "Penyelesaian",
  "nav.settings": "Tetapan",
  "common.save": "Simpan",
  "common.cancel": "Batal",
  "common.close": "Tutup",
  "common.loading": "Memuatkan…",
  "common.search": "Cari",
  "common.retry": "Cuba lagi",
  "common.language": "Bahasa",
};

const ar: Messages = {
  "app.title": "QuickDrop — داشبورد المكتب",
  "nav.dispatch": "الإرسال",
  "nav.orders": "الطلبات",
  "nav.drivers": "السائقون",
  "nav.merchants": "التجار",
  "nav.inbox": "الوارد",
  "nav.contacts": "الزبائن",
  "nav.journeys": "الرحلات",
  "nav.campaigns": "الحملات",
  "nav.analytics": "التحليلات",
  "nav.settlements": "التسويات",
  "nav.settings": "الإعدادات",
  "common.save": "حفظ",
  "common.cancel": "إلغاء",
  "common.close": "إغلاق",
  "common.loading": "جارٍ التحميل…",
  "common.search": "بحث",
  "common.retry": "إعادة المحاولة",
  "common.language": "اللغة",
};

const CATALOG: Record<Locale, Messages> = { en, ms, ar };

/** رسائل اللغة مدموجة فوق en (المرجع) — مفتاح ناقص بلغة يسقط للـ en لا يظهر خاماً. */
export function getMessages(locale: Locale): Messages {
  return locale === "en" ? en : { ...en, ...CATALOG[locale] };
}

/** ترجمة مفتاح مع استبدال متغيّرات {name}. مفتاح مجهول → المفتاح نفسه (مرئي بالتطوير). */
export function translate(messages: Messages, key: string, vars?: Record<string, string | number>): string {
  const template = messages[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`));
}
