// §11 — إعداد عميل التخزين من env. يدعم MinIO (تطوير) وR2/S3 (إنتاج) بنفس واجهة S3.
// السرّان (المفتاح والسر) يصلان وقت التشغيل من env حصراً — ممنوع خبزهما بالصور (§11).

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** MinIO يتطلب path-style (bucket بالمسار لا بالنطاق الفرعي). */
  forcePathStyle: boolean;
}

/** شكل env المطلوب — كل الحقول اختيارية كي نميّز «غير مُهيّأ» عن «مُهيّأ ناقص». */
export interface StorageEnv {
  S3_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
  S3_BUCKET?: string | undefined;
  S3_ACCESS_KEY?: string | undefined;
  S3_SECRET_KEY?: string | undefined;
  S3_FORCE_PATH_STYLE?: string | undefined;
}

const REQUIRED_KEYS = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;

/**
 * يبني الإعداد إن كانت كل المتغيرات المطلوبة حاضرة، وإلا null — للمستهلك الذي يتدهور
 * بلطف عند غياب التخزين (مثلاً الـ API يرجّع مرفقات بلا روابط موقّعة).
 */
export function tryLoadStorageConfig(env: StorageEnv): StorageConfig | null {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_FORCE_PATH_STYLE } = env;
  if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    return null;
  }
  return {
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    bucket: S3_BUCKET,
    accessKey: S3_ACCESS_KEY,
    secretKey: S3_SECRET_KEY,
    // الافتراض true (MinIO/R2 المحلي)؛ عطّله صراحةً بـ "false" لمزوّد يدعم virtual-host style
    forcePathStyle: S3_FORCE_PATH_STYLE === undefined ? true : S3_FORCE_PATH_STYLE !== "false",
  };
}

/** نسخة صاخبة الفشل — للمستهلك الذي يعتبر التخزين إلزامياً (عامل الـ worker: POD لا بدّ يُخزَّن). */
export function loadStorageConfig(env: StorageEnv): StorageConfig {
  const config = tryLoadStorageConfig(env);
  if (config === null) {
    throw new Error(`storage config incomplete: set ${REQUIRED_KEYS.join(", ")}`);
  }
  return config;
}

export const STORAGE_REQUIRED_KEYS = REQUIRED_KEYS;
