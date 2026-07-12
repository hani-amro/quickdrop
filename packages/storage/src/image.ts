import sharp from "sharp";

// §11 — خط معالجة صورة إثبات التسليم: نستقبل بايتات لا نثق بها من تيليغرام، نتحقق منها
// بالمحتوى (magic bytes) لا بالامتداد، نفرض سقف 10MB، ثم نعيد الترميز عبر sharp إلى JPEG
// **مجرّداً من كل الميتاداتا/EXIF** — هذا يقتل أي payload مدسوس (بولي‑غلوت، سكربت ملحق،
// EXIF ملغّم) ويحمي الخصوصية (إزالة الموقع الجغرافي من الصورة).

/** §11 — سقف الرفع: 10MB على البايتات الخام قبل إعادة الترميز. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageRejectReason = "empty" | "too_large" | "unsupported_format" | "decode_failed";

/** خطأ أعمال «مدخل غير صالح» — لا باغ داخلي: المستدعي يترجمه لرسالة للسائق (§16.12). */
export class ImageValidationError extends Error {
  constructor(readonly reason: ImageRejectReason) {
    super(`image validation failed: ${reason}`);
    this.name = "ImageValidationError";
  }
}

export interface ReencodedImage {
  buffer: Buffer;
  contentType: string;
}

type DetectedFormat = "jpeg" | "png" | "webp";

/**
 * §11 — الكشف بالمحتوى لا بالامتداد: تيليغرام (أو مهاجم) قد يسمّي ملفاً .jpg وهو شيء آخر.
 * نقبل ثلاث صيغ نقطية فقط (jpeg/png/webp)؛ ما عداها يُرفض قبل تمريره لـ sharp.
 */
function detectFormat(buf: Buffer): DetectedFormat | null {
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpeg";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }
  // WEBP: "RIFF" .... "WEBP" (بايتات 0-3 و8-11)
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

/**
 * §11 — يتحقق ويعيد الترميز. يرمي ImageValidationError لكل مدخل غير صالح (حجم/صيغة/فساد)،
 * وينجح بإرجاع JPEG نظيف بلا ميتاداتا. `.rotate()` بلا وسائط يطبّق اتجاه EXIF على البكسل
 * **قبل** تجريد الميتاداتا كي تبقى الصورة معتدلة؛ وsharp افتراضاً لا يحمل الميتاداتا للمخرَج
 * (بلا withMetadata) — فيُجرَّد EXIF/GPS تلقائياً.
 */
export async function validateAndReencode(buffer: Buffer): Promise<ReencodedImage> {
  if (buffer.length === 0) {
    throw new ImageValidationError("empty");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageValidationError("too_large");
  }
  if (detectFormat(buffer) === null) {
    throw new ImageValidationError("unsupported_format");
  }

  try {
    const out = await sharp(buffer, { failOn: "error" })
      .rotate() // يبقّي الصورة معتدلة قبل تجريد EXIF
      .jpeg({ quality: 82 })
      .toBuffer();
    return { buffer: out, contentType: "image/jpeg" };
  } catch {
    // magic bytes سليمة لكن الجسم فاسد/مبتور — مدخل غير صالح، لا باغ داخلي
    throw new ImageValidationError("decode_failed");
  }
}
