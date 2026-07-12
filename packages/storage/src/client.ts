import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageConfig } from "./config.js";

// §11 — عميل التخزين (S3-متوافق: MinIO/R2/S3). واجهة ضيّقة عمداً: فقط ما يحتاجه
// إثبات التسليم بالصور — رفع كائن، ورابط GET موقّع قصير العمر.

export interface StorageClient {
  /** يرفع كائناً (Buffer معاد ترميزه سلفاً) بنوع محتوى صريح. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  /** §11 — رابط GET موقّع قصير العمر (ttlS ثوانٍ): الوصول للكائن بلا فتح البكت للعامة. */
  getSignedGetUrl(key: string, ttlS: number): Promise<string>;
}

export function createStorageClient(config: StorageConfig): StorageClient {
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: config.forcePathStyle,
  });

  return {
    async putObject(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async getSignedGetUrl(key, ttlS) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: ttlS });
    },
  };
}
