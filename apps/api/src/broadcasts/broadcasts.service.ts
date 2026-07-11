import { Inject, Injectable } from "@nestjs/common";
import { broadcasts, createBroadcast, withTenant, type DbHandle } from "@quickdrop/db";
import { type BroadcastJob, type BroadcastStatus } from "@quickdrop/shared";
import type { Queue } from "bullmq";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { BROADCAST_Q, DB, ENV } from "../app.module.js";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";

// §4.3/§14 — REST البث الجماهيري بالداشبورد:
//   POST /api/broadcasts  → إنشاء بثّة + (إن غير مجدولة) دفعها لطابور البث فوراً
//   GET  /api/broadcasts  → قائمة البثات بعدّاداتها (ترقيم من الخادم §10.1)
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN — §10.2 لاحقاً) هنا.

const titleSchema = z.string().trim().min(1).max(200);
// حد رسالة تيليغرام ~4096 محرفاً — نرفض قبل الوصول للـ API (§11)
const bodySchema = z.string().trim().min(1).max(4096);

// D6 — ISO 8601 بإزاحة صريحة؛ يُخزَّن UTC. بثّة مجدولة = موعد مستقبلي (§4.3)
const scheduledAtSchema = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() > Date.now(), { message: "scheduledAt must be in the future" });

const createBodySchema = z.object({
  tenantSlug: slugSchema,
  title: titleSchema.optional(),
  body: bodySchema,
  scheduledAt: scheduledAtSchema.optional(),
});

const listQuerySchema = z.object({ tenantSlug: slugSchema });

export interface BroadcastSummary {
  id: string;
  title: string | null;
  body: string;
  status: BroadcastStatus;
  sentCount: number;
  failedCount: number;
  scheduledAt: string | null;
  createdAt: string;
}

export interface CreateBroadcastResponse {
  broadcast: BroadcastSummary;
  /** هل دُفعت للطابور فوراً (غير مجدولة)؟ */
  enqueued: boolean;
}

export interface ListBroadcastsResponse {
  broadcasts: BroadcastSummary[];
}

@Injectable()
export class BroadcastsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(BROADCAST_Q) private readonly queue: Queue<BroadcastJob>,
  ) {}

  // §4.3 — إنشاء بثّة: الصف durable أولاً، ثم دفع مهمة الطابور (jobId حتمي = broadcastId
  // يزيل تكرار at-least-once §12). البثّة المجدولة تبقى 'scheduled' بلا دفع الآن —
  // TODO(v2): جدولة delayed job عند scheduledAt، أو قاطف دوري يلتقط المستحقّة.
  async create(authorization: string | undefined, body: unknown): Promise<CreateBroadcastResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(createBodySchema, body, "broadcasts_create");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const created = await createBroadcast(this.handle.db, tenant.id, {
      body: input.body,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
    });

    const enqueued = input.scheduledAt === undefined;
    if (enqueued) {
      const job: BroadcastJob = { tenantId: tenant.id, broadcastId: created.id };
      await this.queue.add("send-broadcast", job, {
        jobId: created.id, // حتمي — إعادة الإنشاء/الضغط المكرر لا يزدوج (§16.7)
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 1000 },
      });
    }

    // §13 — لوغ منظّم بلا محتوى الرسالة (قد يحمل PII)
    console.log(
      JSON.stringify({
        action: "broadcast_created",
        tenant_id: tenant.id,
        broadcast_id: created.id,
        actor: "staff",
        status: created.status,
        enqueued,
      }),
    );

    return { broadcast: toSummary(created), enqueued };
  }

  // §10.1 — قائمة مختصرة بترقيم من الخادم: LIMIT 50 الأحدث أولاً؛ ممنوع SELECT *
  async list(authorization: string | undefined, query: unknown): Promise<ListBroadcastsResponse> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(listQuerySchema, query, "broadcasts_list");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const rows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({
          id: broadcasts.id,
          title: broadcasts.title,
          body: broadcasts.body,
          status: broadcasts.status,
          sentCount: broadcasts.sentCount,
          failedCount: broadcasts.failedCount,
          scheduledAt: broadcasts.scheduledAt,
          createdAt: broadcasts.createdAt,
        })
        .from(broadcasts)
        .where(and(eq(broadcasts.tenantId, tenant.id)))
        .orderBy(desc(broadcasts.createdAt))
        .limit(50),
    );

    return { broadcasts: rows.map((r) => toSummary(r)) };
  }
}

// شكل موحّد للاستجابة (D6: التواريخ ISO 8601)
function toSummary(row: {
  id: string;
  title: string | null;
  body: string;
  status: BroadcastStatus;
  sentCount: number;
  failedCount: number;
  scheduledAt: Date | null;
  createdAt: Date;
}): BroadcastSummary {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
