import {
  claimWaDelivery,
  conversations,
  drivers,
  finalizeWaDeliverySent,
  getApprovedTemplate,
  getLastWhatsAppInboundAt,
  getOrCreateConversation,
  InvalidTransitionError,
  listOperatorChatsForMerchant,
  markWaDeliveryDegraded,
  offers,
  orderItems,
  orders,
  recordOutboundMessage,
  releaseWaDelivery,
  tenants,
  trackingTokens,
  transition,
  users,
  waAccounts,
  withTenant,
  type ApprovedTemplate,
  type Db,
} from "@quickdrop/db";
import {
  decryptSecret,
  isWithinServiceWindow,
  ORDER_STATUSES,
  publishRt,
  RT_EVENTS,
  type DispatchJob,
  type NotificationJob,
  type RtPublishClient,
  type WaDeliveryMode,
  type WaSendCategory,
  type WaTemplateKey,
} from "@quickdrop/shared";
import { WaApiError, WaClient } from "@quickdrop/whatsapp";
import { publishSpineEvent } from "@quickdrop/spine";
import {
  decryptBotToken,
  escapeHtml,
  getBotForTenant,
  merchantOrderCard,
  merchantOrderKeyboard,
  offerCard,
  orderCard,
  ORDER_STATUS_LABELS_AR,
  registerCustomerFlow,
  type Bot,
  type ConvRedis,
} from "@quickdrop/telegram";
import { parseSpineEvent } from "@quickdrop/spine";
import type { Queue } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
import { GrammyError, InlineKeyboard } from "grammy";
import { z } from "zod";
import { DISPATCH_JOB_OPTS, dispatchOrderJobId, offerTimeoutJobId } from "./dispatch-worker.js";

// D9/§12 — مستهلك الإشعارات الحقيقي: صفوف outbox تصل هنا عبر BullMQ **بعد التزام**
// ترانزاكشن الحدث؛ كل نداءات تيليغرام بهذا الملف خارج أي ترانزاكشن قاعدة (لا يوجد
// نداء شبكي داخل withTenant هنا — الترانزاكشنات قراءة/تحديث أعمدة فقط).
//
// idempotency (§12): التسليم at-least-once — الأفعال هنا آمنة التكرار:
// - editMessageText بنفس المحتوى → 'message is not modified' تُبتلع (§4.3).
// - إدراج مهام dispatch بـ jobId حتمي → الطابور يزيل الازدواج.
// - sendMessage قد تتكرر بنافذة انهيار نادرة (بين الإرسال وإتمام المهمة) — مقبول v1:
//   رسالة مكررة للمستخدم أهون من إشعار مفقود، ولا حالة مالية تُمسّ هنا.

export interface NotificationsConsumerDeps {
  /** دور app_user — كل قراءة/كتابة ضمن مستأجر عبر withTenant حصراً (§2.3). */
  appDb: Db;
  /** قراءة صف المستأجر نفسه (جدول tenants — استثناء RLS مسمّى §2.3). */
  scanDb: Db;
  /** حالة المحادثة (§4.4) — يمرَّر لتسجيل تدفقات البوت عند الإنشاء الأول بالـ LRU. */
  redis: ConvRedis;
  /** §4.2: MASTER_KEY (32 بايت) لفك تشفير bot_token_encrypted. */
  masterKey: Buffer;
  /** طابور الإسناد — إدراج dispatch-order عند استهلاك order.ready_for_dispatch (§4.2.3). */
  dispatchQueue: Queue<DispatchJob>;
  /** §10.1 — ناشر الوقت الحقيقي: PUBLISH على قناة RT_REDIS_CHANNEL (عملياً نفس عميل ioredis). */
  rtRedis: RtPublishClient;
  /** R-11 — حقن fetch لإرسال واتساب بالاختبارات (الافتراضي fetch العالمي). */
  waFetch?: typeof fetch;
}

// —— منطق صافٍ قابل للاختبار (§15) ——

/** §6.2 — تأخير مهمة المهلة: expires_at − الآن، وسالب (صف outbox تأخر) → 0 أي فوراً. */
export function offerTimeoutDelayMs(expiresAt: Date, now: Date): number {
  const delay = expiresAt.getTime() - now.getTime();
  return delay > 0 ? delay : 0;
}

/** §4.3 — editMessageText بنفس المحتوى: 400 'message is not modified' تُلتقط وتُتجاهل بصمت. */
export function isMessageNotModified(error: unknown): boolean {
  return (
    error instanceof GrammyError && error.error_code === 400 && error.description.includes("message is not modified")
  );
}

/** §4.3 — 403 Forbidden: المستخدم حظر البوت → blocked_at ولا إعادة محاولة (حرق rate limit ببلاش). */
export function isBlockedByUser(error: unknown): boolean {
  return error instanceof GrammyError && error.error_code === 403;
}

// §4.4 — callback_data ≤ 64 بايت: 'off:acc:' + UUID(36) = 44 بايت. المعالج المقابل
// (قبول/رفض السائق) ببوت السائق: packages/telegram/driver-flow.ts — نفس البادئتين بالعقد.
export function offerAcceptCallbackData(offerId: string): string {
  return `off:acc:${offerId}`;
}

export function offerRejectCallbackData(offerId: string): string {
  return `off:rej:${offerId}`;
}

// §11 — حدود النظام تمر بـ Zod: حمولة outbox عبرت طابوراً (jsonb → BullMQ) وتُتحقق
// عند الاستهلاك لا عند الإنتاج فقط (§1). فشل التحقق = رمي → retry ثم DLQ (§16.12).
export const orderStatusChangedPayloadSchema = z.object({
  orderId: z.string().uuid(),
  from: z.enum(ORDER_STATUSES),
  to: z.enum(ORDER_STATUSES),
});

export const offerCreatedPayloadSchema = z.object({
  offerId: z.string().uuid(),
  orderId: z.string().uuid(),
  driverId: z.string().uuid(),
  round: z.number().int().min(1),
  expiresAt: z.coerce.date(), // jsonb يسلسل Date إلى ISO نص — نعيده Date هنا
});

export const offerClosedPayloadSchema = z.object({
  offerId: z.string().uuid(),
});

export const dispatchExhaustedPayloadSchema = z.object({
  orderId: z.string().uuid(),
  round: z.number().int().optional(),
});

export const merchantNewOrderPayloadSchema = z.object({
  orderId: z.string().uuid(),
  merchantId: z.string().uuid(),
});

export const supportReplyPayloadSchema = z.object({
  threadId: z.string().uuid(),
  text: z.string().min(1),
});

// دمج WaFlow (خطوة 20/21) — حمولتا الدفع
export const paymentLinkPayloadSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  url: z.string().url(),
});

// خطوة 21 (R-11) — حالات تُبلَّغ لزبون واتساب نصياً (المرئية له؛ لا draft/scheduled الداخلية)
const WA_STATUS_NOTIFY: ReadonlySet<string> = new Set([
  "confirmed",
  "preparing",
  "ready",
  "assigned",
  "picked_up",
  "in_transit",
  "arrived",
  "delivered",
  "cancelled_by_office",
  "failed",
]);

