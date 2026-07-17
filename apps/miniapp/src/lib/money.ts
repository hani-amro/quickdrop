// D5 + الفخ 1 — المال سلسلة عشرية من الـ API. الحساب BigInt حصراً (Number يفقد الدقة
// فوق 2^53، والعائم يُدوّر العشري)؛ فواصل الآلاف للعرض فقط عند الحافة.

interface MoneyParts {
  neg: boolean;
  digits: bigint; // كل الأرقام (صحيح + كسر) بلا فاصلة
  scale: number; // عدد المنازل العشرية
}

function parseMoney(value: string): MoneyParts | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (m === null) return null;
  const frac = m[3] ?? "";
  const intPart = m[2] ?? "0";
  return { neg: m[1] === "-", digits: BigInt(intPart + frac), scale: frac.length };
}

function scaledToDecimalString(scaled: bigint, scale: number): string {
  const neg = scaled < 0n;
  const abs = (neg ? -scaled : scaled).toString();
  if (scale === 0) return `${neg ? "-" : ""}${abs}`;
  const padded = abs.padStart(scale + 1, "0");
  const cut = padded.length - scale;
  const intPart = padded.slice(0, cut);
  const frac = padded.slice(cut).replace(/0+$/, ""); // نُسقط الأصفار الزائدة للعرض
  return `${neg ? "-" : ""}${intPart}${frac.length > 0 ? `.${frac}` : ""}`;
}

/** مجموع (سعر × كمية) لكل السطور — سلسلة عشرية قانونية بلا فقدان دقة. */
export function computeCartTotal(lines: ReadonlyArray<{ price: string; qty: number }>): string {
  const parsed: Array<{ parts: MoneyParts; qty: number }> = [];
  for (const line of lines) {
    const parts = parseMoney(line.price);
    if (parts === null || line.qty <= 0) continue; // دفاعي: سعر غير صالح يُتجاهل
    parsed.push({ parts, qty: line.qty });
  }
  const maxScale = parsed.reduce((mx, p) => Math.max(mx, p.parts.scale), 0);
  let sum = 0n;
  for (const { parts, qty } of parsed) {
    const scaleUp = 10n ** BigInt(maxScale - parts.scale);
    const signed = parts.neg ? -parts.digits : parts.digits;
    sum += signed * scaleUp * BigInt(qty);
  }
  return scaledToDecimalString(sum, maxScale);
}

/** عرض المال: فواصل آلاف على الجزء الصحيح، مع الحفاظ على الكسر إن وُجد. */
export function formatMoney(value: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (m === null) return value; // دفاعي: ليس عدداً — أعده كما هو
  const sign = m[1] ?? "";
  const intPart = m[2] ?? "0";
  const frac = m[3];
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}
