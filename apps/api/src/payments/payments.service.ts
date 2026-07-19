import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createBill, deleteBill, verifyBillplzSignature } from "@quickdrop/billplz";
import { attachPaymentRef, markOrderPaidByRef, orders, tenants, withTenant, type DbHandle } from "@quickdrop/db";
import { decryptSecret, type OrderStatus } from "@quickdrop/shared";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";
import { DB, ENV } from "../tokens.js";

// مراجعة Phase 3 (HIGH): لا رابط دفع لطلب نهائي (يمنع رابطاً حيّاً يُدفع بعد التسليم).
const TERMINAL_STATUSES_API: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "delivered",
  "cancelled_by_customer",
  "cancelled_by_office",
  "returned",
  "failed",
]);

// دمج WaFlow (MERGE_PLAN §7 خطوة 20، قرار المالك) — Billplz:
//   POST /payments/billplz/:tenantSlug/callback — عام؛ **التوقيع هو المصادقة** (HMAC
//     x_signature لكل مستأجر، ثابت الزمن). تحقق → علِّم مدفوعاً (رتيب + تصفير COD +
//     صف payment.paid بنفس الترانزاكشن) → 200. المرجع المجهول/إعادة النداء → 200 هادئة
//     (إعادات Billplz at-least-once — idempotent).
//   POST /api/payments/send-link — موظف: ينشئ فاتورة (bigint سنتات، لا float)، يربط
//     المرجع write-once (إعادة الطلب تعيد نفس الفاتورة)، ويكتب outbox 'payment.link'
//     (الإرسال للزبون عبر قناته بعد الالتزام — D6، لا نداء شبكي داخل ترانزاكشن).

const sendLinkBodySchema = z.object({ tenantSlug: slugSchema, orderId: uuidSchema });

