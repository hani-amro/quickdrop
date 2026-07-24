"use client";

import { useMemo } from "react";
import { api } from "@/lib/api";
import { driverStatusLabel, agoLabel } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { usePolling } from "@/lib/use-polling";
import { ConnectionBadge } from "./ConnectionBadge";

// §10.1 — قائمة السائقين (قراءة فقط v1): الاسم، الحالة بالعربي، النشِطة/السعة
// (D14)، وآخر موقع منذ متى. polling نفسه 3 ثوانٍ + مؤشر اتصال.
export function DriversTable() {
  const t = useT();
  const { data, failed, lastUpdated, refresh } = usePolling(api.listDrivers, 3000);

  const drivers = useMemo(() => {
    const list = data?.drivers ?? [];
    // المتصلون أولاً ثم أبجدياً — الموزّع يهمه المتاح الآن
    return [...list].sort((a, b) =>
      a.status === b.status ? a.name.localeCompare(b.name, "ar") : a.status === "online" ? -1 : 1,
    );
  }, [data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-900">{t("driversTable.title")}</h1>
        <ConnectionBadge failed={failed} lastUpdated={lastUpdated} onRefresh={() => void refresh()} />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-start text-xs text-slate-500">
              <th className="p-3 text-start font-semibold">{t("driversTable.colName")}</th>
              <th className="p-3 text-start font-semibold">{t("driversTable.colStatus")}</th>
              <th className="p-3 text-start font-semibold">{t("driversTable.colActiveCapacity")}</th>
              <th className="p-3 text-start font-semibold">{t("driversTable.colLastLocation")}</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((driver) => (
              <tr key={driver.id} className="border-b border-slate-100 last:border-b-0">
                <td className="p-3 font-semibold text-slate-900">
                  <bdi>{driver.name}</bdi>
                </td>
                <td className="p-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      driver.status === "online"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {driverStatusLabel(t, driver.status)}
                  </span>
                </td>
                <td className="p-3 text-slate-700">
                  {driver.activeOrders !== undefined && driver.maxConcurrentOrders !== undefined
                    ? `${driver.activeOrders} / ${driver.maxConcurrentOrders}`
                    : "—"}
                </td>
                {/* الفخ 19 — يُعرض عمر آخر نقطة، لا خريطة/حالة تكذب */}
                <td className="p-3 text-slate-600">{agoLabel(t, driver.lastPointAt)}</td>
              </tr>
            ))}
            {data !== null && drivers.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-slate-400">
                  {t("driversTable.empty")}
                </td>
              </tr>
            )}
            {data === null && !failed && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-slate-400">
                  {t("driversTable.loading")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
