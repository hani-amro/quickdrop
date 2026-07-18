import {
  customerProfiles,
  users,
  waWebhookUpdates,
  withTenant,
  type Db,
} from "@quickdrop/db";
import { publishSpineEvent } from "@quickdrop/spine";
import { waChangeValueSchema, type WaChangeValue } from "@quickdrop/whatsapp";
import type { WaUpdateJob } from "@quickdrop/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

// MERGE_PLAN §3.1 (هيكل Phase 1) — مستهلك تحديثات واتساب: يقرأ صف الـ inbox (مصدر
// الحقيقة، الحمولة لا تُمرَّر بالمهمة §12)، يتحقق Zod عند الاستهلاك (§1)، يوحّد هوية
// الزبون بقواعد الدمج §4.3، ينشر أحداث الـ spine بنفس الترانزاكشن (D9)، ثم يعلّم
// processed بتحديث شرطي (idempotent — at-least-once).
// حفظ الرسائل بجداول conversations/messages = Phase 2 (§4.4) — الهيكل يتوقف هنا عمداً.

export interface WaUpdateProcessorDeps {
  appDb: Db;
}

export type WaUpdateOutcome =
  | "processed"
  | "duplicate" // صف معالَج سلفاً — إعادة تسليم طابور
  | "missing" // صف غير موجود (تنظيف أقدم من المهمة؟) — لوغ فقط
  | "unparseable"; // حمولة لا تطابق السكيما — تُعلَّم processed كي لا تدور للأبد (لوغ صاخب)

/**
 * قواعد دمج هوية الزبون (§4.3, adversary #10): (1) طابق (tenant, wa_id)؛
 * (2) وإلا طابق (tenant, phone) واربط wa_id **فقط إذا كان NULL** — تضارب = مستخدم
 * جديد لا استيلاء؛ (3) وإلا أنشئ زبوناً + ملف CRM + حدث contact.created.
 */
async function upsertWaCustomer(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  waId: string,
  profileName: string | undefined,
): Promise<{ userId: string; created: boolean }> {
  const byWa = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.waId, waId)))
    .limit(1);
  if (byWa[0]) return { userId: byWa[0].id, created: false };

  // wa_id أرقام (E.164 بلا +) — نطابق عمود الهاتف بصيغته المخزنة "+..."
  const phone = `+${waId}`;
  // مراجعة Phase 1 (adversary): الربط لصفٍ **واحد** بمعرّفه — لا UPDATE غير محدود.
  // بلا LIMIT، وجود زبونَي تلفون بنفس الرقم (users بلا فريد على الهاتف) يجعل UPDATE
  // يضع نفس wa_id على صفين → خرق users_tenant_wa_uq → 23505 → حلقة تسميم دائمة لذاك
  // الرقم. نختار مرشّحاً واحداً ثم نحدّثه بمعرّفه مع حارس isNull(waId) (سباق ربط متزامن).
  const phoneCandidate = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.phoneE164, phone), isNull(users.waId), eq(users.role, "customer")))
    .limit(1);
  if (phoneCandidate[0]) {
    const attached = await tx
      .update(users)
      .set({ waId, updatedAt: new Date() })
      .where(and(eq(users.tenantId, tenantId), eq(users.id, phoneCandidate[0].id), isNull(users.waId)))
      .returning({ id: users.id });
    if (attached[0]) return { userId: attached[0].id, created: false };
    // خسرنا سباق الربط على هذا الصف (tx آخر أخذه) — أعد الحل بالـ wa_id ثم أنشئ
    const reWa = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.waId, waId)))
      .limit(1);
    if (reWa[0]) return { userId: reWa[0].id, created: false };
  }

  const inserted = await tx
    .insert(users)
    .values({
      tenantId,
      role: "customer",
      waId,
      phoneE164: phone,
      ...(profileName !== undefined ? { firstName: profileName } : {}),
    })
    .onConflictDoNothing() // سباق رسالتين متزامنتين لنفس الزبون الجديد — الفريد الجزئي يحسم
    .returning({ id: users.id });
  if (inserted[0]) {
    await tx
      .insert(customerProfiles)
      .values({ tenantId, userId: inserted[0].id })
      .onConflictDoNothing();
    return { userId: inserted[0].id, created: true };
  }
  // خسرنا السباق — الصف موجود الآن حتماً
  const winner = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.waId, waId)))
    .limit(1);
  if (!winner[0]) throw new Error(`upsertWaCustomer: lost race but no row for wa_id (tenant ${tenantId})`); // §16.12
  return { userId: winner[0].id, created: false };
}

