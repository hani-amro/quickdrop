import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ImageValidationError, MAX_IMAGE_BYTES, validateAndReencode } from "./image.js";

// §15/§11 — فحوص magic bytes + الحجم + إثبات أن إعادة الترميز تقتل أي payload وتجرّد EXIF.
// «الـfixture الصغير» يُولَّد بـ sharp نفسه (لا حاجة لملف على القرص).

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 3, height: 3, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

async function tinyWebp(): Promise<Buffer> {
  return sharp({ create: { width: 3, height: 3, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .webp()
    .toBuffer();
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

describe("validateAndReencode — فحوص المدخل (§11)", () => {
  it("rejects an empty buffer", async () => {
    await expect(validateAndReencode(Buffer.alloc(0))).rejects.toMatchObject({ reason: "empty" });
  });

  it("rejects a buffer over the 10MB cap before touching sharp", async () => {
    // كل أصفار: يتجاوز السقف فيُرفض على الحجم قبل فحص الصيغة (لا decode مكلف لملف ضخم)
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    await expect(validateAndReencode(oversized)).rejects.toMatchObject({ reason: "too_large" });
  });

  it("rejects by content not extension — GIF magic bytes are refused", async () => {
    const gif = Buffer.from("GIF89a", "ascii");
    await expect(validateAndReencode(gif)).rejects.toMatchObject({ reason: "unsupported_format" });
  });

  it("rejects arbitrary non-image bytes", async () => {
    const junk = Buffer.from("this is not an image at all", "utf8");
    await expect(validateAndReencode(junk)).rejects.toBeInstanceOf(ImageValidationError);
  });

  it("rejects a valid PNG header followed by a corrupt body (decode_failed)", async () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const corrupt = Buffer.concat([pngMagic, Buffer.from("garbage-not-a-real-png-idat")]);
    await expect(validateAndReencode(corrupt)).rejects.toMatchObject({ reason: "decode_failed" });
  });
});

describe("validateAndReencode — إعادة الترميز (§11)", () => {
  it("re-encodes a valid PNG to stripped JPEG", async () => {
    const result = await validateAndReencode(await tinyPng());
    expect(result.contentType).toBe("image/jpeg");
    expect(isJpeg(result.buffer)).toBe(true);
  });

  it("accepts WEBP (detected by RIFF/WEBP magic) and re-encodes to JPEG", async () => {
    const result = await validateAndReencode(await tinyWebp());
    expect(result.contentType).toBe("image/jpeg");
    expect(isJpeg(result.buffer)).toBe(true);
  });

  it("kills a payload appended after the image bytes (بولي‑غلوت)", async () => {
    const poison = Buffer.from("<?php system($_GET[0]); ?>", "utf8");
    const poisoned = Buffer.concat([await tinyPng(), poison]);
    const result = await validateAndReencode(poisoned);
    // البايتات الملحقة اختفت من المخرَج المعاد ترميزه
    expect(result.buffer.includes(poison)).toBe(false);
    expect(isJpeg(result.buffer)).toBe(true);
  });

  it("strips metadata/EXIF from the output (privacy — لا موقع جغرافي بالصورة)", async () => {
    const result = await validateAndReencode(await tinyPng());
    const meta = await sharp(result.buffer).metadata();
    expect(meta.exif).toBeUndefined();
  });
});