// —— أدوات مشتركة ——

interface ActiveTenant {
  currency: string;
  botTokenEncrypted: Buffer | null;
}

/** صف المستأجر (scanDb — استثناء RLS مسمّى §2.3). معلّق/مؤرشف → null مع لوغ، بلا إعادة محاولة. */
async function loadActiveTenant(
  deps: NotificationsConsumerDeps,
  tenantId: string,
  topic: string,
): Promise<ActiveTenant | null> {
  const rows = await deps.scanDb
    .select({ status: tenants.status, currency: tenants.currency, botTokenEncrypted: tenants.botTokenEncrypted })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const tenant = rows[0];
  if (!tenant) {
    // §16.12: لا ابتلاع — مستأجر مجهول لصف outbox قائم فساد بيانات يستحق DLQ وتنبيهاً
    throw new Error(`notifications: tenant ${tenantId} not found`);
  }
  if (tenant.status === "suspended" || tenant.status === "churned") {
    // §14 — المعلّق لا يُرسَل باسمه شيء؛ الصف استُهلك (لا retry — التعليق قرار طويل الأمد)
    console.log(JSON.stringify({ action: "notification_skipped_tenant_inactive", tenantId, topic }));
    return null;
  }
  return { currency: tenant.currency, botTokenEncrypted: tenant.botTokenEncrypted };
}

/** bot من الـ LRU (§4.1-4) — فك التشفير عند أول استخدام فقط، والتوكن لا يظهر بأي لوغ (§4.2). */
async function getTenantBot(deps: NotificationsConsumerDeps, tenantId: string, tenant: ActiveTenant): Promise<Bot> {
  if (!tenant.botTokenEncrypted) {
    throw new Error(`notifications: tenant ${tenantId} has no bot token configured`);
  }
  const token = decryptBotToken(tenant.botTokenEncrypted, deps.masterKey);
  return getBotForTenant({
    tenantId,
    token,
    // نفس تسجيل update-processor كي يكون الـ instance المتشارك بالـ LRU مكتمل المعالجات
    // أياً كان مَن أنشأه أولاً. TODO(driver-flow): توحيد التسجيل بدالة واحدة مشتركة
    // عند إضافة تدفق السائق — الازدواج هنا مقصود ومؤقت.
    onCreate: (created) =>
      registerCustomerFlow(created, {
        db: deps.appDb,
        redis: deps.redis,
        tenantId,
        currency: tenant.currency,
      }),
  });
}

/** §4.3 — 403: علّم users.blocked_at (إن لم يكن معلَّماً) وأوقف كل إشعاراته — لا إعادة محاولة. */
async function markUserBlocked(deps: NotificationsConsumerDeps, tenantId: string, userId: string): Promise<void> {
  console.warn(JSON.stringify({ action: "telegram_user_blocked_bot", tenantId, userId }));
  await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .update(users)
      .set({ blockedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.blockedAt))),
  );
}

/**
 * إرسال رسالة مستقلة (غير بطاقة حية) مع معالجة 403 (§4.3): حظر → blocked_at ورجوع
 * هادئ؛ أي خطأ آخر يُعاد رميه (retry عبر BullMQ — §16.12).
 */
async function sendOrMarkBlocked(
  deps: NotificationsConsumerDeps,
  args: { tenantId: string; bot: Bot; chatId: number; userId: string; text: string; keyboard?: InlineKeyboard },
): Promise<void> {
  try {
    await args.bot.api.sendMessage(
      args.chatId,
      args.text,
      args.keyboard === undefined ? undefined : { reply_markup: args.keyboard },
    );
  } catch (error: unknown) {
    if (isBlockedByUser(error)) {
      await markUserBlocked(deps, args.tenantId, args.userId);
      return;
    }
    throw error;
  }
}

// —— R-11: نقل إشعارات الزبون الموحّد (NotificationTransport) — القناة سمة الزبون ——
// تيليغرام أولاً (بطاقات غنية)؛ وإلا واتساب (نص عبر Graph — توكن wa_accounts المشفّر).
// رسالة WA الصادرة تُسجَّل بالمخزن الموحّد (conversations/messages) قبل الإرسال —
// الكتابة داخل ترانزاكشن والإرسال بعدها (D6: لا نداء شبكي داخل ترانزاكشن).

type CustomerSendOutcome =
  | "sent_telegram"
  | "sent_whatsapp"
  | "skipped_no_channel"
  | "skipped_blocked"
  | "skipped_already_handled" // Task A — ادّعاء exactly-once لم يُربَح (محاولة سابقة)
  | "degraded_no_template"; // Task A — خارج النافذة بلا قالب معتمد (سُجِّل + حدث spine)

interface CustomerChannelRow {
  userId: string;
  telegramUserId: number | null;
  waId: string | null;
  blockedAt: Date | null;
}

async function loadCustomerChannel(deps: NotificationsConsumerDeps, tenantId: string, userId: string): Promise<CustomerChannelRow | null> {
  const rows = await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .select({ userId: users.id, telegramUserId: users.telegramUserId, waId: users.waId, blockedAt: users.blockedAt })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1),
  );
  return rows[0] ?? null;
}

/** عميل WA للمستأجر (توكن wa_accounts مفكوك بالمفتاح الرئيسي) — null إن لم تُهيّأ القناة. */
async function getTenantWaClient(deps: NotificationsConsumerDeps, tenantId: string): Promise<WaClient | null> {
  const rows = await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .select({ phoneNumberId: waAccounts.phoneNumberId, accessTokenEnc: waAccounts.accessTokenEnc, isActive: waAccounts.isActive })
      .from(waAccounts)
      .where(eq(waAccounts.tenantId, tenantId))
      .limit(1),
  );
  const acc = rows[0];
  if (!acc || !acc.isActive || !acc.accessTokenEnc) return null;
  const accessToken = decryptSecret(acc.accessTokenEnc, deps.masterKey);
  return new WaClient({
    accessToken,
    phoneNumberId: acc.phoneNumberId,
    ...(deps.waFetch !== undefined ? { fetchImpl: deps.waFetch } : {}),
  });
}

// ——— Task A (D1) — نافذة واتساب 24 ساعة + قوالب HSM عند حدّ الإرسال الصادر ———

/** عدم تطابق متغيّرات القالب (المُرسِل لم يوفّر متغيّراً يطلبه variable_map) — باغ منتِج، صاخب. */
class WaTemplateVarError extends Error {
  constructor(key: string, variable: string) {
    super(`wa template "${key}": missing required variable "${variable}"`);
    this.name = "WaTemplateVarError";
  }
}

// خريطة حالة الطلب → مفتاح قالب الإشعار (للحالات التي لها قالب v1؛ غيرها → null → degrade خارج النافذة).
const WA_STATUS_TEMPLATE_KEY: Partial<Record<string, WaTemplateKey>> = {
  confirmed: "order_confirmed",
  assigned: "order_dispatched",
  arrived: "driver_arriving",
  delivered: "order_delivered",
};

