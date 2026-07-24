"use client";

import { useMemo } from "react";
import { api } from "@/lib/api";
import { statusLabel, formatMoney } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { AnalyticsResponse } from "@/lib/types";
import { usePolling } from "@/lib/use-polling";
import { ConnectionBadge } from "./ConnectionBadge";

// §13/§10/§24 — لوحة التحليلات: بطاقات KPI (tabular-nums) + رسم أعمدة CSS بدائي لطلبات
// آخر N أيام (بلا مكتبات). ثنائية اللغة عبر useT (النصوص) وخصائص تدفّق منطقية. التحديث كل
// 30 ثانية — إحصاءات لا تحتاج لحظية الإرسال. كل مال يُعرض عبر formatMoney (D5: سلسلة).
// ملاحظة: STATUS_LABELS (مفردات حالات الطلب) مشتركة عبر شاشات غير مُدوّلة بعد — تبقى كما هي
// لحين تدويل مفردات الحالات على مستوى التطبيق (متابعة موثّقة، خارج نطاق هذه الشريحة).

// متوسط بالثواني → دقائق نصاً (بخانة عشرية واحدة، بلا وحدة)؛ null = لا بيانات (يُعرض —).
function formatMinutes(seconds: number | null): string | null {
  if (seconds === null) return null;
  const minutes = seconds / 60;
  return minutes.toFixed(1).replace(/\.0$/, "");
}

// "YYYY-MM-DD" → "DD/MM" للعرض المضغوط أسفل العمود
function shortDay(day: string): string {
  const [, m, d] = day.split("-");
  return `${d ?? "--"}/${m ?? "--"}`;
}

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
}

function KpiCard({ label, value, hint }: KpiCardProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{value}</div>
      {hint !== undefined && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

function DailyChart({ data, title }: { data: AnalyticsResponse["daily"]; title: string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-bold text-slate-900">{title}</h2>
      {/* أعمدة CSS بدائية بلا مكتبات: الارتفاع نسبة العدّ للأقصى */}
      <div className="flex h-44 items-end justify-between gap-1" dir="ltr">
        {data.map((d) => {
          const heightPct = Math.round((d.count / max) * 100);
          return (
            <div key={d.day} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="text-xs font-semibold tabular-nums text-slate-600">{d.count}</span>
              <div
                className="w-full rounded-t-md bg-sky-500"
                style={{ height: `${Math.max(2, heightPct)}%` }}
                title={`${d.day}: ${d.count}`}
              />
              <span className="text-[10px] tabular-nums text-slate-400">{shortDay(d.day)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AnalyticsDashboard() {
  const t = useT();
  const { data, failed, lastUpdated, refresh } = usePolling(() => api.analytics(), 30000);

  const statusRows = useMemo(() => {
    const list = data?.statusCounts ?? [];
    // الأكثر أولاً — نظرة سريعة لأثقل الحالات
    return [...list].sort((a, b) => b.count - a.count);
  }, [data]);

  const days = data?.window.sinceDays ?? 7;
  // متوسط بالدقائق مع الوحدة المُدوّلة؛ null → "—" (لا وحدة على قيمة غائبة)
  const minutes = (seconds: number | null): string => {
    const value = formatMinutes(seconds);
    return value === null ? "—" : t("analytics.minutes", { value });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-900">{t("analytics.title")}</h1>
        <ConnectionBadge failed={failed} lastUpdated={lastUpdated} onRefresh={() => void refresh()} />
      </div>

      {data === null && !failed && <p className="text-sm text-slate-400">{t("common.loading")}</p>}

      {data !== null && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <KpiCard label={t("analytics.ordersToday")} value={String(data.ordersToday)} />
            <KpiCard label={t("analytics.ordersWindow")} value={String(data.ordersWindow)} hint={t("analytics.lastNDays", { days })} />
            <KpiCard label={t("analytics.avgAssign")} value={minutes(data.avgAssignSeconds)} hint={t("analytics.avgAssignHint")} />
            <KpiCard label={t("analytics.avgDelivery")} value={minutes(data.avgDeliverySeconds)} hint={t("analytics.avgDeliveryHint")} />
            <KpiCard label={t("analytics.revenue")} value={formatMoney(data.revenue)} hint={t("analytics.delivered", { count: data.deliveredCount })} />
            <KpiCard label={t("analytics.activeDrivers")} value={String(data.activeDrivers)} hint={t("analytics.onlineNow")} />
          </div>

          <DailyChart data={data.daily} title={t("analytics.dailyTitle", { days: data.daily.length })} />

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* التوزيع حسب الحالة */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-bold text-slate-900">{t("analytics.byStatus")}</h2>
              {statusRows.length === 0 ? (
                <p className="text-sm text-slate-400">{t("analytics.noOrders")}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {statusRows.map((row) => (
                    <li key={row.status} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">{statusLabel(t, row.status)}</span>
                      <span className="font-semibold tabular-nums text-slate-900">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* أكثر المناطق طلباً */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-bold text-slate-900">{t("analytics.topZones")}</h2>
              {data.topZones.length === 0 ? (
                <p className="text-sm text-slate-400">{t("analytics.noZones")}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {data.topZones.map((zone) => (
                    <li key={zone.zoneId} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">
                        <bdi>{zone.name}</bdi>
                      </span>
                      <span className="font-semibold tabular-nums text-slate-900">{zone.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
