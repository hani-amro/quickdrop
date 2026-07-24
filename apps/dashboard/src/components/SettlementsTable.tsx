"use client";

import { useState } from "react";
import { ApiError, api, describeError } from "@/lib/api";
import { agoLabel, formatMoney, type Translate } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { SettlementBoardRow } from "@/lib/types";
import { usePolling } from "@/lib/use-polling";
import { ConnectionBadge } from "./ConnectionBadge";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

// §8.2 — شاشة التسوية اليومية: صف لكل سائق عنده قيود غير مسوّاة (متوقَّع/مستلَم/فرق).
// الفرق يتحدّث لحظياً بالواجهة بحساب BigInt نصّي بحت (D5 — لا Number على مال)،
// و"إغلاق اليوم" بتأكيد صريح — القرار النهائي والأقفال خادمياً (§16.11).

// إدخال المستلَم: أرقام فقط — الأرقام الشرقية (٠..٩/۰..۹) تُحوَّل ASCII (إدخال عربي وارد جداً)
const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

function sanitizeDigits(raw: string): string {
  const ascii = raw.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const digit =
      code >= EXTENDED_ARABIC_INDIC_ZERO ? code - EXTENDED_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO;
    return String(digit);
  });
  return ascii.replace(/\D/g, "").slice(0, 15); // نفس سقف الخادم (^\d{1,15}$)
}

// D5 — الفرق = المتوقَّع − المستلَم بحساب BigInt حصراً؛ حقل فارغ = 0
function diffOf(expected: string, receivedDigits: string): bigint {
  return BigInt(expected) - BigInt(receivedDigits === "" ? "0" : receivedDigits);
}

// §8.2 — 409 هنا لها معنى واحد محدد: unique (tenant, driver, period_date)
function describeCloseError(t: Translate, error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return t("settlementsTable.dayLocked");
  }
  return describeError(error);
}

