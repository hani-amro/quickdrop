import { eq } from "drizzle-orm";
import { audienceFilterSchema, selectAudience, type AudienceFilter, type AudienceMember } from "./audience.js";
import type { Db } from "./client.js";
import { broadcasts, type Broadcast } from "./schema/index.js";
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
   * فلتر الجمهور (Campaigns): يُخزَّن ويُطبَّق عند البدء (enqueueBroadcast → selectAudience).
   * غيابه = بثّ لكل الزبائن الواصلين. يُتحقّق منه الـ API بـ audienceFilterSchema (§11).
   */
  audienceFilter?: AudienceFilter;
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

/** §4.3 — عضو جمهور البث: المعرّف الداخلي + معرّف تيليغرام (chat_id). موحّد مع audience.ts. */
export type BroadcastAudienceMember = AudienceMember;

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
 * §4.3/§4.3-campaigns — بدء الإرسال: علّم status='sending' واجلب الجمهور المستهدف بلقطة
 * واحدة (ترانزاكشن withTenant واحدة — §16.10 لا N+1). الجمهور الأساس = زبائن واصلون
 * (role='customer'، telegram NOT NULL، غير محظورين §4.3). **الحملات**: إن حمل الصف
 * audience_filter صالحاً يُضيَّق الجمهور بـ JOIN على customer_profiles (selectAudience) —
 * فلتر فارغ/غير موجود = بثّ للجميع (سلوك v1). فلتر مخزّن فاسد (لا يجب أن يحدث — الـ API
 * يتحقّق §11) → يُرمى (DLQ لا بثّ أعمى للكل §16.12).
 *
 * حارس idempotency (at-least-once §12): لا نُحيي بثّة منتهية — إن كانت 'done'/'failed'
 * لا نعيدها 'sending'، ونرجع جمهوراً فارغاً كي لا يُعاد الإرسال بإعادة جدولة المهمة.
 *
 * أما 'sending' فحالة **قابلة للاستئناف** لا منتهية: إعادة تشغيل المهمة (at-least-once §12)
 * تعيد الجمهور كاملاً هنا، ويتكفّل مستهلك البث بمجموعة "المُسلَّم إليهم" بـ Redis
 * (bcast:sent:{id}) بتخطّي من سُلِّم إليه — فلا إرسال مكرّر للكل، يُرسَل الذيل فقط. الجمهور
 * يُقصي المحظور (blocked_at IS NULL) فلا حاجة لتخطّيه في المستهلك (§4.3).
 */
export async function enqueueBroadcast(
  db: Db,
  tenantId: string,
  broadcastId: string,
): Promise<EnqueueBroadcastResult> {
  return withTenant(db, tenantId, async (tx) => {
    // الحارس الصريح: اقرأ الحالة + الفلتر أولاً ثم قرّر (§16.11 — قراءة ثم كتابة)
    const rows = await tx
      .select({ id: broadcasts.id, status: broadcasts.status, audienceFilter: broadcasts.audienceFilter })
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

    // الفلتر المخزّن: null → للجميع؛ صالح → يُطبَّق؛ فاسد → رمي (§16.12)
    let filter = null;
    if (current.audienceFilter !== null) {
      const parsed = audienceFilterSchema.safeParse(current.audienceFilter);
      if (!parsed.success) {
        throw new Error(`broadcast ${broadcastId}: stored audience_filter is malformed`);
      }
      filter = parsed.data;
    }

    await tx
      .update(broadcasts)
      .set({ status: "sending", updatedAt: new Date() })
      .where(eq(broadcasts.id, broadcastId));

    // selectAudience يبني الاستعلام (JOIN مشروط) داخل نفس الترانزاكشن المستأجرة
    const audience = await selectAudience(tx, tenantId, filter);
    return { alreadyFinalized: false, audience };
  });
}

/**
 * §4.3/§12 — تسجيل نتيجة البث: عدّادات النجاح/الفشل (**قيم مطلقة**) + status='done'.
 * تعيين مطلق لا إضافة (set لا increment): لو استُؤنفت المهمة وأُعيد استدعاؤها، تُكتب
 * العدّادات نفسها/أكبر (مشتقّة من SCARD مجموعات التسليم بـ Redis في المستهلك) فلا مضاعفة —
 * idempotent على الاستئناف (§12). صحّة الحالة (D8) مضمونة بمصدر الحقيقة (صف البثّة).
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