/** سياق إرسال واتساب (يمرَّر من المستدعي عبر outboxId/topic). */
interface WaSendContext {
  outboxId: string;
  category: WaSendCategory;
  internalKey: WaTemplateKey | null;
  templateVars: Record<string, string>;
}

type WaSendOutcome = "sent_whatsapp" | "skipped_no_channel" | "skipped_already_handled" | "degraded_no_template";

/** تسجيل الرسالة الصادرة بالمخزن الموحّد + بثّ RT (أفضل جهد — فشله لا يُرمى؛ الإرسال نجح سلفاً). */
async function recordWaOutbound(
  deps: NotificationsConsumerDeps,
  tenantId: string,
  conversationId: string,
  content: string,
  type: "text" | "template",
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await withTenant(deps.appDb, tenantId, (tx) =>
      recordOutboundMessage(tx, { tenantId, conversationId, channel: "whatsapp", type, content, metadata }),
    );
    await publishRt(deps.rtRedis, { tenantId, event: RT_EVENTS.conversationChanged, payload: { conversationId, direction: "out" } });
  } catch (error) {
    console.error(JSON.stringify({ action: "wa_outbound_record_failed", tenantId, conversationId, message: error instanceof Error ? error.message : String(error) }));
  }
}

/**
 * إرسال واتساب واعٍ بالنافذة (D1): داخل نافذة الـ24 ساعة أو service_reply → نص حرّ؛ خارجها
 * (notification) → قالب HSM معتمد، وإلا **degraded مرئي** (سجلّ + حدث spine) لا إسقاط صامت.
 * exactly-once بادّعاء على صفّ الـoutbox (لا شحن مزدوج للقوالب). الإرسال الفعلي خارج أي
 * ترانزاكشن (D6). المصدر = getLastWhatsAppInboundAt (خاص بواتساب، من messages).
 */
async function sendCustomerWhatsApp(
  deps: NotificationsConsumerDeps,
  tenantId: string,
  args: { userId: string; waId: string; freeFormText: string } & WaSendContext,
): Promise<WaSendOutcome> {
  const wa = await getTenantWaClient(deps, tenantId);
  if (!wa) return "skipped_no_channel";

  const conversationId = await withTenant(deps.appDb, tenantId, async (tx) => {
    const { id } = await getOrCreateConversation(tx, tenantId, args.userId);
    return id;
  });

  const inWindow = await withTenant(deps.appDb, tenantId, async (tx) => {
    const last = await getLastWhatsAppInboundAt(tx, tenantId, conversationId);
    return isWithinServiceWindow(last, new Date());
  });
  const useFreeForm = args.category === "service_reply" || inWindow;

  // خارج النافذة (notification): يلزم قالب معتمد؛ غيابه → degraded (لا إرسال حرّ)
  let template: ApprovedTemplate | null = null;
  if (!useFreeForm) {
    if (args.internalKey !== null) {
      template = await withTenant(deps.appDb, tenantId, (tx) => getApprovedTemplate(tx, tenantId, args.internalKey as WaTemplateKey));
    }
    if (template === null) {
      const reason = args.internalKey === null ? "no_template_key_for_notification" : `no_approved_template:${args.internalKey}`;
      const claim = await withTenant(deps.appDb, tenantId, async (tx) => {
        const c = await claimWaDelivery(tx, tenantId, args.outboxId, { mode: "degraded", status: "degraded", internalKey: args.internalKey, reason });
        if (c.won) {
          await publishSpineEvent(tx, tenantId, "notification.undeliverable", { outboxId: args.outboxId, userId: args.userId, internalKey: args.internalKey, reason });
        }
        return c;
      });
      if (claim.won) {
        console.warn(JSON.stringify({ action: "wa_notification_undeliverable", tenantId, userId: args.userId, internalKey: args.internalKey, reason }));
      } else if (claim.existing?.status === "claimed") {
        // تناظر مع مسار الادّعاء العادي: ادّعاء عالق (انهيار بين الادّعاء والإرسال ثم انقضت النافذة)
        // خسر ادّعاء degrade → لا نتركه صامتاً؛ نلوّج بصوت عالٍ كي يبقى الفقد النادر مرئياً (D7).
        console.warn(JSON.stringify({ action: "wa_delivery_claim_stuck", tenantId, outboxId: args.outboxId }));
      }
      return "degraded_no_template";
    }
  }

  // ادّعاء exactly-once على صفّ الـoutbox قبل مكالمة Meta (يمنع التكرار عبر إعادات المحاولة/التزامن)
  const mode: WaDeliveryMode = useFreeForm ? "free_form" : "template";
  const claim = await withTenant(deps.appDb, tenantId, (tx) =>
    claimWaDelivery(tx, tenantId, args.outboxId, { mode, status: "claimed", internalKey: useFreeForm ? null : args.internalKey }),
  );
  if (!claim.won) {
    if (claim.existing?.status === "claimed") {
      // ادّعاء سابق لم يُنهَ (انهيار نادر بين الادّعاء والإرسال) — لا نعيد الإرسال (تفادي الشحن
      // المزدوج للحالة الغامضة)، لكن نلوّج بصوت عالٍ كي لا يكون الفقد النادر صامتاً.
      console.warn(JSON.stringify({ action: "wa_delivery_claim_stuck", tenantId, outboxId: args.outboxId }));
    }
    return "skipped_already_handled"; // sent/degraded → تخطٍّ نظيف (at-most-once)
  }

  try {
    let metaMessageId: string | null;
    let recordContent: string;
    let recordType: "text" | "template";
    let recordMeta: Record<string, unknown>;
    if (useFreeForm) {
      const res = await wa.sendText(args.waId, args.freeFormText);
      metaMessageId = res.messageId;
      recordContent = args.freeFormText;
      recordType = "text";
      recordMeta = { system: true };
    } else {
      const t = template as ApprovedTemplate;
      const bodyParams = t.variableMap.map((name) => {
        const v = args.templateVars[name];
        if (v === undefined) throw new WaTemplateVarError(args.internalKey ?? "?", name);
        return v;
      });
      const res = await wa.sendTemplate(args.waId, t.metaTemplateName, t.language, bodyParams);
      metaMessageId = res.messageId;
      recordContent = `[HSM:${args.internalKey}]`;
      recordType = "template";
      recordMeta = { system: true, template: t.metaTemplateName, internalKey: args.internalKey };
    }
    await withTenant(deps.appDb, tenantId, (tx) => finalizeWaDeliverySent(tx, tenantId, args.outboxId, metaMessageId));
    await recordWaOutbound(deps, tenantId, conversationId, recordContent, recordType, recordMeta);
    return "sent_whatsapp";
  } catch (error) {
    if (error instanceof WaTemplateVarError) {
      // خطأ إعداد **دائم** (variable_map يطلب متغيّراً لا يوفّره المُرسِل) — الإعادة لن تصلحه؛
      // فالرمي = عاصفة إعادة حتى DLQ (فخّ DoS ذاتي). نحوّله degraded مرئياً (سجلّ + حدث spine)
      // بدل ذلك — لا شيء أُرسِل بعد (الخطأ قبل مكالمة Meta)، فالتحويل آمن ولا إسقاط صامت.
      const reason = `template_var_mismatch:${error.message}`;
      await withTenant(deps.appDb, tenantId, async (tx) => {
        await markWaDeliveryDegraded(tx, tenantId, args.outboxId, reason);
        await publishSpineEvent(tx, tenantId, "notification.undeliverable", { outboxId: args.outboxId, userId: args.userId, internalKey: args.internalKey, reason });
      });
      console.warn(JSON.stringify({ action: "wa_template_var_mismatch", tenantId, outboxId: args.outboxId, internalKey: args.internalKey }));
      return "degraded_no_template";
    }
    if (error instanceof WaApiError) {
      // Meta ردّت خطأً = لم تُرسِل (فشل مؤكَّد) → حرّر الادّعاء وارمِ لإعادة المحاولة (لا شحن مزدوج)
      await withTenant(deps.appDb, tenantId, (tx) => releaseWaDelivery(tx, tenantId, args.outboxId));
      throw error;
    }
    // فشل شبكي غامض (لا ردّ من Meta) — السياسة تختلف حسب الوضع:
    if (useFreeForm) {
      // نص حرّ = بلا كلفة ولا خطر شحن مزدوج → حرّر الادّعاء وارمِ لإعادة المحاولة.
      // (at-least-once للحرّ: تكرار نادر مقبول، أما الإسقاط الصامت فلا — يخالف "NOT silent drop".)
      await withTenant(deps.appDb, tenantId, (tx) => releaseWaDelivery(tx, tenantId, args.outboxId));
      throw error;
    }
    // قالب مدفوع: قد تكون Meta استلمت → at-most-once (علّم 'sent'، تفادي الشحن المزدوج)؛ الفقد النادر مرئي بالسجلّ
    await withTenant(deps.appDb, tenantId, (tx) => finalizeWaDeliverySent(tx, tenantId, args.outboxId, null));
    console.error(JSON.stringify({ action: "wa_send_ambiguous_marked_sent", tenantId, outboxId: args.outboxId, message: error instanceof Error ? error.message : String(error) }));
    return "sent_whatsapp";
  }
}

