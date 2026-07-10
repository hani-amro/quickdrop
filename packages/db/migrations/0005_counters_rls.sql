-- counters: جدول أعمال — RLS مُجبَر كالبقية (§2.3)
ALTER TABLE "counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "counters"
  USING ("tenant_id" = current_setting('app.tenant_id')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);
