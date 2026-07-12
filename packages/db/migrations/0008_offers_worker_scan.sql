-- §2.3/§6.2 — عامل الإسناد يعيد بناء مُهل العروض الفائتة عند الإقلاع (rescanPendingOffers)
-- بقراءة offers عابرة المستأجرين بدور app_worker؛ يحتاج سياسة قراءة مسمّاة كـ orders/outbox.
-- (كُشف بأول تشغيل حي: RLS الصارم على offers كان يرمي unrecognized app.tenant_id للـ worker.)
CREATE POLICY "worker_scan" ON "offers" FOR SELECT TO "app_worker" USING (true);
