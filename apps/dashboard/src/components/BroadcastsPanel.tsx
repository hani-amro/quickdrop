"use client";

import { useState } from "react";
import type { BroadcastStatus } from "@quickdrop/shared";
import { api, describeError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { usePolling } from "@/lib/use-polling";
import { ConnectionBadge } from "./ConnectionBadge";
import { useToast } from "./Toast";

// §4.3/§14 — لوحة البث: نموذج إرسال (عنوان اختياري + نص + زر) + قائمة البثات السابقة
// بعدّاداتها. الإرسال الفعلي خادمي مضبوط المعدل (worker)؛ الواجهة تنشئ ثم تحدّث القائمة.
// polling كل 5 ثوانٍ يُظهر تقدّم العدّادات (draft→sending→done) لحظياً بلا إعادة تحميل.

const STATUS_LABEL_KEYS: Record<BroadcastStatus, string> = {
  draft: "broadcasts2.statusDraft",
  scheduled: "broadcasts2.statusScheduled",
  sending: "broadcasts2.statusSending",
  done: "broadcasts2.statusDone",
  failed: "broadcasts2.statusFailed",
};

const STATUS_CLASSES: Record<BroadcastStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  scheduled: "bg-amber-100 text-amber-800",
  sending: "bg-sky-100 text-sky-800",
  done: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
};

const BODY_MAX = 4096; // حد رسالة تيليغرام — نفس قصّ الخادم (§11)
const TITLE_MAX = 200;

const inputCls =
  "mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm focus:border-sky-500 focus:outline-none";

function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ar-u-nu-latn", { dateStyle: "short", timeStyle: "short" });
}

export function BroadcastsPanel() {
  const t = useT();
  const toast = useToast();
  const { data, failed, lastUpdated, refresh } = usePolling(api.listBroadcasts, 5000);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmedBody = body.trim();
  const canSend = trimmedBody.length > 0 && !busy;

  async function send(): Promise<void> {
    if (!canSend) return;
    setBusy(true);
    try {
      const trimmedTitle = title.trim();
      const result = await api.createBroadcast({
        body: trimmedBody,
        ...(trimmedTitle !== "" ? { title: trimmedTitle } : {}),
      });
      // §10.1 — لا فشل صامت: نتيجة الفعل توست مرئي
      toast.success(result.enqueued ? t("broadcasts2.sentToast") : t("broadcasts2.savedToast"));
      setTitle("");
      setBody("");
      await refresh(); // حقيقة الخادم بعد النجاح
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const broadcasts = data?.broadcasts ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-900">{t("broadcasts2.heading")}</h1>
        <ConnectionBadge failed={failed} lastUpdated={lastUpdated} onRefresh={() => void refresh()} />
      </div>

      {/* نموذج الإرسال */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3">
          <label className="block text-sm">
            <span className="font-semibold text-slate-700">{t("broadcasts2.titleLabel")}</span>
            <input
              type="text"
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("broadcasts2.titlePlaceholder")}
              className={inputCls}
            />
          </label>
          <label className="block text-sm">
            <span className="font-semibold text-slate-700">{t("broadcasts2.bodyLabel")}</span>
            <textarea
              value={body}
              maxLength={BODY_MAX}
              rows={4}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("broadcasts2.bodyPlaceholder")}
              className={`${inputCls} resize-y`}
            />
            <span className="mt-1 block text-xs tabular-nums text-slate-400">
              {trimmedBody.length} / {BODY_MAX}
            </span>
          </label>
          <div className="flex items-center justify-between gap-2">
            {/* §4.3 — تذكير: البثّة تصل كل الزبائن الواصلين؛ الإرسال مضبوط المعدل خادمياً */}
            <p className="text-xs text-slate-400">{t("broadcasts2.reachNote")}</p>
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void send()}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? t("broadcasts2.sending") : t("broadcasts2.sendButton")}
            </button>
          </div>
        </div>
      </div>

      {/* قائمة البثات السابقة */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <th className="p-3 text-start font-semibold">{t("broadcasts2.colBroadcast")}</th>
              <th className="p-3 text-start font-semibold">{t("broadcasts2.colStatus")}</th>
              <th className="p-3 text-start font-semibold">{t("broadcasts2.colSent")}</th>
              <th className="p-3 text-start font-semibold">{t("broadcasts2.statusFailed")}</th>
              <th className="p-3 text-start font-semibold">{t("broadcasts2.colDate")}</th>
            </tr>
          </thead>
          <tbody>
            {broadcasts.map((b) => (
              <tr key={b.id} className="border-b border-slate-100 last:border-b-0 align-top">
                <td className="p-3">
                  {b.title !== null && b.title !== "" && (
                    <div className="font-semibold text-slate-900">
                      <bdi>{b.title}</bdi>
                    </div>
                  )}
                  <div className="line-clamp-2 max-w-md text-slate-600">
                    <bdi>{b.body}</bdi>
                  </div>
                </td>
                <td className="p-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASSES[b.status]}`}>
                    {t(STATUS_LABEL_KEYS[b.status])}
                  </span>
                </td>
                <td className="p-3 font-semibold tabular-nums text-emerald-700">{b.sentCount}</td>
                <td className="p-3 font-semibold tabular-nums text-rose-700">{b.failedCount}</td>
                <td className="p-3 tabular-nums text-slate-500">
                  <bdi>{shortDateTime(b.createdAt)}</bdi>
                </td>
              </tr>
            ))}
            {data !== null && broadcasts.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-400">
                  {t("broadcasts2.empty")}
                </td>
              </tr>
            )}
            {data === null && !failed && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-400">
                  {t("broadcasts2.loading")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