/**
 * إرسال نص لزبون عبر قناته: TG إن وُجد (403→blocked_at)، وإلا WA (عبر sendCustomerWhatsApp
 * الواعي بالنافذة/القوالب — Task A). سياق واتساب (outboxId/category/internalKey/templateVars)
 * يمرَّر من المستدعي؛ مسار TG يتجاهله.
 */
async function sendTextToCustomer(
  deps: NotificationsConsumerDeps,
  tenant: ActiveTenant,
  tenantId: string,
  customer: CustomerChannelRow,
  text: string,
  wa: WaSendContext,
): Promise<CustomerSendOutcome> {
  if (customer.blockedAt !== null) return "skipped_blocked";
  if (customer.telegramUserId !== null) {
    const bot = await getTenantBot(deps, tenantId, tenant);
    // §4.3 — parse_mode HTML افتراضي من المصنع: النص قد يحمل مدخل مستخدم → escape للتيليغرام
    await sendOrMarkBlocked(deps, { tenantId, bot, chatId: customer.telegramUserId, userId: customer.userId, text: escapeHtml(text) });
    return "sent_telegram";
  }
  if (customer.waId !== null) {
    // Task A (D1) — المسار الواعي بالنافذة/القوالب + exactly-once + degraded مرئي. يتولّى
    // getTenantWaClient والتسجيل الموحّد وبثّ RT داخله.
    return sendCustomerWhatsApp(deps, tenantId, {
      userId: customer.userId,
      waId: customer.waId,
      freeFormText: text,
      outboxId: wa.outboxId,
      category: wa.category,
      internalKey: wa.internalKey,
      templateVars: wa.templateVars,
    });
  }
  return "skipped_no_channel";
}

// —— المفصل (§4.2.3 D-M1): order.ready_for_dispatch هو **مُنتِج الإسناد الوحيد** ——
// المحفّز القديم (to='confirmed' هنا) حُذف (adversary #2): كان يُرسل سائقاً فيزيائياً
// لطلبات pickup ويُشعل الطعام مرتين. الحدث يصدر حصراً من ختم write-once بـ transition()،
// وهذا المستهلك idempotent مرتين: jobId حتمي بالطابور (تسليم مزدوج → مهمة واحدة)،
// وstartRound نفسه يعيد العرض المعلّق القائم بدل خلق ثانٍ.
async function handleReadyForDispatch(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const parsed = parseSpineEvent("order.ready_for_dispatch", job.payload);
  if (!parsed.ok || parsed.event.topic !== "order.ready_for_dispatch") {
    // §16.12 — حمولة فاسدة لموضوع معروف: باغ منتِج يستحق DLQ لا تجاهلاً صامتاً
    throw new Error(`order.ready_for_dispatch: invalid payload (${parsed.ok ? "topic mismatch" : parsed.reason})`);
  }
  const { orderId } = parsed.event.payload;
  await deps.dispatchQueue.add(
    "dispatch-order",
    { kind: "dispatch-order", tenantId: job.tenantId, orderId, round: 1 },
    { ...DISPATCH_JOB_OPTS, jobId: dispatchOrderJobId(orderId, 1) },
  );
}

// —— order.status_changed: بطاقة الزبون الحية + تقليم توكن التتبع ——

