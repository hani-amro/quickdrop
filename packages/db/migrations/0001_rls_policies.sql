-- §2.2/§2.3 — RLS مفعّل ومُجبَر على كل جدول أعمال، بنفس ترحيل إنشائه.
-- الأدوار تُنشأ بـ infra/compose/initdb/01-roles.sql (cluster-level).

ALTER TABLE "webhook_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_updates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- current_setting الصارمة (بلا missing_ok): استعلام بلا tenant يفشل بصوت عالٍ، لا صفر صفوف
CREATE POLICY "tenant_isolation" ON "webhook_updates"
  USING ("tenant_id" = current_setting('app.tenant_id')::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint

-- §2.3 المهام العابرة للمستأجرين: app_worker يلتقط قراءةً فقط؛ أي كتابة تمر بـ withTenant
CREATE POLICY "worker_scan" ON "webhook_updates"
  FOR SELECT TO "app_worker"
  USING (true);
