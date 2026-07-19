import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createBill, verifyBillplzSignature } from "@quickdrop/billplz";
import { attachPaymentRef, markOrderPaidByRef, orders, tenants, withTenant, writeOutbox, type DbHandle } from "@quickdrop/db";
import { decryptSecret } from "@quickdrop/shared";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { assertStaffToken, parseOr400, resolveActiveTenant, slugSchema, uuidSchema } from "../common/staff-http.js";
import type { ApiEnv } from "../env.js";
import { DB, ENV } from "../tokens.js";

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

  /** بوابة Billplz — التوقيع مصادقة؛ لا جلسة ولا Bearer. */
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
    if (!tenant || tenant.status === "suspended" || tenant.status === "churned") {
      throw new NotFoundException("not found"); // §11 رسالة عامة
    }
    if (!tenant.xSigEnc) {
      // §16.12 — مستأجر بلا اعتماد تحقق: البوابة غير مهيأة له، لا نقبل أي نداء
      throw new ServiceUnavailableException("payments not configured");
    }
    const xSignatureKey = decryptSecret(tenant.xSigEnc, Buffer.from(this.env.MASTER_KEY, "hex"));
    if (!verifyBillplzSignature(params, xSignatureKey)) {
      throw new UnauthorizedException(); // توقيع فاسد — 401 عامة (§11)
    }

    const billId = params["id"];
    const paid = params["paid"] === "true";
    if (!billId || !paid) return "OK"; // نداء غير مدفوع (إنشاء/انتهاء) — لا فعل

    const paidAtRaw = params["paid_at"];
    const paidAt = paidAtRaw ? new Date(paidAtRaw) : undefined;
    const result = await markOrderPaidByRef(this.handle.db, tenant.id, {
      paymentRef: billId,
      ...(paidAt !== undefined && !Number.isNaN(paidAt.getTime()) ? { paidAt } : {}),
    });
    // §13 — لوغ منظّم بلا PII (معرّفات فقط)
    console.log(
      JSON.stringify({ action: "billplz_callback", tenant_id: tenant.id, bill_id: billId, outcome: result.outcome }),
    );
    return "OK"; // paid/already_paid/not_found كلها 200 — إعادات Billplz لا تُعاد لانقطاعها
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

    // الطلب: غير مدفوع وبمبلغ تحصيل موجب؛ مرجع قائم → نعيد فاتورته (لا فاتورة ثانية)
    const orderRows = await withTenant(this.handle.db, tenant.id, (tx) =>
      tx
        .select({
          id: orders.id,
          publicCode: orders.publicCode,
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
    if (order.codAmount <= 0n) throw new BadRequestException("nothing to pay");
    if (order.paymentRef !== null) {
      // فاتورة سبق إنشاؤها — أعد رابطها المشتق (Billplz روابط الفواتير ثابتة الشكل)
      return { url: `${this.env.BILLPLZ_BASE_URL}/bills/${order.paymentRef}`.replace("/api/v3", ""), billId: order.paymentRef, reused: true };
    }

    const apiKey = decryptSecret(cred.apiKeyEnc, Buffer.from(this.env.MASTER_KEY, "hex"));
    const bill = await createBill(
      { baseUrl: this.env.BILLPLZ_BASE_URL, apiKey, collectionId: cred.collectionId },
      {
        name: cred.name,
        amountSen: order.codAmount, // D5: bigint سنتات حتى الحدود
        description: `Order #${order.publicCode}`,
        callbackUrl: `${this.env.PUBLIC_API_URL}/payments/billplz/${input.tenantSlug}/callback`,
        reference1: order.id,
        reference1Label: "Order ID",
      },
    );

    const attached = await attachPaymentRef(this.handle.db, tenant.id, { orderId: order.id, paymentRef: bill.id });
    if (attached.outcome === "ref_exists") {
      // سباق إرسالين متزامنين: فاتورتنا يتيمة (لن تُدفع — مرجعها غير مربوط)؛ نعيد الفائزة
      console.warn(JSON.stringify({ action: "payments_send_link", outcome: "race_ref_exists", tenant_id: tenant.id, order_id: order.id }));
      return { url: `${this.env.BILLPLZ_BASE_URL}/bills/${attached.paymentRef}`.replace("/api/v3", ""), billId: attached.paymentRef, reused: true };
    }
    if (attached.outcome !== "attached") {
      throw new BadRequestException("order state changed"); // paid/حُذف بين القراءة والربط
    }

    // D6 — رسالة الرابط للزبون عبر outbox (بعد الالتزام يرسلها المستهلك بقناة الزبون)
    await withTenant(this.handle.db, tenant.id, (tx) =>
      writeOutbox(tx, tenant.id, "payment.link", { orderId: order.id, userId: order.customerId, url: bill.url }),
    );

    console.log(JSON.stringify({ action: "payments_send_link", outcome: "created", tenant_id: tenant.id, order_id: order.id, bill_id: bill.id }));
    return { url: bill.url, billId: bill.id, reused: false };
  }
}