async function handleOrderStatusChanged(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const payload = orderStatusChangedPayloadSchema.parse(job.payload);

  // §10.1 — بث اللوحة فوراً وقبل أي تيليغرام (الموزّع أولى بالخبر من البطاقة):
  // الحدث حقيقة ملتزمة (صف outbox كُتب بترانزاكشن الانتقال D8/D9)، والحمولة معرّف
  // وحالة فقط (§11). أفضل جهد: polling الداشبورد هو الاحتياط المضمون، وat-least-once
  // يكرره أحياناً — أثره refetch إضافي غير مؤذٍ.
  await publishRt(deps.rtRedis, {
    tenantId: job.tenantId,
    event: RT_EVENTS.orderChanged,
    payload: { orderId: payload.orderId, to: payload.to },
  });

  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;

  // §7 — رابط التتبع العام يموت بعد التسليم بساعة: قلّص expires_at عند delivered.
  // tracking_tokens استثناء RLS مسمّى (§2.3) — تحديث مباشر بلا withTenant، مقيَّد
  // بالمستأجر والطلب معاً. LEAST يجعل التكرار (at-least-once §12) غير مُمدِّد للصلاحية:
  // إعادة المهمة لاحقاً لا تُحيي توكناً بدأ يحتضر.
  if (payload.to === "delivered") {
    await deps.appDb
      .update(trackingTokens)
      .set({ expiresAt: sql`LEAST(${trackingTokens.expiresAt}, now() + interval '1 hour')` })
      .where(and(eq(trackingTokens.tenantId, job.tenantId), eq(trackingTokens.orderId, payload.orderId)));
  }

  const row = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const rows = await tx
      .select({
        orderId: orders.id,
        publicCode: orders.publicCode,
        status: orders.status,
        priceTotal: orders.priceTotal,
        customerMsgId: orders.customerMsgId,
        customerUserId: users.id,
        customerTgId: users.telegramUserId,
        customerWaId: users.waId,
        customerBlockedAt: users.blockedAt,
      })
      .from(orders)
      .innerJoin(users, eq(orders.customerId, users.id))
      .where(eq(orders.id, payload.orderId))
      .limit(1);
    return rows[0];
  });
  if (!row) {
    // §16.12: صف outbox عن طلب غير موجود = فساد بيانات — فشل صاخب (retry ثم DLQ)
    throw new Error(`notifications: order ${payload.orderId} not found for order.status_changed`);
  }

  if (row.customerTgId === null) {
    // R-11 (خطوة 21) — زبون واتساب: رسالة حالة نصية عبر Graph للحالات المرئية للزبون؛
    // زبون تلفون (لا قناة): تتبعه بالهاتف/رابط /t/{token} — تخطٍّ بلوغ (D15).
    if (row.customerWaId !== null && row.customerBlockedAt === null && WA_STATUS_NOTIFY.has(row.status)) {
      // Task A (D1) — واعٍ بالنافذة: داخلها نص حرّ؛ خارجها قالب حالة معتمد (confirmed/assigned/
      // arrived/delivered)، وإلا degraded مرئي. exactly-once + تسجيل داخل sendCustomerWhatsApp.
      const outcome = await sendCustomerWhatsApp(deps, job.tenantId, {
        userId: row.customerUserId,
        waId: row.customerWaId,
        freeFormText: `📦 طلبك #${row.publicCode}: ${ORDER_STATUS_LABELS_AR[row.status]}`,
        outboxId: job.outboxId,
        category: "notification",
        internalKey: WA_STATUS_TEMPLATE_KEY[row.status] ?? null,
        templateVars: { code: row.publicCode },
      });
      if (outcome === "skipped_no_channel") {
        console.log(JSON.stringify({ action: "notification_wa_skipped_no_channel", tenantId: job.tenantId, orderId: row.orderId }));
      }
      return;
    }
    console.log(
      JSON.stringify({ action: "notification_skipped_no_telegram", tenantId: job.tenantId, orderId: row.orderId }),
    );
    return;
  }
  if (row.customerBlockedAt !== null) {
    // §4.3 — محظور سابقاً: لا إرسال ولا إعادة محاولة
    console.log(
      JSON.stringify({ action: "notification_skipped_user_blocked", tenantId: job.tenantId, userId: row.customerUserId }),
    );
    return;
  }

  // البطاقة من صف القاعدة **الحالي** لا من payload.to (D16 روحاً): رسالتا حالة
  // متسابقتان/معادتان تتقاربان لنفس المحتوى، والمكررة تُبتلع بـ 'not modified'.
  const bot = await getTenantBot(deps, job.tenantId, tenant);
  const text = orderCard({
    publicCode: row.publicCode,
    status: row.status,
    priceTotal: row.priceTotal,
    currency: tenant.currency,
  });

  if (row.customerMsgId !== null) {
    try {
      await bot.api.editMessageText(row.customerTgId, row.customerMsgId, text);
      return;
    } catch (error: unknown) {
      if (isMessageNotModified(error)) return; // §4.3: نفس المحتوى — تجاهل صامت
      if (isBlockedByUser(error)) {
        await markUserBlocked(deps, job.tenantId, row.customerUserId);
        return;
      }
      // §4.3 v1.1 — أي فشل تعديل آخر (رسالة محذوفة مثلاً): بطاقة جديدة بدلها، مع لوغ صريح
      console.error(
        JSON.stringify({
          action: "customer_card_edit_failed",
          tenantId: job.tenantId,
          orderId: row.orderId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  let sentMsgId: number;
  try {
    const sent = await bot.api.sendMessage(row.customerTgId, text);
    sentMsgId = sent.message_id;
  } catch (error: unknown) {
    if (isBlockedByUser(error)) {
      await markUserBlocked(deps, job.tenantId, row.customerUserId);
      return;
    }
    throw error; // §16.12: أعد الرمي — BullMQ retry
  }

  // §3 customer_msg_id — تحديث عمود عادي عبر withTenant؛ ليس status فلا يمسّ آلة الحالة (D8)
  await withTenant(deps.appDb, job.tenantId, (tx) =>
    tx.update(orders).set({ customerMsgId: sentMsgId, updatedAt: new Date() }).where(eq(orders.id, row.orderId)),
  );
}

// —— offer.created: بطاقة عرض للسائق + جدولة مهلة العرض ——

async function handleOfferCreated(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const payload = offerCreatedPayloadSchema.parse(job.payload);

  // §6.2/D16 — جدولة المهلة **أولاً وقبل أي تيليغرام**: الـ delayed job منبّه فقط
  // ومصدر الحقيقة offers.expires_at (المعالج يقفل ويتحقق قبل أي فعل)؛ لو فشل إرسال
  // البطاقة وأُعيدت المهمة، jobId 'ot:{offerId}' يمنع جدولة مزدوجة.
  await deps.dispatchQueue.add(
    "offer-timeout",
    { kind: "offer-timeout", tenantId: job.tenantId, offerId: payload.offerId },
    {
      ...DISPATCH_JOB_OPTS,
      jobId: offerTimeoutJobId(payload.offerId),
      delay: offerTimeoutDelayMs(payload.expiresAt, new Date()),
    },
  );

  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;

  const row = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const driverRows = await tx
      .select({ driverUserId: users.id, driverTgId: users.telegramUserId, driverBlockedAt: users.blockedAt })
      .from(drivers)
      .innerJoin(users, eq(drivers.userId, users.id))
      .where(eq(drivers.id, payload.driverId))
      .limit(1);
    const orderRows = await tx
      .select({
        publicCode: orders.publicCode,
        pickupText: orders.pickupText,
        dropoffText: orders.dropoffText,
        priceTotal: orders.priceTotal,
      })
      .from(orders)
      .where(eq(orders.id, payload.orderId))
      .limit(1);
    return { driver: driverRows[0], order: orderRows[0] };
  });
  if (!row.driver || !row.order) {
    throw new Error(`notifications: driver or order missing for offer ${payload.offerId}`); // §16.12
  }

  if (row.driver.driverTgId === null || row.driver.driverBlockedAt !== null) {
    // سائق بلا تيليغرام (شاذ — بوت السائق قناته الوحيدة) أو حاظر للبوت: لا إرسال؛
    // العرض سينتهي بمهلته المجدولة أعلاه وتتوسع الجولة (§6.2) — لا طلب معلّق للأبد.
    console.warn(
      JSON.stringify({
        action: "offer_card_skipped_driver_unreachable",
        tenantId: job.tenantId,
        offerId: payload.offerId,
        driverId: payload.driverId,
      }),
    );
    return;
  }

  const bot = await getTenantBot(deps, job.tenantId, tenant);
  // §4.4 — callback_data قصيرة ≤ 64 بايت؛ الزر يحمل كل السياق (offerId) فيعمل
  // حتى بلا أي حالة محادثة. المعالج: driver-flow.ts (بالعقد).
  const keyboard = new InlineKeyboard()
    .text("✅ قبول", offerAcceptCallbackData(payload.offerId))
    .text("❌ رفض", offerRejectCallbackData(payload.offerId));

  await sendOrMarkBlocked(deps, {
    tenantId: job.tenantId,
    bot,
    chatId: row.driver.driverTgId,
    userId: row.driver.driverUserId,
    text: offerCard({
      publicCode: row.order.publicCode,
      pickupText: row.order.pickupText,
      dropoffText: row.order.dropoffText,
      priceTotal: row.order.priceTotal,
      currency: tenant.currency,
      round: payload.round,
      expiresAt: payload.expiresAt,
    }),
    keyboard,
  });
}

// —— offer.superseded / offer.expired: إعلام السائق أن العرض انتهى ——

async function handleOfferClosed(
  deps: NotificationsConsumerDeps,
  job: NotificationJob,
  kind: "superseded" | "expired",
): Promise<void> {
  const payload = offerClosedPayloadSchema.parse(job.payload);

  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;

  // §6.2 — الرسالة تُشتق من صفوف القاعدة (العرض/الطلب/السائق)، والموضوع نفسه كُتب
  // بنفس ترانزاكشن قرار الإغلاق (D16) — لا علاقة لأي مفتاح Redis بالقرار أو النص.
  const row = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const rows = await tx
      .select({
        publicCode: orders.publicCode,
        driverUserId: users.id,
        driverTgId: users.telegramUserId,
        driverBlockedAt: users.blockedAt,
      })
      .from(offers)
      .innerJoin(orders, eq(offers.orderId, orders.id))
      .innerJoin(drivers, eq(offers.driverId, drivers.id))
      .innerJoin(users, eq(drivers.userId, users.id))
      .where(eq(offers.id, payload.offerId))
      .limit(1);
    return rows[0];
  });
  if (!row) {
    throw new Error(`notifications: offer ${payload.offerId} not found for offer.${kind}`); // §16.12
  }

  if (row.driverTgId === null || row.driverBlockedAt !== null) {
    console.log(
      JSON.stringify({ action: "notification_skipped_driver_unreachable", tenantId: job.tenantId, offerId: payload.offerId }),
    );
    return;
  }

  // v1 — رسالة قصيرة بدل تعديل بطاقة العرض: معرّف رسالة العرض غير محفوظ بالقاعدة.
  // TODO(v2): عمود offers.driver_msg_id يُملأ عند إرسال البطاقة ثم تُعدَّل هنا
  // ("استُلم الطلب"/"انتهت المهلة") بدل رسالة إضافية — أقل ضجيجاً للسائق.
  const code = escapeHtml(row.publicCode);
  const text =
    kind === "superseded"
      ? `عرض الطلب <b>⁦#${code}⁩</b> استُلم من سائق تاني 🤝`
      : `انتهت مهلة عرض الطلب <b>⁦#${code}⁩</b> ⌛`;

  const bot = await getTenantBot(deps, job.tenantId, tenant);
  await sendOrMarkBlocked(deps, {
    tenantId: job.tenantId,
    bot,
    chatId: row.driverTgId,
    userId: row.driverUserId,
    text,
  });
}