export async function processWaUpdate(deps: WaUpdateProcessorDeps, job: WaUpdateJob): Promise<WaUpdateOutcome> {
  return withTenant(deps.appDb, job.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: waWebhookUpdates.id, status: waWebhookUpdates.status, payload: waWebhookUpdates.payload, eventKey: waWebhookUpdates.eventKey })
      .from(waWebhookUpdates)
      .where(and(eq(waWebhookUpdates.id, job.updateId), eq(waWebhookUpdates.tenantId, job.tenantId)))
      .limit(1)
      .for("update", { skipLocked: true });
    const row = rows[0];
    if (!row) return "missing";
    if (row.status === "processed") return "duplicate";

    const parsed = waChangeValueSchema.safeParse(row.payload);
    if (!parsed.success) {
      // §16.12 — لوغ صاخب ثم processed: الصف durable للفحص اليدوي، ولا يدور للأبد (R-16)
      console.error(
        JSON.stringify({ action: "wa_update", outcome: "unparseable", tenant_id: job.tenantId, update_id: job.updateId }),
      );
      await markProcessed(tx, job.tenantId, job.updateId);
      return "unparseable";
    }
    const value: WaChangeValue = parsed.data;

    // أسماء بروفايل واتساب حسب wa_id (اختيارية بالحمولة)
    const nameByWaId = new Map<string, string>();
    for (const c of value.contacts ?? []) {
      if (c.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
    }

    // رسالة هذا الصف فقط (صف لكل مفتاح حدث — البوابة C11): مفتاح wamid = رسالة واردة
    const message = (value.messages ?? []).find((m) => m.id === row.eventKey);
    if (message) {
      const customer = await upsertWaCustomer(tx, job.tenantId, message.from, nameByWaId.get(message.from));
      if (customer.created) {
        await publishSpineEvent(tx, job.tenantId, "contact.created", { userId: customer.userId, channel: "whatsapp" });
      }
      await publishSpineEvent(tx, job.tenantId, "wa.message.received", {
        waMessageId: message.id,
        userId: customer.userId,
      });
    }
    // مفاتيح status:{wamid}:{status} — تحديث حالة رسالة صادرة: يُستهلك بـ Phase 2 (messages)

    await markProcessed(tx, job.tenantId, job.updateId);
    return "processed";
  });
}

async function markProcessed(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  updateId: string,
): Promise<void> {
  // تحديث شرطي — نفس نمط update-processor التيليغرامي (idempotent تحت السباق)
  await tx
    .update(waWebhookUpdates)
    .set({ status: "processed" })
    .where(
      and(
        eq(waWebhookUpdates.id, updateId),
        eq(waWebhookUpdates.tenantId, tenantId),
        eq(waWebhookUpdates.status, "received"),
      ),
    );
}

export const WA_RESCAN_BATCH = 1000;

/**
 * rescan الإقلاع (§12 — الطوابير تلميحات): دفعة من صفوف received المتروكة، أقدمها
 * أولاً وبعد مُعطى `afterReceivedAt` (تصفّح للتصريف الكامل عند تجاوز الدفعة —
 * مراجعة Phase 1: 3000 صف عالق كان يُسترجَع منها 1000 فقط). المفتاح المركّب
 * (received_at, id) يمنع فقدان صفوف بنفس الطابع الزمني.
 */
export async function pendingWaUpdates(
  scanDb: Db,
  after?: { receivedAt: Date; id: string },
): Promise<{ id: string; tenantId: string; receivedAt: Date }[]> {
  const cursor = after
    ? sql`(${waWebhookUpdates.receivedAt}, ${waWebhookUpdates.id}) > (${after.receivedAt.toISOString()}, ${after.id})`
    : sql`true`;
  return scanDb
    .select({ id: waWebhookUpdates.id, tenantId: waWebhookUpdates.tenantId, receivedAt: waWebhookUpdates.receivedAt })
    .from(waWebhookUpdates)
    .where(and(eq(waWebhookUpdates.status, "received"), cursor))
    .orderBy(sql`${waWebhookUpdates.receivedAt} ASC, ${waWebhookUpdates.id} ASC`)
    .limit(WA_RESCAN_BATCH);
}
