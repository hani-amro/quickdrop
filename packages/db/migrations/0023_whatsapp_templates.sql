-- Task A (D1) — نافذة واتساب 24 ساعة + قوالب HSM. جدولان مُقيَّدان بالمستأجر (ENABLE+FORCE RLS):
--  whatsapp_templates — ربط مفتاح إشعار داخلي → قالب Meta معتمد (لا نص قالب هنا؛ يُسجَّل عند Meta).
--  wa_deliveries     — سجلّ تسليم لكل صفّ outbox: مفتاح exactly-once (unique tenant+outbox) + نتيجة
--                      مرئية (sent/degraded) بدل الإسقاط الصامت. لا FK إلى outbox عمداً (صفوف outbox
--                      تُنظَّف بالـhousekeeping؛ هذا السجلّ أثر تدقيق يعيش أطول). additive بالكامل — لا مسّ
--                      للمال/العزل/الـseam.

CREATE TABLE "whatsapp_templates" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "internal_key" text NOT NULL,
  "meta_template_name" text NOT NULL,
  "language" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "variable_map" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "whatsapp_templates_internal_key_ck" CHECK ("internal_key" IN ('order_confirmed','order_dispatched','driver_arriving','order_delivered','payment_receipt')),
  CONSTRAINT "whatsapp_templates_status_ck" CHECK ("status" IN ('approved','pending','rejected'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_templates_tenant_id_id_uq" ON "whatsapp_templates" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_templates_tenant_key_uq" ON "whatsapp_templates" ("tenant_id", "internal_key");--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "whatsapp_templates"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint

CREATE TABLE "wa_deliveries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "outbox_id" text NOT NULL,
  "internal_key" text,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "meta_message_id" text,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "wa_deliveries_mode_ck" CHECK ("mode" IN ('free_form','template','degraded')),
  CONSTRAINT "wa_deliveries_status_ck" CHECK ("status" IN ('claimed','sent','degraded'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "wa_deliveries_tenant_id_id_uq" ON "wa_deliveries" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_deliveries_tenant_outbox_uq" ON "wa_deliveries" ("tenant_id", "outbox_id");--> statement-breakpoint
ALTER TABLE "wa_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wa_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "wa_deliveries"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
