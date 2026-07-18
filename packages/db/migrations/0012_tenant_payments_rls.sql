-- §2.3 / MERGE_PLAN R-02 — إغلاق ثغرة قائمة: tenant_payments كان بلا RLS رغم حمله
-- tenant_id، وتعليقه القديم أحال على سياسة "platform_admin" غير موجودة إطلاقاً —
-- أي مسار كود بسياق مستأجر كان يقدر يقرأ/يكتب مدفوعات مستأجرين آخرين.
-- من اليوم: نفس انضباط كل الجداول (ENABLE + FORCE + tenant_isolation)، والكتابة
-- من كونسول المشرف تمر عبر withTenant(tenantId) كغيرها.
ALTER TABLE "tenant_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_payments"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
