"use client";

import { formatMoney } from "@/lib/format";
import type { QuoteResponse } from "@/lib/types";

// §4.4 (إلزامي) — عرض السعر مفصّلاً قبل الحفظ: بسوق COD السعر المفاجئ عند
// الباب = نزاع يومي. D5: القيم سلاسل من الـ API — تُجمَّع نصياً ولا تُحوَّل أرقاماً.
export function PriceBreakdown({ quote }: { quote: QuoteResponse }) {
  const c = quote.components;
  const rows: { label: string; value: string; always?: boolean; negative?: boolean }[] = [
    { label: "أجرة أساسية", value: c.base, always: true },
    { label: "المسافة", value: c.distance, always: true },
    { label: "الوزن", value: c.weight },
    { label: "ذروة", value: c.surge },
    { label: "تسوية الحد الأدنى", value: c.minAdjustment },
    { label: "خصم", value: c.discount, negative: true },
  ];

  return (
    <div className="rounded-xl border border-emerald-300 bg-emerald-50/60 p-4">
      <h3 className="mb-2 text-sm font-bold text-emerald-900">تفصيل السعر</h3>
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
                </bdi>{" "}
                ل.س
              </dd>
            </div>
          ))}
        <div className="mt-1 flex items-center justify-between gap-4 border-t border-emerald-300 pt-2 text-base font-bold">
          <dt className="text-emerald-900">الإجمالي</dt>
          <dd className="text-emerald-900">
            <bdi>{formatMoney(c.total)}</bdi> ل.س
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        المسافة <bdi>{(quote.distanceM / 1000).toFixed(1)}</bdi> كم — الزمن المقدّر{" "}
        <bdi>{Math.max(1, Math.round(quote.durationS / 60))}</bdi> د
      </p>
    </div>
  );
}
