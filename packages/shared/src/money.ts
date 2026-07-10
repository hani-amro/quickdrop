// D5: المال أعداد صحيحة فقط (BIGINT) بأصغر وحدة للعملة. التنسيق للعرض فقط عند الحافة.
export type Money = bigint;

export function assertMoney(value: bigint, field: string): Money {
  if (typeof value !== "bigint") {
    throw new TypeError(`${field}: money must be a bigint, got ${typeof value}`);
  }
  return value;
}

/** عرض فقط — لا يُستخدم ناتجها بأي حساب. */
export function formatMoney(amount: Money, locale = "ar-SY", currency = "SYP"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}
