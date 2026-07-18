import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  closeSupportThread,
  getSupportThread,
  listSupportThreads,
  staffReplyToThread,
  type DbHandle,
  type SupportThreadDetail,
  type SupportThreadListItem,
} from "@quickdrop/db";
import { SUPPORT_THREAD_STATUSES, type MessageDirection, type SupportThreadStatus } from "@quickdrop/shared";
import { z } from "zod";
import { DB, ENV } from "../app.module.js";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";

// §9 — REST خيوط الدعم (customer↔support) من الداشبورد:
//   GET  /api/support               : قائمة الخيوط (?status=open|closed اختياري)
//   GET  /api/support/:id           : تفاصيل خيط + رسائله
//   POST /api/support/:id/reply     : رد الموظف (يكتب outbox 'support.reply' D9)
//   POST /api/support/:id/close     : إغلاق خيط
// نفس التخويل المؤقت (Bearer STAFF_API_TOKEN / جلسة عبر الحارس §10.2) وانضباط Zod (§11)
// وحلّ المستأجر بالـ slug — نمط orders/merchants حرفياً. كل Date تُعاد ISO 8601 (D6).

// —— Zod schemas (§11: الحدود) ——

// query strings: قيمة فارغة = غير مُرسلة (نفس preprocess قائمة الطلبات)
const listQuerySchema = z.object({
  tenantSlug: slugSchema,
  status: z.preprocess((v) => (v === "" ? undefined : v), z.enum(SUPPORT_THREAD_STATUSES).optional()),
});

const detailQuerySchema = z.object({ tenantSlug: slugSchema });

const replyBodySchema = z.object({
  tenantSlug: slugSchema,
  text: z.string().trim().min(1).max(2000),
});

const closeBodySchema = z.object({ tenantSlug: slugSchema });

// —— أشكال الاستجابة (كل Date → ISO string، وكل معرّف string) ——

export interface SupportThreadSummary {
  id: string;
  userId: string;
  userName: string | null;
  userPhone: string | null;
  status: SupportThreadStatus;
  assignedStaffId: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  createdAt: string;
}

export interface SupportMessageView {
  id: string;
  direction: MessageDirection;
  text: string;
  createdAt: string;
}

export interface ListSupportThreadsResponse {
  threads: SupportThreadSummary[];
}

export interface SupportThreadDetailResponse {
  thread: {
    id: string;
    userId: string;
    userName: string | null;
    userPhone: string | null;
    status: SupportThreadStatus;
    assignedStaffId: string | null;
    createdAt: string;
  };
  messages: SupportMessageView[];
}

export interface SupportReplyResponse {
  threadId: string;
}

export interface SupportCloseResponse {
  threadId: string;
  status: "closed";
}

function toThreadSummary(t: SupportThreadListItem): SupportThreadSummary {
  return {
    id: t.id,
    userId: t.userId,
    userName: t.userName,
    userPhone: t.userPhone,
    status: t.status,
    assignedStaffId: t.assignedStaffId,
    lastMessageText: t.lastMessageText,
    lastMessageAt: t.lastMessageAt !== null ? t.lastMessageAt.toISOString() : null, // D6: ISO 8601
    messageCount: t.messageCount,
    createdAt: t.createdAt.toISOString(),
  };
}

function toThreadDetail(d: SupportThreadDetail): SupportThreadDetailResponse {
  return {
    thread: {
      id: d.thread.id,
      userId: d.thread.userId,
      userName: d.thread.userName,
      userPhone: d.thread.userPhone,
      status: d.thread.status,
      assignedStaffId: d.thread.assignedStaffId,
      createdAt: d.thread.createdAt.toISOString(),
    },
    messages: d.messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

@Injectable()
export class SupportService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  // §9 — قائمة خيوط الدعم للمستأجر (اختيارياً بحالة open/closed).
  async listThreads(authorization: string | undefined, query: unknown): Promise<ListSupportThreadsResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(listQuerySchema, query, "support_list");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    // وسيط دالة اختياري (?) يقبل undefined مباشرةً — لا يخصّه قيد exactOptionalPropertyTypes (خاص بالخصائص)
    const threads = await listSupportThreads(this.handle.db, tenant.id, input.status);
    return { threads: threads.map(toThreadSummary) };
  }

  // §9 — تفاصيل خيط + رسائله؛ غير موجود = 404 (رسالة عامة §11).
  async getThread(authorization: string | undefined, id: string, query: unknown): Promise<SupportThreadDetailResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const threadId = parseOr400(uuidSchema, id, "support_detail_id");
    const input = parseOr400(detailQuerySchema, query, "support_detail");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const detail = await getSupportThread(this.handle.db, tenant.id, threadId);
    if (detail === null) throw new NotFoundException("not found");
    return toThreadDetail(detail);
  }

  // §9 — رد الموظف: staffReplyToThread يكتب رسالة out + outbox 'support.reply' بنفس الترانزاكشن.
  // أمان مؤقت: لا هوية موظف مع التوكن الثابت — staffId=null (كنمط orders/merchants §10.2 لاحقاً).
  // P2.4c: الخيوط الموحّدة لا تُغلق أمام الرد (رد على resolved يعيد فتحه) — لا حالة closed.
  async reply(authorization: string | undefined, id: string, body: unknown): Promise<SupportReplyResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const threadId = parseOr400(uuidSchema, id, "support_reply_id");
    const input = parseOr400(replyBodySchema, body, "support_reply");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const result = await staffReplyToThread(this.handle.db, tenant.id, threadId, null, input.text);
    if (result.outcome === "not_found") throw new NotFoundException("not found");
    console.log(
      JSON.stringify({ action: "support_reply_sent", tenant_id: tenant.id, thread_id: threadId, actor: "staff" }),
    );
    return { threadId: result.threadId };
  }

  // §9 — إغلاق خيط؛ غير موجود = 404. الإغلاق idempotent فعلياً (إغلاق مغلق = closed).
  async close(authorization: string | undefined, id: string, body: unknown): Promise<SupportCloseResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const threadId = parseOr400(uuidSchema, id, "support_close_id");
    const input = parseOr400(closeBodySchema, body, "support_close");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const result = await closeSupportThread(this.handle.db, tenant.id, threadId, null);
    if (result.outcome === "not_found") throw new NotFoundException("not found");
    console.log(
      JSON.stringify({ action: "support_thread_closed", tenant_id: tenant.id, thread_id: threadId, actor: "staff" }),
    );
    return { threadId, status: "closed" };
  }
}