/** إسقاط جسم urlencoded إلى Record<string,string> مسطّح (قيم غير نصية تُقصى — §11). */
export function flattenCallbackBody(body: unknown): Record<string, string> {
  const flat: Record<string, string> = {};
  if (body !== null && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === "string") flat[k] = v;
    }
  }
  return flat;
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly handle: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * بوابة Billplz — التوقيع مصادقة؛ لا جلسة ولا Bearer.
   * مراجعة Phase 3 (security-L1): **استجابة موحّدة** لكل فشل قبل التحقق (مستأجر مجهول/
   * غير مهيأ/توقيع فاسد → 401 واحد) كي لا يُسرَّب وجود المستأجرين أو تهيئة الدفع
   * (البوابة معفاة من حد المعدل). السبب الحقيقي باللوغ الخادمي فقط.
   */
  async billplzCallback(tenantSlug: string, body: unknown): Promise<string> {
    const slug = parseOr400(slugSchema, tenantSlug, "billplz_callback_slug");
    const params = flattenCallbackBody(body);

    // اعتمادات المستأجر (استثناء RLS مسمّى — نفس نمط بوابة tg/wa)
    const rows = await this.handle.db
      .select({ id: tenants.id, status: tenants.status, xSigEnc: tenants.billplzXSignatureEnc })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    const tenant = rows[0];
    // فشل قبل-التحقق موحّد: كلها 401 برسالة عامة (لا 404/503 تميّز المستأجر)
    const reject = (reason: string): never => {
      console.warn(JSON.stringify({ action: "billplz_callback", outcome: "rejected", reason, slug }));
      throw new UnauthorizedException();
    };
    if (!tenant || tenant.status === "suspended" || tenant.status === "churned") reject("unknown_or_inactive_tenant");
    const xSigEnc = tenant!.xSigEnc;
    if (!xSigEnc) reject("not_configured");
    const xSignatureKey = decryptSecret(xSigEnc!, Buffer.from(this.env.MASTER_KEY, "hex"));
    // NOTE A (دفاع بالعمق): مفتاح مفكوك فارغ = غير مهيأ (وإلا HMAC بمفتاح فارغ قابل للتزوير)
    if (xSignatureKey.length === 0) reject("empty_key");
    if (!verifyBillplzSignature(params, xSignatureKey)) reject("bad_signature");

    const billId = params["id"];
    const paid = params["paid"] === "true";
    if (!billId || !paid) return "OK"; // نداء غير مدفوع (إنشاء/انتهاء) — لا فعل

    const paidAtRaw = params["paid_at"];
    const paidAt = paidAtRaw ? new Date(paidAtRaw) : undefined;
    const result = await markOrderPaidByRef(this.handle.db, tenant!.id, {
      paymentRef: billId,
      ...(paidAt !== undefined && !Number.isNaN(paidAt.getTime()) ? { paidAt } : {}),
    });
    // §13 — لوغ منظّم بلا PII (معرّفات فقط). money-F3/F1: دفعة لمرجع مجهول أو بعد حالة
    // نهائية = شذوذ مالي يستحق تنبيهاً (error) للطاقم لا مجرد info.
    if (result.outcome === "not_found" || result.outcome === "paid_after_terminal") {
      console.error(
        JSON.stringify({ action: "billplz_payment_anomaly", tenant_id: tenant!.id, bill_id: billId, outcome: result.outcome }),
      );
    } else {
      console.log(JSON.stringify({ action: "billplz_callback", tenant_id: tenant!.id, bill_id: billId, outcome: result.outcome }));
    }
    return "OK"; // كل النتائج 200 — إعادات Billplz لا تُعاد لانقطاعها
  }

  /** إرسال رابط دفع لطلب (موظف): فاتورة واحدة لكل طلب؛ الرسالة عبر outbox بعد الالتزام. */
  async sendLink(authorization: string | undefined, body: unknown): Promise<{ url: string; billId: string; reused: boolean }> {
    assertStaffToken(this.env.STAFF_API_TOKEN, authorization);
    const input = parseOr400(sendLinkBodySchema, body, "payments_send_link");
    const tenant = await resolveActiveTenant(this.handle.db, input.tenantSlug);

    const credRows = await this.handle.db
      .select({
        apiKeyEnc: tenants.billplzApiKeyEnc,
        collectionId: tenants.billplzCollectionId,
        name: tenants.name,
      })
      .from(tenants)
      .where(eq(tenants.id, tenant.id))
      .limit(1);
    const cred = credRows[0];
    if (!cred?.apiKeyEnc || !cred.collectionId) {
      throw new ServiceUnavailableException("payments not configured");
    }

    // الطلب: غير مدفوع، غير نهائي، وبمبلغ تحصيل موجب؛ مرجع قائم → نعيد فاتورته
    const orderRows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({
          id: orders.id,
          publicCode: orders.publicCode,
          status: orders.status,
          codAmount: orders.codAmount,
          paymentStatus: orders.paymentStatus,
          paymentRef: orders.paymentRef,
          customerId: orders.customerId,
        })
        .from(orders)
        .where(and(eq(orders.tenantId, tenant.id), eq(orders.id, input.orderId), isNull(orders.deletedAt)))
        .limit(1),
    );
    const order = orderRows[0];
    if (!order) throw new NotFoundException("order not found");
    if (order.paymentStatus === "paid") throw new BadRequestException("order already paid");
    // مراجعة Phase 3 (HIGH): لا رابط دفع لطلب نهائي (مُسلَّم/مُلغى/فشل/مُرجَع) — يمنع رابطاً
    // حيّاً يُدفع بعد التسليم فيصفّر cod (شحن مزدوج). النهائي المؤكّد بالقاعدة عبر attachPaymentRef.
    if (TERMINAL_STATUSES_API.has(order.status)) throw new BadRequestException("order is finalized");
    if (order.codAmount <= 0n) throw new BadRequestException("nothing to pay");
    if (order.paymentRef !== null) {
      // فاتورة سبق إنشاؤها — أعد رابطها المشتق (Billplz روابط الفواتير ثابتة الشكل)
      return { url: this.billUrl(order.paymentRef), billId: order.paymentRef, reused: true };
    }

    const apiKey = decryptSecret(cred.apiKeyEnc, Buffer.from(this.env.MASTER_KEY, "hex"));
    const billplzConfig = { baseUrl: this.env.BILLPLZ_BASE_URL, apiKey, collectionId: cred.collectionId };
    const bill = await createBill(billplzConfig, {
      name: cred.name,
      amountSen: order.codAmount, // D5: bigint سنتات حتى الحدود
      description: `Order #${order.publicCode}`,
      callbackUrl: `${this.env.PUBLIC_API_URL}/payments/billplz/${input.tenantSlug}/callback`,
      reference1: order.id,
      reference1Label: "Order ID",
    });

    // idem-F3: رسالة الرابط (outbox 'payment.link') تُكتب **بنفس ترانزاكشن** ربط المرجع
    const attached = await attachPaymentRef(this.handle.db, tenant.id, {
      orderId: order.id,
      paymentRef: bill.id,
      linkMessage: { userId: order.customerId, url: bill.url },
    });
    if (attached.outcome === "ref_exists") {
      // سباق إرسالين متزامنين: فاتورتنا خاسرة ويتيمة — money-F3: احذفها من Billplz كي لا
      // تبقى قابلة للدفع، ثم أعد رابط الفاتورة الفائزة.
      await deleteBill(billplzConfig, bill.id);
      console.warn(JSON.stringify({ action: "payments_send_link", outcome: "race_ref_exists", tenant_id: tenant.id, order_id: order.id }));
      return { url: this.billUrl(attached.paymentRef), billId: attached.paymentRef, reused: true };
    }
    if (attached.outcome !== "attached") {
      // paid/terminal/حُذف بين القراءة والربط — نظّف فاتورتنا اليتيمة
      await deleteBill(billplzConfig, bill.id);
      throw new BadRequestException("order state changed");
    }

    console.log(JSON.stringify({ action: "payments_send_link", outcome: "created", tenant_id: tenant.id, order_id: order.id, bill_id: bill.id }));
    return { url: bill.url, billId: bill.id, reused: false };
  }

  /** رابط فاتورة Billplz العام المشتق (روابط الفواتير ثابتة الشكل، بلا مقطع /api/v3). */
  private billUrl(billId: string): string {
    return `${this.env.BILLPLZ_BASE_URL.replace("/api/v3", "")}/bills/${billId}`;
  }
}
