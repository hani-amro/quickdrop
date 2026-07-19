import {
  cancelActiveJourneyRuns,
  conversations,
  customerFacts,
  customerProfiles,
  getOrCreateConversation,
  recordInboundMessage,
  users,
  waWebhookUpdates,
  withTenant,
  type Db,
} from "@quickdrop/db";
import { publishSpineEvent } from "@quickdrop/spine";
import { waChangeValueSchema, type WaChangeValue } from "@quickdrop/whatsapp";
import type { MessageType, WaUpdateJob } from "@quickdrop/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

// MERGE_PLAN §3.1 (هيكل Phase 1) — مستهلك تحديثات واتساب: يقرأ صف الـ inbox (مصدر
// الحقيقة، الحمولة لا تُمرَّر بالمهمة §12)، يتحقق Zod عند الاستهلاك (§1)، يوحّد هوية
// الزبون بقواعد الدمج §4.3، ينشر أحداث الـ spine بنفس الترانزاكشن (D9)، ثم يعلّم
// processed بتحديث شرطي (idempotent — at-least-once).
// حفظ الرسائل بجداول conversations/messages = Phase 2 (§4.4) — الهيكل يتوقف هنا عمداً.

export interface WaUpdateProcessorDeps {
  appDb: Db;
  /**
   * §3.2 — مُطلِق وكيل الـ AI: يُستدعى **بعد التزام** ترانزاكشن المعالجة (نداء LLM شبكي
   * لا يجوز داخلها D6) لرسالة نصية واردة بخيط ai_enabled، ومرة واحدة فقط (recorded='inserted').
   *
   * مراجعة Phase 3 (idem-F1) — دلالة **at-most-once مقصودة**: الوكيل غير idempotent
   * (قد يُنشئ طلباً)، فإعادة تشغيله على فشل تخاطر بطلب مزدوج — أسوأ من ردّ ضائع. لذا:
   *  - الرسالة تُعلَّم processed بالالتزام، والمهمة تُقرّ (ack) بغضّ النظر عن نجاح الوكيل؛
   *    فشل الوكيل **لا يُعاد تشغيله** (لا retry يُنتج الرد ثانيةً — النص المضلِّل القديم أُزيل).
   *  - إعادة التسليم (crash قبل الإقرار) ترى processed→duplicate ولا تُعيد الإطلاق.
   * الأثر: قد يضيع رد واحد على انقطاع LLM/انهيار (نادر، غير مُفسِد) — يُلتقط بلوغ error
   * مرئي بالمراقبة. رد durable+idempotent (dedup آثار الأدوات لكل رسالة) عملٌ لاحق موثّق.
   */
  onAgentTrigger?: (trigger: AgentTrigger) => Promise<void>;
}

export interface AgentTrigger {
  tenantId: string;
  userId: string;
  conversationId: string;
  text: string;
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

const WA_MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);
const KNOWN_MESSAGE_TYPES = new Set<MessageType>([
  "text", "image", "video", "audio", "document", "sticker", "location", "interactive", "template", "reaction",
]);

/**
 * يستخرج {نوع، محتوى، وسائط} من رسالة واتساب (الشكل passthrough). الوسائط تُخزَّن
 * كمؤشّر `waid:<media_id>` (روابط Meta تنتهي صلاحيتها؛ التنزيل الفعلي مؤجّل). زر/قائمة
 * تفاعلية → نصّها. نوع غير معروف → text (لا نُسقط رسالة بسبب نوع جديد من Meta).
 */
