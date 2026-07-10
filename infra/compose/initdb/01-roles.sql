-- §2.3 — أدوار القاعدة (dev/CI؛ كلمات سر الإنتاج عبر runbook منفصل):
--   migrator  : DDL/ترحيلات فقط — مالك المخطط
--   app_user  : DML فقط، لا BYPASSRLS ولا superuser — كل مسارات التطبيق
--   app_worker: مسح عابر للمستأجرين قراءةً (سياسات مسمّاة)؛ الكتابة عبر withTenant
--   backup    : قراءة كاملة + BYPASSRLS — النسخ الاحتياطي فقط (§12)، ليس مسار تطبيق

CREATE ROLE migrator LOGIN PASSWORD 'migrator_dev_password' NOSUPERUSER;
CREATE ROLE app_user LOGIN PASSWORD 'app_dev_password' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE app_worker LOGIN PASSWORD 'worker_dev_password' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE backup LOGIN PASSWORD 'backup_dev_password' NOSUPERUSER;

GRANT pg_read_all_data TO backup;
ALTER ROLE backup BYPASSRLS;

ALTER DATABASE quickdrop OWNER TO migrator;
ALTER SCHEMA public OWNER TO migrator;
GRANT USAGE ON SCHEMA public TO app_user, app_worker;

-- بدون هذا: أول جدول جديد بالإنتاج = permission denied وقت التشغيل (§2.3)
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, app_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, app_worker;
