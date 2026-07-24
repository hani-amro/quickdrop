"use client";

import { formatMoney } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { QuoteResponse } from "@/lib/types";

// §4.4 (إلزامي) — عرض السعر مفصّلاً قبل الحفظ: بسوق COD السعر المفاجئ عند
// الباب = نزاع يومي. D5: القيم سلاسل من الـ API — تُجمَّع نصياً ولا تُحوَّل أرقاماً.
export function PriceBreakdown({ quote }: { quote: QuoteResponse }) {
  const t = useT();
  const c = quote.components;
  const rows: { label: string; value: string; always?: boolean; negative?: boolean }[] = [
    { label: t("price.baseFare"), value: c.base, always: true },
    { label: t("price.distance"), value: c.distance, always: true },
    { label: t("price.weight"), value: c.weight },
    { label: t("price.surge"), value: c.surge },
    { label: t("price.minAdjustment"), value: c.minAdjustment },
    { label: t("price.discount"), value: c.discount, negative: true },
  ];

  // مسافة/زمن للعرض فقط (ليست مالاً — D3): تُستخرج هنا كي لا يقع .toFixed على سطر يحوي
  // مصطلحاً مالياً في الـ JSX. كل قيم المال أعلاه تمرّ عبر formatMoney على أعداد صحيحة (sen).
  const distanceKm = (quote.distanceM / 1000).toFixed(1);
  const durationMin = Math.max(1, Math.round(quote.durationS / 60));

  return (
    <div className="rounded-xl border border-emerald-300 bg-emerald-50/60 p-4">
      <h3 className="mb-2 text-sm font-bold text-emerald-900">{t("price.breakdown")}</h3>
      <dl className="flex flex-col gap-1 text-sm">
        {rows
          .filter((r) => r.always === true || r.value !== "0")
          .map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-4">
              <dt className="text-slate-600">{r.label}</dt>
              <dd className="text-slate-800">
                <bdi>
                  {r.negative === true && r.value !== "0" ? "-" : ""}
                  {formatMoney(r.value)}
                </bdi>
              </dd>
            </div>
          ))}
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-emerald-300 pt-2 text-base font-bold">
          <dt className="text-emerald-900">{t("price.total")}</dt>
          <dd className="text-emerald-900">
            <bdi>{formatMoney(c.total)}</bdi>
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        {t("price.distance")} <bdi>{distanceKm}</bdi> {t("price.kmEstimatedTime")}{" "}
        <bdi>{durationMin}</bdi> {t("price.minutesShort")}
      </p>
    </div>
  );
}