// —— dispatch.exhausted: تحذير منظّم + طمأنة الزبون ——

async function handleDispatchExhausted(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const payload = dispatchExhaustedPayloadSchema.parse(job.payload);

  // §6.2 — بعد MAX_DISPATCH_ROUNDS جولات فاشلة: لا تدُر للأبد بصمت. اللوغ التحذيري
  // المنظّم هو مصدر تنبيه الداشبورد الصوتي/البصري لاحقاً (§13: تنبيه قابل للتنفيذ).
  console.warn(
    JSON.stringify({
      action: "dispatch_exhausted",
      tenantId: job.tenantId,
      orderId: payload.orderId,
      round: payload.round ?? null,
      outboxId: job.outboxId,
    }),
  );

  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;

  const row = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const rows = await tx
      .select({ customerUserId: users.id, customerTgId: users.telegramUserId, customerBlockedAt: users.blockedAt })
      .from(orders)
      .innerJoin(users, eq(orders.customerId, users.id))
      .where(eq(orders.id, payload.orderId))
      .limit(1);
    return rows[0];
  });
  if (!row) {
    throw new Error(`notifications: order ${payload.orderId} not found for dispatch.exhausted`); // §16.12
  }
  if (row.customerTgId === null || row.customerBlockedAt !== null) {
    // D15 زبون تلفون أو حاظر — المكتب يتواصل هاتفياً؛ التحذير أعلاه سُجّل بكل الأحوال
    console.log(
      JSON.stringify({ action: "notification_skipped_no_telegram", tenantId: job.tenantId, orderId: payload.orderId }),
    );
    return;
  }

  const bot = await getTenantBot(deps, job.tenantId, tenant);
  await sendOrMarkBlocked(deps, {
    tenantId: job.tenantId,
    bot,
    chatId: row.customerTgId,
    userId: row.customerUserId,
    text: "جاري البحث عن سائق 🔎 — سيتواصل معك المكتب قريباً 🙏",
  });
}

// —— merchant.new_order: بطاقة الطلب الجديد لكل مشغّلي المطعم (قبول/رفض) ——

