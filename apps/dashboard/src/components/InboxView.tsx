"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { crm, type ConversationDetail, type ConversationListItem, type Customer360 } from "@/lib/crm";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useRealtime } from "@/lib/useRealtime";
import { isResponseForSelected, shouldRecordInboxError, shouldShowInboxError } from "@/lib/inbox-guards";

// §25 — احتياط polling تحت الوقت الحقيقي: يضمن حداثة الوارد حتى للمسارات غير المبثوثة
// (رد المكتب المسجَّل بالـ API، دعم تيليغرام) ولو انقطع WS. الوقت الحقيقي يسرّع الحالة الشائعة.
const INBOX_POLL_MS = 12_000;

// دمج WaFlow (§24) — الوارد الموحّد: قائمة محادثات (start) + الخيط المحدَّد (رسائل + رد) +
// بطاقة الزبون 360 (end). قناة واحدة لكل زبون مهما تعدّدت القنوات (المخزن الموحّد P2.4c).
// كل تنسيق بخصائص منطقية (start/end, ms/me) — يعمل RTL وLTR بلا فرع.

function timeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function InboxView() {
  const t = useT();
  const [items, setItems] = useState<ConversationListItem[] | null>(null);
  const [error, setError] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [profile, setProfile] = useState<Customer360 | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);

  // معرّفا المحادثة المفتوحة والقائمة بمرجع حيّ — يقرأهما معالج الوقت الحقيقي وحلقة polling
  // والدوال غير المتزامنة بلا إعادة اشتراك ولا إغلاق قديم (stale closure).
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const itemsRef = useRef<ConversationListItem[] | null>(null);
  itemsRef.current = items;

  const loadList = useCallback(async () => {
    try {
      const { conversations } = await crm.listConversations();
      setItems(conversations);
      setError(null);
    } catch (e) {
      // مراجعة Phase 4 (correctness): لا تهدم الواجهة على فشل poll/realtime خلفي. شاشة
      // الخطأ فقط على التحميل الأولي (لا قائمة بعد)؛ قائمة محمّلة + انقطاع عابر = أبقِ آخر
      // حالة جيدة (كـ loadThread)، ويُصحَّح بأول poll ناجح (§25: الاحتياط صامت لا هادم).
      if (shouldRecordInboxError(itemsRef.current)) setError(e instanceof ApiError ? e.status : 500);
    }
  }, []);

  // تحديث خلفي للخيط المفتوح (رسالة جديدة/polling): لا يمحو الخيط عند فشل عابر — على عكس
  // openConversation الذي يُظهر حالة تحميل. الرسائل فقط تُحدَّث؛ بطاقة 360 لا تتأثر برسالة.
  // مراجعة Phase 4 (correctness): حارس سباق الترتيب — لا تكتب استجابة خيطٍ لم يعد المحدَّد.
  const loadThread = useCallback(async (id: string) => {
    const d = await crm.getConversation(id).catch(() => null);
    if (d !== null && isResponseForSelected(selectedRef.current, id)) setDetail(d);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // §25 — احتياط polling: يحدّث القائمة (والخيط المفتوح إن وُجد) دورياً ضماناً للحداثة
  useEffect(() => {
    const timer = setInterval(() => {
      void loadList();
      const id = selectedRef.current;
      if (id !== null) void loadThread(id);
    }, INBOX_POLL_MS);
    return () => clearInterval(timer);
  }, [loadList, loadThread]);

  // §25 — الوقت الحقيقي فوق الاحتياط: رسالة جديدة (وارد/صادر) تعيد جلب القائمة فوراً،
  // والخيط المفتوح إن كان هو المتغيّر. المعالج يقرأ selectedRef الحيّ (لا إعادة اشتراك).
  useRealtime({
    onConversationChanged: (e) => {
      void loadList();
      if (e.conversationId === selectedRef.current) void loadThread(e.conversationId);
    },
  });

  const openConversation = useCallback(async (item: ConversationListItem) => {
    setSelected(item.id);
    setDetail(null);
    setProfile(null);
    const [d, p] = await Promise.all([
      crm.getConversation(item.id).catch(() => null),
      crm.getCustomer360(item.userId).catch(() => null),
    ]);
    // مراجعة Phase 4 (correctness): سباق ترتيب — إن بدّل المستخدم الخيط أثناء الجلب،
    // تجاهل هذه الاستجابة القديمة (لا تكتب رسائل/بطاقة زبون لا تطابق المحدَّد الحالي).
    if (!isResponseForSelected(selectedRef.current, item.id)) return;
    setDetail(d);
    setProfile(p);
  }, []);

  const sendReply = useCallback(async () => {
    if (!selected || replyText.trim() === "" || sending) return;
    setSending(true);
    try {
      await crm.reply(selected, replyText.trim());
      setReplyText("");
      // إعادة الجلب عبر loadThread المحروس (سباق الترتيب + لا محو عند فشل عابر)
      await loadThread(selected);
    } finally {
      setSending(false);
    }
  }, [selected, replyText, sending, loadThread]);

  if (shouldShowInboxError(items, error)) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
        <button onClick={() => void loadList()} className="font-semibold underline">
          {t("common.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr_18rem]">
      {/* قائمة المحادثات */}
      <aside className="rounded-lg border border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-4 py-3 font-semibold text-slate-700">{t("inbox.title")}</h2>
        <ul className="max-h-[70dvh] overflow-y-auto">
          {items === null && <li className="px-4 py-3 text-slate-400">{t("common.loading")}</li>}
          {items !== null && items.length === 0 && <li className="px-4 py-6 text-center text-slate-400">{t("inbox.empty")}</li>}
          {items?.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => void openConversation(c)}
                className={`flex w-full flex-col items-start gap-0.5 border-b border-slate-50 px-4 py-3 text-start transition-colors ${
                  selected === c.id ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
              >
                <span className="flex w-full items-center justify-between">
                  <span className="font-medium text-slate-800">{c.userName ?? c.userPhone ?? c.userId.slice(0, 8)}</span>
                  {c.unreadCount > 0 && (
                    <span className="rounded-full bg-sky-600 px-2 py-0.5 text-xs text-white">{c.unreadCount}</span>
                  )}
                </span>
                <span className="line-clamp-1 text-sm text-slate-500">{c.lastMessagePreview ?? ""}</span>
                <span className="text-xs text-slate-400">{timeLabel(c.lastMessageAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* الخيط المحدَّد */}
      <section className="flex min-h-[70dvh] flex-col rounded-lg border border-slate-200 bg-white">
        {detail === null ? (
          <div className="flex flex-1 items-center justify-center text-slate-400">{t("inbox.selectHint")}</div>
        ) : (
          <>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {detail.messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                      m.direction === "out" ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-800"
                    }`}
                  >
                    <span className="block">{m.content ?? `[${m.type}]`}</span>
                    <span className={`mt-1 block text-xs ${m.direction === "out" ? "text-sky-100" : "text-slate-400"}`}>
                      {m.channel} · {timeLabel(m.createdAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 border-t border-slate-100 p-3">
              <input
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void sendReply()}
                placeholder={t("inbox.replyPlaceholder")}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                onClick={() => void sendReply()}
                disabled={sending || replyText.trim() === ""}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {t("common.send")}
              </button>
            </div>
          </>
        )}
      </section>

      {/* بطاقة الزبون 360 */}
      <aside className="rounded-lg border border-slate-200 bg-white p-4">
        {profile === null ? (
          <p className="text-slate-400">{t("inbox.customer")}</p>
        ) : (
          <dl className="space-y-2 text-sm">
            <div className="font-semibold text-slate-800">{profile.name ?? profile.phone ?? profile.waId ?? ""}</div>
            <Row label={t("inbox.lifecycle")} value={profile.lifecycleStage ?? "—"} />
            <Row label={t("inbox.rfm")} value={profile.rfmScore === null ? "—" : String(profile.rfmScore)} />
            <Row label={t("inbox.orders")} value={String(profile.orderCount ?? 0)} />
            <Row label={t("inbox.spent")} value={profile.totalSpent ?? "—"} />
            {profile.recentOrders.length > 0 && (
              <div>
                <div className="mt-2 font-medium text-slate-600">{t("inbox.recentOrders")}</div>
                <ul className="mt-1 space-y-1">
                  {profile.recentOrders.map((o) => (
                    <li key={o.id} className="text-slate-500">
                      #{o.publicCode} · {o.status}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </dl>
        )}
      </aside>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}
