CREATE TABLE "merchant_operators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "merchant_prep_minutes" integer;--> statement-breakpoint
ALTER TABLE "merchant_operators" ADD CONSTRAINT "merchant_operators_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- merchants مفعّل عليه FORCE RLS منذ 0002؛ التحقق التلقائي من صفوف هذا الـ FK يقرأ
-- merchants فتُقيَّم سياسة tenant_isolation التي تقرأ app.tenant_id غير المضبوط تحت دور
-- الترحيل → خطأ. الجدول الجديد فارغ فلا صفوف تُتحقق: NOT VALID يتخطّى المسح المبدئي،
-- والإدراج اللاحق يبقى مُنفَّذاً (يمرّ عبر app_user مع app.tenant_id مضبوط بـ withTenant).
ALTER TABLE "merchant_operators" ADD CONSTRAINT "merchant_operators_merchant_fk" FOREIGN KEY ("tenant_id","merchant_id") REFERENCES "public"."merchants"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_operators_tenant_tg_uq" ON "merchant_operators" USING btree ("tenant_id","telegram_user_id");--> statement-breakpoint
CREATE INDEX "merchant_operators_tenant_merchant_idx" ON "merchant_operators" USING btree ("tenant_id","merchant_id");--> statement-breakpoint

-- §2.2/§2.3 — RLS مفعّل ومُجبَر بنفس ترحيل الإنشاء (كباقي جداول الأعمال).
ALTER TABLE "merchant_operators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merchant_operators" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "merchant_operators"
  USING ("tenant_id" = current_setting('app.tenant_id')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);