-- §11 / MERGE_PLAN R-07/رقم 27 بجدول التعارضات — تشفير الأسرار الساكنة المتبقية:
-- staff.totp_secret وadmin_users.totp_secret وtenants.bot_webhook_secret كانت نصاً
-- صريحاً (كان مؤجلاً "تحسيناً لاحقاً"). أعمدة bytea جديدة بنفس مغلّف bot_token_encrypted
-- (AES-256-GCM بـ MASTER_KEY، iv|tag|ct). الأعمدة النصية القديمة انتقالية (dual-read)
-- حتى تشغيل سكربت الـ backfill (scripts/encrypt-secrets-at-rest.ts) ثم تُسقَط بترحيل لاحق.
ALTER TABLE "staff" ADD COLUMN "totp_secret_enc" bytea;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "totp_secret_enc" bytea;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "bot_webhook_secret_enc" bytea;
