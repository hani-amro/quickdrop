import { createHmac, timingSafeEqual } from "node:crypto";

// دمج WaFlow (MERGE_PLAN §7 خطوة 20) — تحقق توقيع Billplz: منقول عن
// packages/utils بـ WaFlow (كان مختبَراً وثابت الزمن — يُنقل كما هو مع الاختبارات).
// Billplz يحسب HMAC-SHA256 على كل بارامترات النداء **عدا x_signature نفسه**،
// مرتّبةً بالمفتاح ومضمومة بصيغة `key1value1|key2value2|...`.

export function verifyBillplzSignature(params: Record<string, string>, xSignatureKey: string): boolean {
  const sorted = Object.keys(params)
    .filter((k) => k !== "x_signature")
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("|");
  const expected = createHmac("sha256", xSignatureKey).update(sorted).digest("hex");
  const provided = params["x_signature"] ?? "";
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    // طول مختلف/hex فاسد — رفض هادئ (لا رمي على مدخل خارجي §11)
    return false;
  }
}

/** توقيع بارامترات (للاختبارات وأدوات المحاكاة) — نفس معادلة التحقق أعلاه. */
export function signBillplzParams(params: Record<string, string>, xSignatureKey: string): string {
  const sorted = Object.keys(params)
    .filter((k) => k !== "x_signature")
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("|");
  return createHmac("sha256", xSignatureKey).update(sorted).digest("hex");
}