async function handleMerchantNewOrder(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const payload = merchantNewOrderPayloadSchema.parse(job.payload);

  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;

  const data = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const orderRows = await tx
      .select({
        publicCode: orders.publicCode,
        dropoffText: orders.dropoffText,
        goodsAmount: orders.goodsAmount,
        merchantId: orders.merchantId,
        status: orders.status,
      })
      .from(orders)
      .where(eq(orders.id, payload.orderId))
      .limit(1);
    const order = orderRows[0];
    if (!order) return null;
    const items = await tx
      .select({ nameAr: orderItems.nameSnapshot, qty: orderItems.qty, unitPrice: orderItems.unitPriceSnapshot })
      .from(orderItems)
      .where(eq(orderItems.orderId, payload.orderId));
    return { order, items };
  });
  if (!data) {
    throw new Error(`notifications: order ${payload.orderId} not found for merchant.new_order`); // §16.12
  }

  // الطلب قد يكون أُلغي/تقدّم قبل استهلاك الصف (at-least-once متأخر) — لا تُزعج التاجر بطلب
  // ميت. القبول/الرفض لاحقاً محروسان بالقاعدة أصلاً (D16)، لكن البطاقة نفسها بلا معنى هنا.
  if (data.order.status !== "pending") {
    console.log(
      JSON.stringify({ action: "merchant_notify_skipped_not_pending", tenantId: job.tenantId, orderId: payload.orderId, status: data.order.status }),
    );
    return;
  }

  const chats = await listOperatorChatsForMerchant(deps.appDb, job.tenantId, payload.merchantId);
  if (chats.length === 0) {
    // لا مشغّل مربوط بعد — الاحتياط v1 قائم (اتصال الموزّع + زر الداشبورد §3). لوغ لا فشل.
    console.log(
      JSON.stringify({ action: "merchant_notify_no_operators", tenantId: job.tenantId, merchantId: payload.merchantId, orderId: payload.orderId }),
    );
    return;
  }

  const bot = await getTenantBot(deps, job.tenantId, tenant);
  const text = merchantOrderCard({
    publicCode: data.order.publicCode,
    lines: data.items,
    goodsAmount: data.order.goodsAmount,
    dropoffText: data.order.dropoffText,
    currency: tenant.currency,
  });
  const keyboard = merchantOrderKeyboard(payload.orderId);

  for (const chatId of chats) {
    try {
      await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (error: unknown) {
      if (isBlockedByUser(error)) {
        // المشغّل حظر البوت — تخطٍّ هادئ (لا صف users للمشغّلين في v1، فلا blocked_at)
        console.warn(
          JSON.stringify({ action: "merchant_operator_blocked_bot", tenantId: job.tenantId, merchantId: payload.merchantId, chatId }),
        );
        continue;
      }
      throw error; // §16.12: خطأ آخر → retry (قد يكرّر بطاقة لمشغّل سابق — مقبول at-least-once)
    }
  }
}

// —— support.reply: إيصال رد المكتب على خيط الدعم إلى الزبون عبر البوت (§9) ——

async function handleSupportReply(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const payload = supportReplyPayloadSchema.parse(job.payload);

  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;

  // P2.4c — الخيط الآن محادثة موحّدة (conversations)؛ نحلّ صاحبها لإرسال الرد عبر تيليغرام.
  const row = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const rows = await tx
      .select({
        userId: users.id,
        telegramUserId: users.telegramUserId,
        blockedAt: users.blockedAt,
      })
      .from(conversations)
      .innerJoin(users, and(eq(users.tenantId, conversations.tenantId), eq(users.id, conversations.userId)))
      .where(eq(conversations.id, payload.threadId))
      .limit(1);
    return rows[0];
  });
  if (!row) {
    // §16.12: صف outbox عن محادثة غير موجودة = فساد بيانات — فشل صاخب (retry ثم DLQ)
    throw new Error(`notifications: conversation ${payload.threadId} not found for support.reply`);
  }

  if (row.telegramUserId === null) {
    // D15 — زبون تلفون بلا تيليغرام: لا قناة بوت؛ المكتب يرد هاتفياً — تخطٍّ بصمت مع لوغ
    console.log(
      JSON.stringify({ action: "support_reply_skipped_no_telegram", tenantId: job.tenantId, threadId: payload.threadId }),
    );
    return;
  }
  if (row.blockedAt !== null) {
    // §4.3 — محظور سابقاً: لا إرسال ولا إعادة محاولة
    console.log(
      JSON.stringify({ action: "support_reply_skipped_user_blocked", tenantId: job.tenantId, userId: row.userId }),
    );
    return;
  }

  const bot = await getTenantBot(deps, job.tenantId, tenant);
  await sendOrMarkBlocked(deps, {
    tenantId: job.tenantId,
    bot,
    chatId: row.telegramUserId,
    userId: row.userId,
    // نص المكتب مدخل مستخدم → escapeHtml (parse_mode HTML افتراضي من المصنع §4.3)
    text: `💬 <b>رد المكتب:</b>\n${escapeHtml(payload.text)}`,
  });
}

// —— payment.paid (§4.2.5 / adversary #18): تأكيد pickup آلياً + إشعار الزبون ——
// بوابة البشر: التأكيد الآلي بالدفع لطلبات fulfillment='pickup' **حصراً** (لا إسناد لها
// أبداً)؛ طلبات التوصيل يؤكّدها موظف/تاجر — الدفع وحده لا يحرّك سائقاً.

async function handlePaymentPaid(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const parsed = parseSpineEvent("payment.paid", job.payload);
  if (!parsed.ok || parsed.event.topic !== "payment.paid") {
    throw new Error(`payment.paid: invalid payload (${parsed.ok ? "topic mismatch" : parsed.reason})`); // §16.12
  }
  const { orderId } = parsed.event.payload;
  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;

  const row = await withTenant(deps.appDb, job.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: orders.id, publicCode: orders.publicCode, status: orders.status, fulfillment: orders.fulfillment, customerId: orders.customerId, driverId: orders.driverId })
      .from(orders)
      .where(and(eq(orders.tenantId, job.tenantId), eq(orders.id, orderId)))
      .limit(1);
    return rows[0];
  });
  if (!row) {
    throw new Error(`payment.paid: order ${orderId} not found`); // §16.12 — فساد بيانات
  }

  if (row.fulfillment === "pickup" && row.status === "pending") {
    try {
      await withTenant(deps.appDb, job.tenantId, (tx) =>
        transition(tx, { orderId, to: "confirmed", actor: { type: "system" }, meta: { reason: "payment_paid_pickup" } }),
      );
    } catch (error) {
      // §4.2.5 (adversary #6): الطلب تحرّك بين القراءة والقفل (أُكّد/أُلغي) — نجاح idempotent
      if (!(error instanceof InvalidTransitionError)) throw error;
    }
  }

  // مراجعة Phase 3 (money-F2): طلب مُسنَد لسائق دُفع إلكترونياً — نبّه السائق كي لا يحصّل
  // كاشاً ببطاقة قديمة (cod_amount صار 0؛ تحصيله سيسجَّل codReceived=0 والزبون شُحن مرتين).
  if (row.driverId !== null) {
    await notifyDriverPaidOnline(deps, tenant, job.tenantId, row.driverId, row.publicCode);
  }

  // إشعار الزبون بقناته (R-11) — فشل الإرسال يعيد المهمة؛ التأكيد أعلاه idempotent
  const customer = await loadCustomerChannel(deps, job.tenantId, row.customerId);
  if (customer) {
    const outcome = await sendTextToCustomer(deps, tenant, job.tenantId, customer, `✅ استلمنا دفعتك لطلب #${row.publicCode} — شكراً لك!`, {
      outboxId: job.outboxId,
      category: "notification",
      internalKey: "payment_receipt",
      templateVars: { code: row.publicCode },
    });
    if (outcome !== "sent_telegram" && outcome !== "sent_whatsapp") {
      console.log(JSON.stringify({ action: "payment_paid_notify_skipped", tenantId: job.tenantId, orderId, outcome }));
    }
  }
}