function extractWaMessage(m: Record<string, unknown>): { type: MessageType; content?: string; mediaUrl?: string; mediaMime?: string; location?: { lat: number; lng: number } } {
  const rawType = typeof m["type"] === "string" ? (m["type"] as string) : "text";
  const type: MessageType = KNOWN_MESSAGE_TYPES.has(rawType as MessageType) ? (rawType as MessageType) : "text";

  if (rawType === "text") {
    const text = m["text"] as { body?: string } | undefined;
    return { type: "text", ...(text?.body !== undefined ? { content: text.body } : {}) };
  }
  if (WA_MEDIA_TYPES.has(rawType)) {
    const media = m[rawType] as { id?: string; caption?: string; mime_type?: string } | undefined;
    return {
      type,
      ...(media?.caption !== undefined ? { content: media.caption } : {}),
      ...(media?.id !== undefined ? { mediaUrl: `waid:${media.id}` } : {}),
      ...(media?.mime_type !== undefined ? { mediaMime: media.mime_type } : {}),
    };
  }
  if (rawType === "location") {
    const loc = m["location"] as { latitude?: number; longitude?: number; name?: string } | undefined;
    const content = loc?.name ?? (loc ? `${loc.latitude},${loc.longitude}` : undefined);
    // §3.2 — الإحداثيات بنية منفصلة: تُحفظ حقيقة last_location (مصدر dropoff لطلبات AI)
    return {
      type: "location",
      ...(content !== undefined ? { content } : {}),
      ...(typeof loc?.latitude === "number" && typeof loc.longitude === "number"
        ? { location: { lat: loc.latitude, lng: loc.longitude } }
        : {}),
    };
  }
  if (rawType === "interactive") {
    const it = m["interactive"] as { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined;
    const content = it?.button_reply?.title ?? it?.list_reply?.title;
    return { type: "interactive", ...(content !== undefined ? { content } : {}) };
  }
  if (rawType === "reaction") {
    const r = m["reaction"] as { emoji?: string } | undefined;
    return { type: "reaction", ...(r?.emoji !== undefined ? { content: r.emoji } : {}) };
  }
  return { type: "text" }; // نوع غير متوقّع — نحفظه كنص فارغ (لا إسقاط)
}

export async function processWaUpdate(deps: WaUpdateProcessorDeps, job: WaUpdateJob): Promise<WaUpdateOutcome> {
  // §3.2 — يُجمَع داخل الترانزاكشن ويُطلَق **بعد التزامها** (LLM شبكي — لا داخل ترانزاكشن)
  let agentTrigger: AgentTrigger | null = null;
  const outcome = await withTenant(deps.appDb, job.tenantId, async (tx) => {
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
      // §4.4 — الحفظ بالمخزن الموحّد: خيط الزبون + الرسالة (idempotent بـ wa_message_id)
      const { id: conversationId } = await getOrCreateConversation(tx, job.tenantId, customer.userId);
      const extracted = extractWaMessage(message as Record<string, unknown>);
      const recorded = await recordInboundMessage(tx, {
        tenantId: job.tenantId,
        conversationId,
        channel: "whatsapp",
        externalId: message.id,
        type: extracted.type,
        ...(extracted.content !== undefined ? { content: extracted.content } : {}),
        ...(extracted.mediaUrl !== undefined ? { mediaUrl: extracted.mediaUrl } : {}),
        ...(extracted.mediaMime !== undefined ? { mediaMime: extracted.mediaMime } : {}),
      });
      await publishSpineEvent(tx, job.tenantId, "wa.message.received", {
        waMessageId: message.id,
        conversationId,
        userId: customer.userId,
      });
      // §3.4 stop-on-reply — رد الزبون يلغي تسجيلاته النشطة بالرحلات (لا نطارد من تفاعل)
      await cancelActiveJourneyRuns(tx, job.tenantId, customer.userId);

      // §3.2 — رسالة موقع: حقيقة last_location (مصدر dropoff الوحيد لطلبات توصيل الوكيل)
      if (extracted.location) {
        await tx
          .insert(customerFacts)
          .values({
            tenantId: job.tenantId,
            userId: customer.userId,
            key: "last_location",
            value: JSON.stringify(extracted.location),
            source: "system",
          })
          .onConflictDoUpdate({
            target: [customerFacts.tenantId, customerFacts.userId, customerFacts.key],
            set: { value: JSON.stringify(extracted.location), source: "system", updatedAt: new Date() },
          });
      }

      // §3.2 — مُطلِق الوكيل: رسالة نصية جديدة (لا معادة — dedup) بخيط ai_enabled
      if (recorded === "inserted" && extracted.content && (extracted.type === "text" || extracted.type === "interactive")) {
        const convRows = await tx
          .select({ aiEnabled: conversations.aiEnabled })
          .from(conversations)
          .where(and(eq(conversations.tenantId, job.tenantId), eq(conversations.id, conversationId)))
          .limit(1);
        if (convRows[0]?.aiEnabled) {
          agentTrigger = { tenantId: job.tenantId, userId: customer.userId, conversationId, text: extracted.content };
        }
      }
    }
    // مفاتيح status:{wamid}:{status} — تحديث حالة رسالة صادرة: يُوصَل مع الإرسال الصادر

    await markProcessed(tx, job.tenantId, job.updateId);
    return "processed" as const;
  });

  // بعد الالتزام: إطلاق الوكيل (at-most-once مقصود — idem-F1 برأس الملف). فشله لا يُعاد
  // تشغيله (retry يخاطر بطلب مزدوج لوكيل غير idempotent)؛ يُلتقط بلوغ error مرئي بالمراقبة
  // — قد يضيع رد واحد على انقطاع LLM (نادر، غير مُفسِد؛ الزبون يعيد الإرسال أو يتدخّل بشري).
  // (cast: تحليل تدفّق TS لا يتتبّع الإسناد داخل الـ closure فيضيّق إلى never)
  const trigger = agentTrigger as AgentTrigger | null;
  if (outcome === "processed" && trigger && deps.onAgentTrigger) {
    try {
      await deps.onAgentTrigger(trigger);
    } catch (error) {
      console.error(
        JSON.stringify({
          action: "ai_agent_reply_lost", // idem-F1: رد ضائع (at-most-once) — مرئي للطاقم
          tenant_id: trigger.tenantId,
          conversation_id: trigger.conversationId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return outcome;
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
