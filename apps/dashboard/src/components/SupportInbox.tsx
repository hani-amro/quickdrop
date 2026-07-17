"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupportThreadStatus } from "@quickdrop/shared";
import { api, describeError } from "@/lib/api";
import type { SupportThreadDetailResponse, SupportThreadSummary } from "@/lib/types";
import { useToast } from "./Toast";

// §9 — صندوق الدعم: قائمة الخيوط يمين + محادثة الخيط المحدَّد يسار. polling كل 5 ثوانٍ
// للقائمة وللخيط المفتوح (setInterval بـ useEffect، يُنظَّف عند التفكيك) — نفس روح لوحة
// الإرسال (§10.1). الرد يكتب رسالة out فتصل الزبون عبر البوت (D9)، والإغلاق يقفل الخيط.

const POLL_MS = 5000;
const REPLY_MAX = 2000;

type StatusFilter = SupportThreadStatus | "all";

const STATUS_LABELS: Record<SupportThreadStatus, string> = { open: "مفتوح", closed: "مغلق" };

const FILTER_TABS: { value: StatusFilter; label: string }[] = [
  { value: "open", label: "المفتوحة" },
  { value: "closed", label: "المغلقة" },
  { value: "all", label: "الكل" },
];

// §9 — إخفاء جزئي لرقم الهاتف باللوحة (لا نعرض الرقم كاملاً بلا داعٍ)
function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  if (phone.length <= 5) return phone;
  return `${phone.slice(0, 4)}••••${phone.slice(-2)}`;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString("ar", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SupportInbox() {
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [threads, setThreads] = useState<SupportThreadSummary[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportThreadDetailResponse | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadThreads = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listSupportThreads(statusFilter === "all" ? undefined : statusFilter);
      if (!aliveRef.current) return;
      setThreads(res.threads);
      setListFailed(false);
    } catch {
      // فشل الجلب = مؤشر أحمر لا رمي (§16.12: الحالة مرئية لا مبتلعة)
      if (aliveRef.current) setListFailed(true);
    }
  }, [statusFilter]);

  // polling القائمة: فوري ثم كل 5 ثوانٍ؛ يعاد التسجيل عند تغيّر الفلتر
  useEffect(() => {
    void loadThreads();
    const id = setInterval(() => void loadThreads(), POLL_MS);
    return () => clearInterval(id);
  }, [loadThreads]);

  // polling الخيط المفتوح: فوري عند اختياره ثم كل 5 ثوانٍ؛ يُنظَّف عند تغيّر الاختيار/التفكيك
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const res = await api.getSupportThread(selectedId);
        if (active && aliveRef.current) setDetail(res);
      } catch {
        // نُبقي آخر لقطة معروضة ونعيد المحاولة بالدورة التالية — لا وميض
      }
    };
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [selectedId]);

  async function sendReply(): Promise<void> {
    if (detail === null) return;
    const text = replyText.trim();
    if (text === "") {
      toast.error("اكتب نص الرد");
      return;
    }
    if (text.length > REPLY_MAX) {
      toast.error(`الرد طويل جداً — الحد ${REPLY_MAX} حرف`);
      return;
    }
    setSending(true);
    try {
      await api.supportReply(detail.thread.id, text);
      setReplyText("");
      toast.success("أُرسل الرد");
      const [d] = await Promise.all([api.getSupportThread(detail.thread.id), loadThreads()]);
      if (aliveRef.current) setDetail(d);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setSending(false);
    }
  }

  async function closeThread(): Promise<void> {
    if (detail === null) return;
    setClosing(true);
    try {
      await api.supportClose(detail.thread.id);
      toast.success("أُغلق الخيط");
      const [d] = await Promise.all([api.getSupportThread(detail.thread.id), loadThreads()]);
      if (aliveRef.current) setDetail(d);
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[22rem_1fr]">
      {/* عمود قائمة الخيوط */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => {
                setStatusFilter(tab.value);
                setThreads(null);
              }}
              aria-pressed={statusFilter === tab.value}
              className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                statusFilter === tab.value
                  ? "bg-sky-100 text-sky-800"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {listFailed && (
          <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700" role="alert">
            تعذّر تحميل الخيوط —{" "}
            <button type="button" onClick={() => void loadThreads()} className="underline">
              أعد المحاولة
            </button>
          </p>
        )}

        {threads === null && !listFailed && <p className="text-sm text-slate-400">جارٍ التحميل…</p>}
        {threads !== null && threads.length === 0 && (
          <p className="rounded-xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">
            لا خيوط دعم في هذا التصنيف
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {(threads ?? []).map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setSelectedId(t.id)}
                aria-pressed={selectedId === t.id}
                className={`w-full rounded-xl border p-3 text-start transition-colors ${
                  selectedId === t.id
                    ? "border-sky-500 bg-sky-50"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-slate-900">
                    <bdi>{t.userName ?? "زبون"}</bdi>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                      t.status === "open" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {STATUS_LABELS[t.status]}
                  </span>
                </div>
                {t.userPhone !== null && (
                  <div className="mt-0.5 text-xs text-slate-500" dir="ltr">
                    <bdi>{maskPhone(t.userPhone)}</bdi>
                  </div>
                )}
                {t.lastMessageText !== null && (
                  <p className="mt-1 truncate text-xs text-slate-600">{t.lastMessageText}</p>
                )}
                <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                  <span>{formatTime(t.lastMessageAt)}</span>
                  <span>{t.messageCount} رسالة</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* العمود الأيسر: محادثة الخيط المحدَّد */}
      <div className="flex flex-col">
        {detail === null ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
            اختر خيطاً من القائمة لعرض المحادثة والرد
          </div>
        ) : (
          <div className="flex min-h-[28rem] flex-col rounded-2xl border border-slate-200 bg-white">
            {/* ترويسة الخيط */}
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 p-4">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-slate-800">
                  <bdi>{detail.thread.userName ?? "زبون"}</bdi>
                </h2>
                {detail.thread.userPhone !== null && (
                  <p className="text-xs text-slate-500" dir="ltr">
                    <bdi>{detail.thread.userPhone}</bdi>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    detail.thread.status === "open"
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {STATUS_LABELS[detail.thread.status]}
                </span>
                {detail.thread.status === "open" && (
                  <button
                    type="button"
                    onClick={() => void closeThread()}
                    disabled={closing}
                    className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {closing ? "…" : "إغلاق الخيط"}
                  </button>
                )}
              </div>
            </div>

            {/* الرسائل — in (زبون) رمادي بادئة، out (مكتب) أزرق نهاية */}
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
              {detail.messages.length === 0 && (
                <p className="my-auto text-center text-sm text-slate-400">لا رسائل بعد</p>
              )}
              {detail.messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                      m.direction === "out" ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-800"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                    <p
                      className={`mt-1 text-[10px] ${m.direction === "out" ? "text-sky-100" : "text-slate-400"}`}
                    >
                      {formatTime(m.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* الرد */}
            <div className="border-t border-slate-200 p-3">
              {detail.thread.status === "closed" ? (
                <p className="rounded-lg bg-slate-50 p-3 text-center text-xs text-slate-500">
                  هذا الخيط مغلق — يُفتح خيط جديد تلقائياً عند مراسلة الزبون من جديد.
                </p>
              ) : (
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendReply();
                  }}
                >
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    maxLength={REPLY_MAX}
                    rows={2}
                    placeholder="اكتب ردّك للزبون…"
                    className="min-h-[2.5rem] flex-1 resize-y rounded-lg border border-slate-300 p-2 text-sm focus:border-sky-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={sending || replyText.trim() === ""}
                    className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {sending ? "…" : "إرسال"}
                  </button>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
