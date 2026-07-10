import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

// §4.2: تشفير توكنات البوتات AES-256-GCM. المفتاح 32 بايت من env،
// الـ IV عشوائي لكل تشفير ومخزّن بجانب الـ ciphertext.
// التخطيط: iv(12) || authTag(16) || ciphertext — يُخزَّن BYTEA بالقاعدة.

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encryptSecret(plaintext: string, masterKey: Buffer): Buffer {
  if (masterKey.length !== 32) throw new RangeError("MASTER_KEY must be exactly 32 bytes");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(payload: Buffer, masterKey: Buffer): string {
  if (masterKey.length !== 32) throw new RangeError("MASTER_KEY must be exactly 32 bytes");
  if (payload.length < IV_LENGTH + TAG_LENGTH + 1) throw new RangeError("ciphertext payload too short");
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** §4.1: مقارنة أسرار ثابتة الزمن — لا `===` على أسرار أبداً. */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
