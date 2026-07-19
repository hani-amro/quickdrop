// دمج WaFlow (MERGE_PLAN §24) — عميل CRM بالمتصفح: الوارد الموحّد (محادثات/رسائل + بطاقة
// الزبون 360). كل النداءات عبر /api/proxy (يحقن tenantSlug + التوكن خادمياً؛ لا DB بالواجهة).
// يوحّد وارد WaFlow مع دعم QuickDrop بواجهة محادثات واحدة (المخزن الموحّد — P2.4c).

import { ApiError } from "./api";

export type ConversationStatus = "open" | "pending" | "resolved" | "snoozed";

export interface ConversationListItem {
  id: string;
  userId: string;
  userName: string | null;
  userPhone: string | null;
  status: ConversationStatus;
  assignedStaffId: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  aiEnabled: boolean;
}

export interface ConversationMessage {
  id: string;
  channel: string; // whatsapp | telegram
  direction: string; // in | out
  type: string;
  content: string | null;
  mediaUrl: string | null;
  status: string;
  createdAt: string;
}

export interface ConversationDetail {
  conversation: ConversationListItem;
  messages: ConversationMessage[];
}

export interface Customer360 {
  userId: string;
  name: string | null;
  phone: string | null;
  waId: string | null;
  lifecycleStage: string | null;
  rfmScore: number | null;
  totalSpent: string | null; // D5 — نص لا رقم JS
  orderCount: number | null;
  facts: { key: string; value: string; source: string; confidence: number }[];
  recentOrders: { id: string; publicCode: string; status: string; goodsAmount: string; deliveredAt: string | null }[];
}

async function get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") qs.set(k, v);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await fetch(`/api/proxy/${path}${suffix}`, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

export const crm = {
  listConversations: (opts: { status?: ConversationStatus; before?: string; beforeId?: string } = {}): Promise<{ conversations: ConversationListItem[] }> =>
    get("crm/conversations", { status: opts.status, before: opts.before, beforeId: opts.beforeId }),
  getConversation: (id: string): Promise<ConversationDetail> => get(`crm/conversations/${id}`),
  getCustomer360: (userId: string): Promise<Customer360> => get(`crm/customers/${userId}`),
  // الرد يمرّ بمسار الدعم الموحّد (threadId = conversationId بعد الطي P2.4c) → outbox 'support.reply'
  reply: (conversationId: string, text: string): Promise<unknown> => post(`support/${conversationId}/reply`, { text }),
};
