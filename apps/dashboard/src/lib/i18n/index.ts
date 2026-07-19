export * from "./locales";
export * from "./messages";
export { I18nProvider, useI18n, useT } from "./provider";
// server.ts يُستورد مباشرة (next/headers) — لا يُعاد تصديره كي لا يُسحب لحزمة العميل.
