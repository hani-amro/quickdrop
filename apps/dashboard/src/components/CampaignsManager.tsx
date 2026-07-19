"use client";

import { useCallback, useEffect, useState } from "react";
import { campaigns, type AudienceFilter, type Campaign } from "@/lib/campaigns";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";

// دمج WaFlow (§24) — الحملات على نمط البث + استهداف شريحة (P2.6): قائمة + إنشاء برسالة
// وفلتر جمهور اختياري + **معاينة الوصول** (audience-count، قراءة فقط لا إرسال). محصور
// بدور owner/dispatcher بالـ API. لا سعر بالنص — رسائل فقط. خصائص منطقية RTL/LTR.

const LIFECYCLE_STAGES = ["new", "active", "at_risk", "churned", "loyal"] as const;

export function CampaignsManager() {
  const t = useT();
  const [items, setItems] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [minRfm, setMinRfm] = useState<string>("");
  const [lifecycle, setLifecycle] = useState<string>("");
  const [reach, setReach] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { broadcasts } = await campaigns.list();
      setItems(broadcasts);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.status : 500);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const buildFilter = useCallback((): AudienceFilter | undefined => {
    const f: AudienceFilter = {};
    if (minRfm.trim() !== "") f.minRfm = Math.max(0, Math.min(100, Number(minRfm) || 0));
    if (lifecycle !== "") f.lifecycleStage = [lifecycle];
    return Object.keys(f).length > 0 ? f : undefined;
  }, [minRfm, lifecycle]);

  const previewReach = useCallback(async () => {
    const { count } = await campaigns.audienceCount(buildFilter()).catch(() => ({ count: -1 }));
    setReach(count);
  }, [buildFilter]);

  const send = useCallback(async () => {
    if (body.trim() === "" || busy) return;
    setBusy(true);
    try {
      const filter = buildFilter();
      await campaigns.create({ body: body.trim(), ...(filter ? { audienceFilter: filter } : {}) });
      setBody("");
      setReach(null);
      await load();
    } catch {
      // خطأ إنشاء (تحقق/حد المستأجر) — يبقى النموذج
    } finally {
      setBusy(false);
    }
  }, [body, busy, buildFilter, load]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-slate-800">{t("campaigns.title")}</h1>

      <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <label className="block text-sm">
          <span className="mb-1 block text-slate-600">{t("campaigns.message")}</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("campaigns.messagePlaceholder")}
            rows={3}
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("campaigns.lifecycle")}</span>
            <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
              <option value="">{t("campaigns.allCustomers")}</option>
              {LIFECYCLE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t("campaigns.minRfm")}</span>
            <input
              type="number"
              min={0}
              max={100}
              value={minRfm}
              onChange={(e) => setMinRfm(e.target.value)}
              className="w-24 rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <button onClick={() => void previewReach()} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
            {t("campaigns.previewReach")}
          </button>
          {reach !== null && reach >= 0 && <span className="text-sm font-medium text-slate-700">{t("campaigns.reach", { count: reach })}</span>}
          <button onClick={() => void send()} disabled={busy || body.trim() === ""} className="ms-auto rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {t("campaigns.send")}
          </button>
        </div>
      </div>

      {error !== null ? (
        <button onClick={() => void load()} className="font-semibold text-red-700 underline">
          {t("common.retry")}
        </button>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-100 text-slate-500">
              <tr>
                <th className="px-4 py-2 text-start">{t("campaigns.message")}</th>
                <th className="px-4 py-2 text-start">{t("campaigns.status")}</th>
                <th className="px-4 py-2 text-start">{t("campaigns.sent")}</th>
                <th className="px-4 py-2 text-start">{t("campaigns.failed")}</th>
              </tr>
            </thead>
            <tbody>
              {items === null && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-slate-400">
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {items?.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    {t("campaigns.empty")}
                  </td>
                </tr>
              )}
              {items?.map((c) => (
                <tr key={c.id} className="border-b border-slate-50">
                  <td className="px-4 py-2 text-slate-800">
                    <span className="line-clamp-1">{c.body}</span>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{c.status}</td>
                  <td className="px-4 py-2 text-slate-600">{c.sentCount}</td>
                  <td className="px-4 py-2 text-slate-600">{c.failedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