export function SettlementsTable() {
  const t = useT();
  const toast = useToast();
  const { data, failed, lastUpdated, refresh } = usePolling(api.settlementBoard, 5000);

  // المستلَم لكل سائق — حالة محلية بالمعرّف: الـ polling يحدّث المتوقَّع ولا يمس الإدخال
  const [received, setReceived] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<SettlementBoardRow | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = data?.rows ?? [];

  async function closeDay(row: SettlementBoardRow): Promise<void> {
    const receivedDigits = received[row.driverId] ?? "";
    setBusy(true);
    try {
      const result = await api.closeSettlement(row.driverId, receivedDigits === "" ? "0" : receivedDigits);
      // §8.2 — الفرق يظهر ولا يُخفى: يُقال بصوت عالٍ حتى بلحظة النجاح
      toast.success(t("settlementsTable.dayClosed", { diff: formatMoney(result.settlement.diff) }));
      setConfirming(null);
      setReceived((current) => {
        const next = { ...current };
        delete next[row.driverId];
        return next;
      });
      await refresh(); // بعد النجاح: حقيقة الخادم لا تفاؤل الواجهة
    } catch (error) {
      toast.error(describeCloseError(t, error)); // §10.1: لا فشل صامت — توست عام
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-900">
          {t("settlementsTable.title")}
          {data !== null && (
            <span className="ms-2 text-sm font-normal text-slate-500">
              {/* الفخ 8 — يوم المستأجر محسوب خادمياً (tenantDay)، لا يوم المتصفح */}
              {t("settlementsTable.dayLabel")} <bdi className="tabular-nums">{data.periodDate}</bdi>
            </span>
          )}
        </h1>
        <ConnectionBadge failed={failed} lastUpdated={lastUpdated} onRefresh={() => void refresh()} />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-[52rem] text-sm tabular-nums">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <th className="p-3 text-start font-semibold">{t("settlementsTable.driver")}</th>
              <th className="p-3 text-start font-semibold">{t("settlementsTable.entries")}</th>
              <th className="p-3 text-start font-semibold">{t("settlementsTable.lastEntry")}</th>
              <th className="p-3 text-start font-semibold">{t("settlementsTable.expected")}</th>
              <th className="p-3 text-start font-semibold">{t("settlementsTable.received")}</th>
              <th className="p-3 text-start font-semibold">{t("settlementsTable.difference")}</th>
              <th className="p-3 text-start font-semibold" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const receivedDigits = received[row.driverId] ?? "";
              const diff = diffOf(row.expected, receivedDigits);
              return (
                <tr key={row.driverId} className="border-b border-slate-100 last:border-b-0">
                  <td className="p-3 font-semibold text-slate-900">
                    <bdi>{row.name ?? "—"}</bdi>
                  </td>
                  <td className="p-3 text-slate-700">{row.entryCount}</td>
                  <td className="p-3 text-slate-600">{agoLabel(t, row.lastEntryAt)}</td>
                  <td className="p-3 font-semibold text-slate-900">{formatMoney(row.expected)}</td>
                  <td className="p-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      value={receivedDigits}
                      onChange={(e) =>
                        setReceived((current) => ({
                          ...current,
                          [row.driverId]: sanitizeDigits(e.target.value),
                        }))
                      }
                      placeholder="0"
                      aria-label={t("settlementsTable.receivedFrom", { name: row.name ?? t("settlementsTable.driver") })}
                      className="w-32 rounded-lg border border-slate-300 p-2 text-end text-sm tabular-nums focus:border-sky-500 focus:outline-none"
                    />
                  </td>
                  {/* §8.2 — الفرق يتحدّث لحظياً ويظهر حسابياً ولا يُخفى */}
                  <td
                    className={`p-3 font-semibold ${
                      diff > 0n ? "text-amber-700" : diff < 0n ? "text-sky-700" : "text-emerald-700"
                    }`}
                  >
                    {formatMoney(diff.toString())}
                  </td>
                  <td className="p-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirming(row)}
                      className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t("settlementsTable.closeDay")}
                    </button>
                  </td>
                </tr>
              );
            })}
            {data !== null && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-400">
                  {t("settlementsTable.allSettled")}
                </td>
              </tr>
            )}
            {data === null && !failed && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-400">
                  {t("settlementsTable.loading")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {confirming !== null && (
        <Modal title={t("settlementsTable.closeDayFor", { name: confirming.name ?? t("settlementsTable.driver") })} onClose={() => setConfirming(null)}>
          {(() => {
            const receivedDigits = received[confirming.driverId] ?? "";
            const diff = diffOf(confirming.expected, receivedDigits);
            return (
              <div className="flex flex-col gap-3 text-sm">
                <dl className="grid grid-cols-2 gap-2 tabular-nums">
                  <dt className="text-slate-500">{t("settlementsTable.expected")}</dt>
                  <dd className="font-semibold text-slate-900">{formatMoney(confirming.expected)}</dd>
                  <dt className="text-slate-500">{t("settlementsTable.received")}</dt>
                  <dd className="font-semibold text-slate-900">
                    {formatMoney(receivedDigits === "" ? "0" : receivedDigits)}
                  </dd>
                  <dt className="text-slate-500">{t("settlementsTable.difference")}</dt>
                  <dd
                    className={`font-semibold ${
                      diff > 0n ? "text-amber-700" : diff < 0n ? "text-sky-700" : "text-emerald-700"
                    }`}
                  >
                    {formatMoney(diff.toString())}
                  </dd>
                </dl>
                {/* §8.2 — بعد الإغلاق ممنوع أي تعديل؛ التصحيح قيد adjustment جديد بسبب إلزامي */}
                <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
                  {t("settlementsTable.afterCloseNote")}
                </p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    {t("settlementsTable.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void closeDay(confirming)}
                    className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? t("settlementsTable.closing") : t("settlementsTable.confirmCloseDay")}
                  </button>
                </div>
              </div>
            );
          })()}
        </Modal>
      )}
    </div>
  );
}
