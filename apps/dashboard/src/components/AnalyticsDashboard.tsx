"use client";

import { useMemo } from "react";
import { api } from "@/lib/api";
import { STATUS_LABELS, formatMoney } from "@/lib/format";
import type { AnalyticsResponse } from "@/lib/types";
import { usePolling } from "@/lib/use-polling";
import { ConnectionBadge } from "./ConnectionBadge";

// §13/§10 — لوحة التحليلات: بطاقات KPI عربية (tabular-nums) + رسم أعمدة CSS بدائي
// لطلبات آخر N أيام (بلا مكتبات). التحديث كل 30 ثانية — إحصاءات لا تحتاج لحظية
// الإرسال. كل مال يُعرض عبر formatMoney (D5: سلسلة، لا Number).

// متوسط بالثواني → دقائق للعرض (بخانة عشرية واحدة)؛ null = لا بيانات.
function formatMinutes(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = seconds / 60;
  const text = minutes.toFixed(1).replace(/\.0$/, "");
  return `${text} د`;
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

function DailyChart({ data }: { data: AnalyticsResponse["daily"] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-bold text-slate-900">الطلبات — آخر {data.length} أيام</h2>
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
  const { data, failed, lastUpdated, refresh } = usePolling(() => api.analytics(), 30000);

  const statusRows = useMemo(() => {
    const list = data?.statusCounts ?? [];
    // الأكثر أولاً — نظرة سريعة لأثقل الحالات
    return [...list].sort((a, b) => b.count - a.count);
  }, [data]);

  const days = data?.window.sinceDays ?? 7;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-900">التحليلات</h1>
        <ConnectionBadge failed={failed} lastUpdated={lastUpdated} onRefresh={() => void refresh()} />
      </div>

      {data === null && !failed && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}

      {data !== null && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <KpiCard label="طلبات اليوم" value={String(data.ordersToday)} />
            <KpiCard label="طلبات الأسبوع" value={String(data.ordersWindow)} hint={`آخر ${days} أيام`} />
            <KpiCard label="متوسط الإسناد" value={formatMinutes(data.avgAssignSeconds)} hint="confirmed→assigned" />
            <KpiCard label="متوسط التوصيل" value={formatMinutes(data.avgDeliverySeconds)} hint="من الإنشاء للتسليم" />
            <KpiCard label="الإيراد" value={formatMoney(data.revenue)} hint={`${data.deliveredCount} مسلَّم`} />
            <KpiCard label="السائقون النشطون" value={String(data.activeDrivers)} hint="متصلون الآن" />
          </div>

          <DailyChart data={data.daily} />

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* التوزيع حسب الحالة */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-bold text-slate-900">الطلبات حسب الحالة</h2>
              {statusRows.length === 0 ? (
                <p className="text-sm text-slate-400">لا طلبات في هذه النافذة</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {statusRows.map((row) => (
                    <li key={row.status} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">{STATUS_LABELS[row.status]}</span>
                      <span className="font-semibold tabular-nums text-slate-900">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* أكثر المناطق طلباً */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-bold text-slate-900">أكثر المناطق طلباً</h2>
              {data.topZones.length === 0 ? (
                <p className="text-sm text-slate-400">لا مناطق معرّفة أو لا طلبات ضمنها</p>
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