/** money-F2 — رسالة للسائق المُسنَد: دُفع الطلب إلكترونياً، لا تحصّل كاش. */
async function notifyDriverPaidOnline(
  deps: NotificationsConsumerDeps,
  tenant: ActiveTenant,
  tenantId: string,
  driverId: string,
  publicCode: string,
): Promise<void> {
  const rows = await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .select({ userId: users.id, telegramUserId: users.telegramUserId, blockedAt: users.blockedAt })
      .from(drivers)
      .innerJoin(users, and(eq(users.tenantId, drivers.tenantId), eq(users.id, drivers.userId)))
      .where(and(eq(drivers.tenantId, tenantId), eq(drivers.id, driverId)))
      .limit(1),
  );
  const driver = rows[0];
  if (!driver || driver.telegramUserId === null || driver.blockedAt !== null) return; // بلا قناة/محظور — تخطٍّ
  const bot = await getTenantBot(deps, tenantId, tenant);
  await sendOrMarkBlocked(deps, {
    tenantId,
    bot,
    chatId: driver.telegramUserId,
    userId: driver.userId,
    text: escapeHtml(`💳 طلب #${publicCode} دُفع إلكترونياً — لا تحصّل كاشاً من الزبون.`),
  });
}

// —— payment.anomaly (money-F1): دفع متأخر/لمرجع مجهول — تنبيه للطاقم (استرداد يدوي) ——
async function handlePaymentAnomaly(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  // لا مسار تنبيه طاقم مباشر بعد (لا قناة staff-push) — نرفعه بلوغ error منظّم مرئي
  // بالمراقبة (§13) + Sentry عبر رمي؟ لا: الرمي يعيد الجدولة بلا فائدة. نسجّل ونعيد.
  void deps;
  console.error(JSON.stringify({ action: "payment_anomaly", tenantId: job.tenantId, payload: job.payload }));
}

// —— payment.link (خطوة 20): إيصال رابط الدفع للزبون عبر قناته ——

async function handlePaymentLink(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const payload = paymentLinkPayloadSchema.parse(job.payload);
  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;
  const customer = await loadCustomerChannel(deps, job.tenantId, payload.userId);
  if (!customer) {
    throw new Error(`payment.link: user ${payload.userId} not found`); // §16.12
  }
  const outcome = await sendTextToCustomer(deps, tenant, job.tenantId, customer, `💳 رابط الدفع لطلبك:\n${payload.url}`, {
    outboxId: job.outboxId,
    category: "notification",
    internalKey: null, // لا قالب v1 لرابط الدفع → خارج النافذة degrade (مرئي)
    templateVars: {},
  });
  if (outcome !== "sent_telegram" && outcome !== "sent_whatsapp") {
    console.log(JSON.stringify({ action: "payment_link_notify_skipped", tenantId: job.tenantId, orderId: payload.orderId, outcome }));
  }
}

// —— journey.message: إيصال رسالة رحلة أتمتة إلى الزبون عبر البوت (§3.4) ——

const journeyMessagePayloadSchema = z.object({ userId: z.string().uuid(), text: z.string().min(1) }).passthrough();

async function handleJourneyMessage(deps: NotificationsConsumerDeps, job: NotificationJob): Promise<void> {
  const payload = journeyMessagePayloadSchema.parse(job.payload);
  const tenant = await loadActiveTenant(deps, job.tenantId, job.topic);
  if (!tenant) return;

  const row = await loadCustomerChannel(deps, job.tenantId, payload.userId);
  if (!row) {
    // §16.12 — رسالة رحلة لزبون غير موجود = فساد بيانات — فشل صاخب
    throw new Error(`notifications: user ${payload.userId} not found for journey.message`);
  }
  // R-11 (اكتمل بـ Phase 3): النقل الموحّد — TG أولاً وإلا WA؛ لا قناة/محظور → تخطٍّ بلوغ.
  // Task A — agent.reply = ردّ داخل محادثة (service_reply، حرّ)؛ journey.message = تسويق
  // (notification: خارج النافذة يلزم قالب — لا قالب v1 → degrade مرئي).
  const outcome = await sendTextToCustomer(deps, tenant, job.tenantId, row, payload.text, {
    outboxId: job.outboxId,
    category: job.topic === "agent.reply" ? "service_reply" : "notification",
    internalKey: null,
    templateVars: {},
  });
  if (outcome === "skipped_no_channel" || outcome === "skipped_blocked") {
    console.log(JSON.stringify({ action: "journey_message_skipped", tenantId: job.tenantId, userId: row.userId, outcome }));
  }
}

/**
 * D9/§12 — معالج طابور الإشعارات (NOTIFICATIONS_QUEUE): يوزّع حسب topic.
 * §16.12: لا ابتلاع أخطاء — الرمي يعيد الجدولة عبر BullMQ backoff؛ الحالات التي
 * لا ينفع معها retry (403، مستأجر معلّق، topic مجهول) تُعالج صراحةً بلوغ ورجوع هادئ.
 */
export function createNotificationsProcessor(deps: NotificationsConsumerDeps): (job: NotificationJob) => Promise<void> {
  return async (job) => {
    switch (job.topic) {
      case "order.status_changed":
        await handleOrderStatusChanged(deps, job);
        return;
      case "order.ready_for_dispatch":
        // المفصل (§4.2.3) — مُنتِج الإسناد الوحيد
        await handleReadyForDispatch(deps, job);
        return;
      case "offer.created":
        await handleOfferCreated(deps, job);
        return;
      case "offer.superseded":
        await handleOfferClosed(deps, job, "superseded");
        return;
      case "offer.expired":
        await handleOfferClosed(deps, job, "expired");
        return;
      case "dispatch.exhausted":
        await handleDispatchExhausted(deps, job);
        return;
      case "merchant.new_order":
        await handleMerchantNewOrder(deps, job);
        return;
      case "support.reply":
        await handleSupportReply(deps, job);
        return;
      case "journey.message":
        await handleJourneyMessage(deps, job);
        return;
      case "agent.reply":
        // §3.2 — رد وكيل الـ AI: نفس حمولة {userId, text} ونفس نقل R-11 (TG وإلا WA)
        await handleJourneyMessage(deps, job);
        return;
      case "payment.paid":
        // خطوة 20 (§4.2.5): تأكيد pickup آلياً + إشعار الزبون (الدماغ/الرحلات عبر BRAIN_QUEUE)
        await handlePaymentPaid(deps, job);
        return;
      case "payment.link":
        await handlePaymentLink(deps, job);
        return;
      case "payment.anomaly":
        await handlePaymentAnomaly(deps, job);
        return;
      default:
        // topic مجهول (منتج أحدث/أقدم): لوغ تحذيري بلا رمي — retry بلا فائدة (§16.12
        // معالجة صريحة لا ابتلاع: القرار مسجَّل ومرئي بالمراقبة §13).
        console.warn(
          JSON.stringify({
            action: "notification_unknown_topic",
            topic: job.topic,
            tenantId: job.tenantId,
            outboxId: job.outboxId,
          }),
        );
    }
  };
}
