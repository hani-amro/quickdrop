import { createHmac, timingSafeEqual } from "node:crypto";

// §11 / MERGE_PLAN §3.1 — تحقق توقيع Meta على الجسم الخام **قبل** أي parsing:
// X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(rawBody, META_APP_SECRET).
// مقارنة ثابتة الزمن حصراً. أي فشل = رفض صامت (لا تفاصيل للمهاجم).

export function verifyMetaSignature(rawBody: string | Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}
