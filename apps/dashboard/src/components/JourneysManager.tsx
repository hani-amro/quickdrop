"use client";

import { useCallback, useEffect, useState } from "react";
import { journeys, JOURNEY_TRIGGERS, type Journey, type JourneyStep, type JourneyTrigger } from "@/lib/journeys";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";

// دمج WaFlow (§24) — إدارة الرحلات (محرك الأتمتة الوحيد P2.5): قائمة + تفعيل/تعطيل + حذف +
// إنشاء (اسم/مُطلِّق/خطوات). المُطلِّق من allowlist الخادم؛ الأسعار/الحالة لا تُكتب هنا.
// خصائص منطقية — يعمل RTL/LTR. كل الكتابات عبر /api/proxy (البروكسي يحقن المستأجر).

const STEP_TYPES = ["send_message", "ai_handoff", "add_tag", "wait"] as const;

function emptyStep(): JourneyStep {
  return { type: "send_message", delayHours: 0, template: "" };
}

export function JourneysManager() {
  const t = useT();
  const [items, setItems] = useState<Journey[] | null>(null);
  const [error, setError] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<JourneyTrigger>("crm.lifecycle_changed");
  const [steps, setSteps] = useState<JourneyStep[]>([emptyStep()]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { journeys: list } = await journeys.list();
      setItems(list);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.status : 500);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleActive = useCallback(
    async (j: Journey) => {
      await journeys.update(j.id, { isActive: !j.isActive }).catch(() => undefined);
      await load();
    },
    [load],
  );

  const remove = useCallback(
    async (j: Journey) => {
      await journeys.remove(j.id).catch(() => undefined);
      await load();
    },
    [load],
  );

  const submit = useCallback(async () => {
    if (name.trim() === "" || busy) return;
    setBusy(true);
    try {
      await journeys.create({ name: name.trim(), trigger, steps, isActive: false });
      setName("");
      setSteps([emptyStep()]);
      setCreating(false);
      await load();
    } catch {
      // خطأ إنشاء (تحقق الخادم) — يبقى النموذج مفتوحاً
    } finally {
      setBusy(false);
    }
  }, [name, trigger, steps, busy, load]);

  const setStep = (i: number, next: JourneyStep) => setSteps((s) => s.map((st, idx) => (idx === i ? next : st)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">{t("journeys.title")}</h1>
        <button onClick={() => setCreating((v) => !v)} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white">
          {t("journeys.new")}
        </button>
      </div>

      {creating && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-slate-600">{t("journeys.name")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-600">{t("journeys.trigger")}</span>
              <select value={trigger} onChange={(e) => setTrigger(e.target.value as JourneyTrigger)} className="w-full rounded-lg border border-slate-300 px-3 py-2">
                {JOURNEY_TRIGGERS.map((tr) => (
                  <option key={tr} value={tr}>
                    {t(`journeys.trigger.${tr}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium text-slate-600">{t("journeys.steps")}</span>
            {steps.map((step, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2">
                <select
                  value={step.type}
                  onChange={(e) => {
                    const type = e.target.value as JourneyStep["type"];
                    setStep(i, type === "send_message" ? { type, delayHours: step.delayHours, template: "" } : type === "add_tag" ? { type, delayHours: step.delayHours, tag: "" } : { type, delayHours: step.delayHours });
                  }}
                  className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                >
                  {STEP_TYPES.map((st) => (
                    <option key={st} value={st}>
                      {t(`journeys.stepType.${st}`)}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  value={step.delayHours}
                  onChange={(e) => setStep(i, { ...step, delayHours: Math.max(0, Number(e.target.value) || 0) })}
                  aria-label={t("journeys.delayHours")}
                  className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm"
                />
                {step.type === "send_message" && (
                  <input
                    value={step.template}
                    onChange={(e) => setStep(i, { ...step, template: e.target.value })}
                    placeholder={t("journeys.template")}
                    className="min-w-40 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                  />
                )}
                {step.type === "add_tag" && (
                  <input
                    value={step.tag}
                    onChange={(e) => setStep(i, { ...step, tag: e.target.value })}
                    placeholder={t("journeys.tag")}
                    className="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm"
                  />
                )}
                {steps.length > 1 && (
                  <button onClick={() => setSteps((s) => s.filter((_, idx) => idx !== i))} className="text-sm text-red-600">
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button onClick={() => setSteps((s) => [...s, emptyStep()])} className="text-sm font-medium text-sky-700">
              + {t("journeys.addStep")}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => void submit()} disabled={busy || name.trim() === ""} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {t("common.save")}
            </button>
            <button onClick={() => setCreating(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {error !== null ? (
        <button onClick={() => void load()} className="font-semibold text-red-700 underline">
          {t("common.retry")}
        </button>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-100 text-slate-500">
              <tr>
                <th className="px-4 py-2 text-start">{t("journeys.name")}</th>
                <th className="px-4 py-2 text-start">{t("journeys.trigger")}</th>
                <th className="px-4 py-2 text-start">{t("journeys.enrolled")}</th>
                <th className="px-4 py-2 text-start">{t("journeys.completed")}</th>
                <th className="px-4 py-2 text-start">{t("journeys.active")}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {items === null && (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-slate-400">
                    {t("common.loading")}
                  </td>
                </tr>
              )}
              {items?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    {t("journeys.empty")}
                  </td>
                </tr>
              )}
              {items?.map((j) => (
                <tr key={j.id} className="border-b border-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-800">{j.name}</td>
                  <td className="px-4 py-2 text-slate-600">{t(`journeys.trigger.${j.trigger}`)}</td>
                  <td className="px-4 py-2 text-slate-600">{j.enrolledCount}</td>
                  <td className="px-4 py-2 text-slate-600">{j.completedCount}</td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => void toggleActive(j)}
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${j.isActive ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-500"}`}
                    >
                      {j.isActive ? "●" : "○"} {t("journeys.active")}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-end">
                    <button onClick={() => void remove(j)} className="text-sm text-red-600">
                      {t("journeys.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
