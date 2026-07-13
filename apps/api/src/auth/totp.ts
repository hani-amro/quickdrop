import { createHmac, randomBytes } from "node:crypto";
import { secretsEqual } from "@quickdrop/shared";

// §10.2 — TOTP (RFC 6238) للطاقم: إلزامي لدور owner وaccountant. تنفيذ نقيّ فوق
// node:crypto (HMAC-SHA1) بلا اعتماد خارجي — يتفادى احتكاك CJS/ESM، ويجعل التحقق
// قابلاً للاختبار حتمياً بمتجه زمن محقون (atTime). المعايير القياسية: 6 خانات، نافذة
// 30 ثانية، خوارزمية SHA1 (توافق تطبيقات المصادقة: Google Authenticator/Authy).
// السرّ يُخزَّن base32 كما هو (dev)؛ تشفيره بـ MASTER_KEY (§4.2) تحسين لاحق.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648
const DEFAULT_PERIOD_S = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1; // ±خطوة واحدة = تسامح انحراف الساعة ±30 ثانية

/** بايتات → base32 بلا حشو (=): مُجمّع بتات 5-إلى-8 كي لا نفهرس Buffer مباشرة (noUncheckedIndexedAccess). */
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return output;
}

/** base32 → بايتات: يتجاهل الحشو والفراغات وحالة الأحرف؛ حرف خارج الأبجدية = رمي (يلتقطه verifyTotp). */
function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/u, "").replace(/\s+/gu, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226): عدّاد 64-bit big-endian → HMAC-SHA1 → اقتطاع ديناميكي → n خانات. */
function hotp(secretBytes: Buffer, counter: number, digits: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secretBytes).update(counterBuf).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f; // آخر نصف-بايت = الإزاحة
  // 4 بايتات من الإزاحة (offset ≤ 15، والـ mac 20 بايتاً → offset+3 ≤ 18 آمن) وقنّع بت الإشارة
  const binCode = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binCode % 10 ** digits).toString().padStart(digits, "0");
}

/** §10.2 — سرّ TOTP جديد: 160-bit (توصية RFC 4226 لـ HMAC-SHA1) بترميز base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * §10.2 — otpauth:// URI لتطبيقات المصادقة (يُعرض كـ QR بالداشبورد). الشكل القياسي
 * otpauth://totp/{issuer}:{label}?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30.
 */
export function otpauthUrl(secret: string, label: string, issuer: string): string {
  const enc = encodeURIComponent;
  return (
    `otpauth://totp/${enc(issuer)}:${enc(label)}` +
    `?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=${DEFAULT_DIGITS}&period=${DEFAULT_PERIOD_S}`
  );
}

export interface TotpTimeOptions {
  /** لحظة الحساب بـ Unix ms — تُحقن بالاختبار لمتجه زمن ثابت؛ افتراضياً Date.now(). */
  atTime?: number;
  period?: number;
  digits?: number;
}

/**
 * §10.2 — يحسب رمز TOTP الحالي لسرّ معطى (نظير verifyTotp). سرّ base32 مشوّه = رمي
 * (المستدعي يضمن الصحة). مفيد للاختبار الحتمي ولعرض/تحقق TOTP المشرف لاحقاً.
 */
export function totpToken(secret: string, options: TotpTimeOptions = {}): string {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const period = options.period ?? DEFAULT_PERIOD_S;
  const nowMs = options.atTime ?? Date.now();
  const counter = Math.floor(nowMs / 1000 / period);
  return hotp(base32Decode(secret), counter, digits);
}

export interface VerifyTotpOptions extends TotpTimeOptions {
  window?: number;
}

/**
 * §10.2 — تحقق TOTP نقيّ: يقبل الرمز ضمن نافذة ±window خطوات (انحراف الساعة). المقارنة
 * ثابتة الزمن (§4.1، secretsEqual). سرّ مشوّه أو رمز غير رقمي = رفض (false، لا رمي).
 */
export function verifyTotp(secret: string, token: string, options: VerifyTotpOptions = {}): boolean {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const period = options.period ?? DEFAULT_PERIOD_S;
  const window = options.window ?? DEFAULT_WINDOW;
  const nowMs = options.atTime ?? Date.now();

  const normalized = token.trim();
  if (!new RegExp(`^\\d{${digits}}$`, "u").test(normalized)) return false;

  let secretBytes: Buffer;
  try {
    secretBytes = base32Decode(secret);
  } catch {
    return false;
  }
  if (secretBytes.length === 0) return false;

  const counter = Math.floor(nowMs / 1000 / period);
  for (let w = -window; w <= window; w++) {
    const c = counter + w;
    if (c < 0) continue; // لا عدّاد سالب قبل الحقبة (writeBigUInt64BE يرمي على السالب)
    if (secretsEqual(hotp(secretBytes, c, digits), normalized)) return true;
  }
  return false;
}
