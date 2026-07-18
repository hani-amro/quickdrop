import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  getConversation,
  getCustomer360,
  listConversations,
  type ConversationListItem,
  type Customer360,
  type DbHandle,
} from "@quickdrop/db";
import { CONVERSATION_STATUSES } from "@quickdrop/shared";
import { z } from "zod";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";
import { DB, ENV } from "../tokens.js";

// دمج WaFlow (MERGE_PLAN §3.6/P2 step 10) — REST قراءة CRM للداشبورد:
//   GET /api/crm/conversations          : قائمة المحادثات (?status اختياري، ?before للترقيم)
//   GET /api/crm/conversations/:id       : تفاصيل + رسائل (يصفّر unread)
//   GET /api/crm/customers/:userId       : بطاقة 360 (ملف الدماغ + طلبات + حقائق AI)
// نفس التخويل (Bearer STAFF_API_TOKEN / جلسة عبر الحارس §10.2) وانضباط Zod (§11) وحلّ
// المستأجر بالـ slug — نمط support/orders حرفياً. كل Date → ISO 8601 (D6).

const listQuerySchema = z.object({
  tenantSlug: slugSchema,
  status: z.preprocess((v) => (v === "" ? undefined : v), z.enum(CONVERSATION_STATUSES).optional()),
  before: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().datetime().optional()),
});

const detailQuerySchema = z.object({ tenantSlug: slugSchema });

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function serializeConversation(c: ConversationListItem): Record<string, unknown> {
  return {
    id: c.id,
    userId: c.userId,
    userName: c.userName,
    userPhone: c.userPhone,
    status: c.status,
    assignedStaffId: c.assignedStaffId,
    lastMessagePreview: c.lastMessagePreview,
    lastMessageAt: iso(c.lastMessageAt),
    unreadCount: c.unreadCount,
    aiEnabled: c.aiEnabled,
  };
}

@Injectable()
export class CrmService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async listConversations(authorization: string | undefined, query: unknown): Promise<{ conversations: Record<string, unknown>[] }> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(listQuerySchema, query, "crm_list_conversations");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const items = await listConversations(this.handle.db, tenant.id, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.before ? { before: new Date(input.before) } : {}),
    });
    return { conversations: items.map(serializeConversation) };
  }

  async getConversation(authorization: string | undefined, id: string, query: unknown): Promise<Record<string, unknown>> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const conversationId = parseOr400(uuidSchema, id, "crm_conversation_id");
    const input = parseOr400(detailQuerySchema, query, "crm_conversation_detail");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const detail = await getConversation(this.handle.db, tenant.id, conversationId);
    if (!detail) throw new NotFoundException("conversation not found");
    return {
      conversation: serializeConversation(detail.conversation),
      messages: detail.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    };
  }

  async getCustomer360(authorization: string | undefined, userId: string, query: unknown): Promise<Customer360WithIso> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const uid = parseOr400(uuidSchema, userId, "crm_customer_id");
    const input = parseOr400(detailQuerySchema, query, "crm_customer_360");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);
    const c = await getCustomer360(this.handle.db, tenant.id, uid);
    if (!c) throw new NotFoundException("customer not found");
    return {
      ...c,
      recentOrders: c.recentOrders.map((o) => ({ ...o, deliveredAt: iso(o.deliveredAt) })),
    };
  }
}

type Customer360WithIso = Omit<Customer360, "recentOrders"> & {
  recentOrders: (Omit<Customer360["recentOrders"][number], "deliveredAt"> & { deliveredAt: string | null })[];
};
