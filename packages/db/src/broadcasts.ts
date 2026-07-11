import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { broadcasts, users, type Broadcast } from "./schema/index.js";
import { withTenant } from "./with-tenant.js";

// §4.3/§14 v1.1 — البث الجماهيري. المبدأ: صف broadcasts هو مصدر الحقيقة للتقدّم
// (status + sent_count/failed_count)؛ الطابور تلميح تسريع لا حقيقة (§12). الإرسال
// الفعلي بالـ worker (broadcast-consumer.ts) مع احترام حدّ المعدل (§4.3) — هنا فقط
// الإنشاء وجلب الجمهور وتسجيل النتيجة، كلّه ضمن withTenant (§2.3).

export interface CreateBroadcastInput {
  /** عنوان اختياري يُعرض عريضاً فوق النص. */
  title?: string;
  /** نص البثّة — إلزامي. يُهرَّب HTML عند الإرسال (§4.3). */
  body: string;
  /**
   * فلتر الجمهور المستقبلي (v1: يُخزَّن ولا يُطبَّق — الجمهور = كل الزبائن الواصلين).
   * jsonb حرّ كي لا يقيّد المخطط تطوّر الفلاتر (منطقة/شريحة) لاحقاً.
   */
  audienceFilter?: Record<string, unknown>;
  /** موعد مستقبلي (D6: UTC) — وجوده يجعل الحالة 'scheduled' بدل 'draft'. */
  scheduledAt?: Date;
}

/**
 * §4.3 — إنشاء بثّة: status='scheduled' إن وُجد موعد مستقبلي، وإلا 'draft' (الـ api
 * يدفعها للطابور فوراً بعد الإنشاء). لا إرسال هنا — الصف durable أولاً ثم الطابور.
 */
export async function createBroadcast(db: Db, tenantId: string, input: CreateBroadcastInput): Promise<Broadcast> {
  return withTenant(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(broadcasts)
      .values({
        tenantId,
        body: input.body,
        status: input.scheduledAt !== undefined ? "scheduled" : "draft",
        // exactOptionalPropertyTypes: لا نمرّر undefined صريحاً للأعمدة الاختيارية
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.audienceFilter !== undefined ? { audienceFilter: input.audienceFilter } : {}),
        ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      // §16.12 — لا ابتلاع أخطاء
      throw new Error("createBroadcast: INSERT broadcasts ... RETURNING returned no row");
    }
    return row;
  });
}

/** §4.3 — عضو جمهور البث: المعرّف الداخلي + معرّف تيليغرام (chat_id) للإرسال. */
export interface BroadcastAudienceMember {
  userId: string;
  telegramUserId: number;
}

/**
 * نتيجة بدء البث. alreadyFinalized يميّز "منتهية سلفاً" (إعادة جدولة at-least-once §12)
 * عن "لا جمهور" (audience فارغ لكن يجب إنهاؤها done) — كلاهما audience=[] لكن معالجتهما
 * مختلفة: الأولى تُتجاهل، الثانية تُسجَّل نتيجتها صفرية.
 */
export interface EnqueueBroadcastResult {
  alreadyFinalized: boolean;
  audience: BroadcastAudienceMember[];
}

/** معرّف البثّة مدخل مستخدم (§11) — غير موجودة (أو محجوبة بـ RLS) = حالة عمل لا باغ. */
export class BroadcastNotFoundError extends Error {
  constructor(broadcastId: string) {
    super(`broadcast ${broadcastId} not found`);
    this.name = "BroadcastNotFoundError";
  }
}

/**
 * §4.3 — بدء الإرسال: علّم status='sending' واجلب الجمهور المستهدف بلقطة واحدة
 * (ترانزاكشن withTenant واحدة — §16.10 لا N+1). الجمهور v1 = كل الزبائن الواصلين:
 * role='customer'، telegram_user_id NOT NULL (لا زبون تلفون D15)، blocked_at IS NULL
 * (§4.3: المحظور لا يُرسَل له). audience_filter محفوظ ولا يُطبَّق بعد (v1).
 *
 * حارس idempotency (at-least-once §12): لا نُحيي بثّة منتهية — إن كانت 'done'/'failed'
 * لا نعيدها 'sending'، ونرجع جمهوراً فارغاً كي لا يُعاد الإرسال بإعادة جدولة المهمة.
 */
export async function enqueueBroadcast(
  db: Db,
  tenantId: string,
  broadcastId: string,
): Promise<EnqueueBroadcastResult> {
  return withTenant(db, tenantId, async (tx) => {
    // الحارس الصريح: اقرأ الحالة الحالية أولاً ثم قرّر (§16.11 — قراءة ثم كتابة)
    const rows = await tx
      .select({ id: broadcasts.id, status: broadcasts.status })
      .from(broadcasts)
      .where(eq(broadcasts.id, broadcastId))
      .limit(1);
    const current = rows[0];
    if (!current) {
      throw new BroadcastNotFoundError(broadcastId);
    }
    if (current.status === "done" || current.status === "failed") {
      // منتهية سلفاً (إعادة جدولة at-least-once): لا إرسال مكرّر ولا لمس للعدّادات
      return { alreadyFinalized: true, audience: [] };
    }

    await tx
      .update(broadcasts)
      .set({ status: "sending", updatedAt: new Date() })
      .where(eq(broadcasts.id, broadcastId));

    const rows2 = await tx
      .select({ userId: users.id, telegramUserId: users.telegramUserId })
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId), // فوق RLS — يقود فهرس (tenant_id, ...)
          eq(users.role, "customer"),
          isNotNull(users.telegramUserId),
          isNull(users.blockedAt),
        ),
      )
      .orderBy(users.createdAt); // ترتيب حتمي — الأقدم أولاً

    const audience = rows2.flatMap((r) =>
      // telegram_user_id NOT NULL مضمون بالـ WHERE؛ الحارس هنا يرضي المدقّق فقط
      r.telegramUserId === null ? [] : [{ userId: r.userId, telegramUserId: r.telegramUserId }],
    );
    return { alreadyFinalized: false, audience };
  });
}

/**
 * §4.3 — تسجيل نتيجة البث: عدّادات النجاح/الفشل + status='done'. append نهائي —
 * لا تُعاد كتابة النتيجة (المهمة الواحدة لكل بثّة، وjobId حتمي يزيل التكرار).
 */
export async function recordBroadcastResult(
  db: Db,
  tenantId: string,
  broadcastId: string,
  result: { sent: number; failed: number },
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(broadcasts)
      .set({ sentCount: result.sent, failedCount: result.failed, status: "done", updatedAt: new Date() })
      .where(eq(broadcasts.id, broadcastId)),
  );
}
