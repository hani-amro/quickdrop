-- دمج WaFlow (MERGE_PLAN §4.3) — معرّفات قنوات الزبون على users: نمط telegram_user_id
-- نفسه (فريد جزئياً لكل مستأجر). **لا قيود فريدة عالمية** — D10: نفس الهاتف/الرقم قد
-- يوجد كصفين تحت مستأجرين (الربط الشبكي لاحقاً بجدول persons إضافي، لا بإعادة مفاتيح).
ALTER TABLE "users" ADD COLUMN "wa_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "instagram_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "facebook_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_wa_uq" ON "users" ("tenant_id", "wa_id") WHERE "wa_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_ig_uq" ON "users" ("tenant_id", "instagram_id") WHERE "instagram_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_fb_uq" ON "users" ("tenant_id", "facebook_id") WHERE "facebook_id" IS NOT NULL;
