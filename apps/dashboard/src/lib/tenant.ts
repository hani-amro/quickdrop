// مسار فرعي آمن للمتصفح: currency.js نقيّ (بلا node:crypto)؛ استيراد barrel @quickdrop/shared
// كان يسحب crypto.js لحزمة العميل ويكسر بناء webpack.
import { currencyConfig, formatMoneyDisplay, type CurrencyConfig } from "@quickdrop/shared/currency";

// النشرة مستأجر-واحد: عملة المستأجر تُخبز وقت البناء عبر NEXT_PUBLIC_TENANT_CURRENCY
// (نفس نمط NEXT_PUBLIC_TENANT_SLUG). منها يُشتق الرمز والمنازل والهاتف ومركز الخريطة —
// بدل ثوابت سوريا (ل.س / +963 / دمشق) المكتوبة يدوياً.
export const TENANT_CURRENCY: string = process.env.NEXT_PUBLIC_TENANT_CURRENCY ?? "MYR";

export function tenantCurrencyConfig(): CurrencyConfig {
  return currencyConfig(TENANT_CURRENCY);
}

/** تنسيق مبلغ (سلسلة أصغر وحدة) بعملة المستأجر — للعرض فقط. */
export function formatTenantMoney(minor: string, locale = "en"): string {
  return formatMoneyDisplay(minor, TENANT_CURRENCY, locale);
}
