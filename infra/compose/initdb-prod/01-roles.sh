#!/bin/sh
# §2.3 — أدوار قاعدة الإنتاج. كلمات السر تُحقن عبر env (بلا أسرار بالريبو §11)، بعكس
# نسخة dev (infra/compose/initdb/01-roles.sql) ذات كلمات السر الثابتة.
#   migrator  : DDL/ترحيلات فقط — مالك المخطط
#   app_user  : DML فقط، لا BYPASSRLS ولا superuser — كل مسارات التطبيق
#   app_worker: مسح عابر للمستأجرين قراءةً؛ الكتابة عبر withTenant
#   backup    : قراءة كاملة + BYPASSRLS — النسخ الاحتياطي فقط (§12)، ليس مسار تطبيق
#
# يعمل مرة واحدة عند أول تهيئة (مجلد data فارغ) بدور superuser على POSTGRES_DB.
# تمرير كلمات السر عبر psql -v و :'var' يقتبسها بأمان (يتحمّل أي محرف).
set -e

: "${DB_MIGRATOR_PASSWORD:?DB_MIGRATOR_PASSWORD is required}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is required}"
: "${DB_WORKER_PASSWORD:?DB_WORKER_PASSWORD is required}"
: "${DB_BACKUP_PASSWORD:?DB_BACKUP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  -v migrator_pw="$DB_MIGRATOR_PASSWORD" \
  -v app_pw="$DB_APP_PASSWORD" \
  -v worker_pw="$DB_WORKER_PASSWORD" \
  -v backup_pw="$DB_BACKUP_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE migrator   LOGIN PASSWORD :'migrator_pw' NOSUPERUSER;
CREATE ROLE app_user   LOGIN PASSWORD :'app_pw'      NOSUPERUSER NOBYPASSRLS;
CREATE ROLE app_worker LOGIN PASSWORD :'worker_pw'   NOSUPERUSER NOBYPASSRLS;
CREATE ROLE backup     LOGIN PASSWORD :'backup_pw'   NOSUPERUSER;

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
EOSQL
