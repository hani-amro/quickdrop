-- §2.2/§2.3 — RLS: يُلصق محتوى هذا الملف في ترحيل drizzle-kit custom لكل جدول أعمال جديد.
-- الأدوار نفسها تُنشأ بـ infra/compose/initdb/01-roles.sql (cluster-level، ليست ترحيلاً).

ALTER TABLE webhook_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_updates FORCE ROW LEVEL SECURITY;

-- current_setting الصارمة (بلا missing_ok): استعلام بلا tenant يفشل بصوت عالٍ، لا صفر صفوف
CREATE POLICY tenant_isolation ON webhook_updates
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- §2.3 المهام العابرة للمستأجرين: app_worker يلتقط قراءةً فقط؛ أي كتابة تمر بـ withTenant
CREATE POLICY worker_scan ON webhook_updates
  FOR SELECT TO app_worker
  USING (true);
