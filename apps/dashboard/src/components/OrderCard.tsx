"use client";

import type { ReactNode } from "react";
import { serviceLabel, formatMoney, minutesSince } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { OrderRow } from "@/lib/types";

// بطاقة طلب بلوحة الإرسال (§10.1): public_code بارز (بعزل bidi — كود لاتيني وسط
// عربي)، الخدمة، السعر بفواصل آلاف (D5: السلسلة كما وصلت)، وعمر الطلب بالدقائق.
export function OrderCard({
  order,
  slaBreached = false,
  meta,
  footer,
  onOpen,
}: {
  order: OrderRow;
  slaBreached?: boolean;
  meta?: ReactNode;
  footer?: ReactNode;
  /** §10.1 — فتح تفاصيل الطلب (§3 v1: منها زر "المطعم أكّد")؛ يجعل الكود قابلاً للنقر. */
  onOpen?: () => void;
}) {
  const t = useT();
  return (
    <article
      className={`rounded-xl border bg-white p-3 shadow-sm ${
        slaBreached ? "sla-breach border-red-300" : "border-slate-200"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        {onOpen !== undefined ? (
          <button
            type="button"
            onClick={onOpen}
            className="text-base font-bold text-sky-700 hover:underline"
          >
            <bdi>{order.publicCode}</bdi>
          </button>
        ) : (
          <bdi className="text-base font-bold text-slate-900">{order.publicCode}</bdi>
        )}
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
          {order.service !== undefined ? serviceLabel(t, order.service) : "—"}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-sm">
        <span className="font-semibold text-slate-800">
          <bdi>{formatMoney(order.priceTotal)}</bdi>
        </span>
        <span className="text-xs text-slate-500">{t("orderCard.minutesAgo", { min: minutesSince(order.createdAt) })}</span>
      </div>
      {slaBreached && (
        <p className="mt-1 text-xs font-bold text-red-700">{t("orderCard.unassignedWarning")}</p>
      )}
      {meta}
      {footer !== undefined && <div className="mt-2 flex flex-wrap items-center gap-2">{footer}</div>}
    </article>
  );
}
