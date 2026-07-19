-- دمج WaFlow (MERGE_PLAN §7 خطوة 20) — اعتمادات Billplz لكل مستأجر على جدول tenants
-- (استثناء RLS المسمّى — نفس نمط bot_token_encrypted). الأسرار AES-256-GCM تحت MASTER_KEY
-- (لا نص صريح أبداً — R-21)؛ collection_id ليس سراً.

ALTER TABLE "tenants" ADD COLUMN "billplz_api_key_enc" bytea;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billplz_x_signature_enc" bytea;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billplz_collection_id" text;
