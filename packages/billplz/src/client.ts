import { z } from "zod";

// دمج WaFlow — عميل Billplz v3 (fetch خام بنمط packages/whatsapp، لا axios).
// D5: المبلغ **bigint سنتات** حتى الحدود — يُسلسَل نصاً بجسم form-encoded (لا Number()
// على مال ولا JSON bigint). fetch قابل للحقن (§15: الاختبارات بلا شبكة).

export interface BillplzConfig {
  /** https://www.billplz.com/api/v3 (الإنتاج) أو billplz-sandbox (الاختبار). */
  baseUrl: string;
  apiKey: string;
  collectionId: string;
  fetchImpl?: typeof fetch;
}

export interface CreateBillInput {
  name: string;
  email?: string;
  mobile?: string;
  /** D5 — بالسنتات (أصغر وحدة MYR). */
  amountSen: bigint;
  description: string;
  callbackUrl: string;
  redirectUrl?: string;
  reference1?: string;
  reference1Label?: string;
}

const billResponseSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  paid: z.boolean().optional(),
});
export interface BillplzBillRef {
  id: string;
  url: string;
}

export class BillplzApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`billplz API error ${status}: ${detail}`);
    this.name = "BillplzApiError";
  }
}

/**
 * إنشاء فاتورة. أخطاء الحالة ترمي BillplzApiError (المستدعي يقرر: رسالة موظف/retry).
 * §11: الاستجابة تُتحقق بـ Zod — id/url فقط ما نبنيه عليه.
 */
export async function createBill(config: BillplzConfig, input: CreateBillInput): Promise<BillplzBillRef> {
  if (input.amountSen <= 0n) {
    throw new RangeError("createBill: amountSen must be positive (D5 bigint sen)");
  }
  const f = config.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    collection_id: config.collectionId,
    name: input.name,
    amount: input.amountSen.toString(), // D5: نص من bigint — لا float بالمسار
    description: input.description,
    callback_url: input.callbackUrl,
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
    ...(input.redirectUrl !== undefined ? { redirect_url: input.redirectUrl } : {}),
    ...(input.reference1 !== undefined ? { reference_1: input.reference1 } : {}),
    ...(input.reference1Label !== undefined ? { reference_1_label: input.reference1Label } : {}),
  });
  const res = await f(`${config.baseUrl}/bills`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BillplzApiError(res.status, text.slice(0, 200));
  }
  const json: unknown = await res.json();
  const parsed = billResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new BillplzApiError(res.status, `unexpected response shape: ${parsed.error.message.slice(0, 150)}`);
  }
  return { id: parsed.data.id, url: parsed.data.url };
}

/**
 * حذف فاتورة غير مدفوعة (Billplz DELETE /bills/:id). يُستخدم لتنظيف الفاتورة الخاسرة في
 * سباق send-link (مراجعة Phase 3، money-F3): فاتورة يتيمة غير محذوفة تبقى قابلة للدفع.
 * أخطاء الحذف تُبتلع (best-effort): الفاتورة اليتيمة إزعاج لا فساد، والاسترداد يدوي إن دُفعت.
 */
export async function deleteBill(config: BillplzConfig, billId: string): Promise<void> {
  const f = config.fetchImpl ?? fetch;
  await f(`${config.baseUrl}/bills/${billId}`, {
    method: "DELETE",
    headers: { Authorization: `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}` },
  }).catch(() => undefined);
}
