#!/usr/bin/env bash
# نسخ احتياطي ليلي لقاعدة quickdrop (§12) — الطبقة الثانية تحت أرشفة WAL المستمرة.
#
# لماذا يوجد رغم WAL: pgBackRest/WAL-G يحققان RPO ≤ 5 دقائق (الأساس)؛ هذا الـ pg_dump
# الليلي طبقة استرجاع مستقلة (لقطة منطقية قابلة للنقل، تنجو من فساد أرشيف WAL).
# الدفتر المالي (ledger_entries) هو السجل الوحيد لذمم السائقين ولا يُعاد من أي مصدر (§8.1).
#
# القرارات:
#   - دور backup فقط: pg_read_all_data + BYPASSRLS (استثناء مسمّى §2.3) — pg_dump بدور
#     عادي تحت FORCE RLS يفشل أصلاً. ليس مسار تطبيق.
#   - صيغة custom (-Fc) مضغوطة → pg_restore انتقائي ومتوازٍ عند الاسترجاع.
#   - رفع لتخزين S3-compatible (R2/B2) بمفتاح مؤرّخ. الاحتفاظ = دورة حياة الـ bucket
#     (30 يوماً + شهرية لسنة §12) — لا نحذف من هنا كي لا يمحو خطأٌ سكربتٌ كل النسخ.
#   - idempotent: مفتاح يحمل ختم UTC للثانية؛ إعادة التشغيل تنشئ كائناً جديداً لا تفسد قديماً.
#   - لوغ JSON منظّم (§13)، وخروج ≠ 0 عند أي فشل (تنبيه "فشل النسخ الاحتياطي" §13).
#
# متغيّرات البيئة (تُحقن وقت التشغيل، أذونات ملف 600 §11):
#   BACKUP_DATABASE_URL   إلزامي — وصلة دور backup، مثال:
#                         postgres://backup:PASS@127.0.0.1:5432/quickdrop
#   RCLONE_REMOTE         وجهة rclone، مثال: r2:quickdrop-backups  (المسار المفضّل)
#   S3_BUCKET             بديل عن rclone: دلو aws s3، مثال: s3://quickdrop-backups
#   BACKUP_TMPDIR         مجلد عمل محلي (افتراضي /var/backups/quickdrop)
#   BACKUP_PREFIX         بادئة المفتاح داخل الوجهة (افتراضي quickdrop)
set -euo pipefail

TMPDIR="${BACKUP_TMPDIR:-/var/backups/quickdrop}"
PREFIX="${BACKUP_PREFIX:-quickdrop}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DATE_PATH="$(date -u +%Y/%m/%d)"
FILENAME="quickdrop-${TS}.dump"
LOCAL_PATH="${TMPDIR}/${FILENAME}"
REMOTE_KEY="${PREFIX}/${DATE_PATH}/${FILENAME}"

# لوغ JSON منظّم — حقول ثابتة (§13): ts, level, event, msg.
# رسائل msg نصوص محكومة (أسماء/أرقام/مفاتيح) بلا محارف تحتاج هروب (" \ سطر جديد) — لا اعتماد
# على sed/jq (غير مضمونين على سيرفر أدنى، وهروب sed هشّ عبر البيئات). أبقِ الرسائل بسيطة.
log() { # log <level> <event> <msg>
  printf '{"ts":"%s","level":"%s","component":"backup","event":"%s","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3"
}

fail() { log "error" "$1" "$2"; exit 1; }

# ينظّف اللقطة المحلية دائماً — لا نترك أسراراً/بيانات مبعثرة على القرص (§11).
cleanup() { rm -f "${LOCAL_PATH}" 2>/dev/null || true; }
trap cleanup EXIT

[ -n "${BACKUP_DATABASE_URL:-}" ] || fail "config_missing" "BACKUP_DATABASE_URL is required"
command -v pg_dump >/dev/null 2>&1 || fail "dep_missing" "pg_dump not found on PATH"

mkdir -p "${TMPDIR}"

# ── 1) اللقطة المنطقية (صيغة custom مضغوطة) ─────────────────────────────
log "info" "dump_start" "pg_dump ${FILENAME}"
if ! pg_dump --dbname="${BACKUP_DATABASE_URL}" \
      --format=custom --compress=9 --no-owner --no-privileges \
      --file="${LOCAL_PATH}"; then
  fail "dump_failed" "pg_dump exited nonzero"
fi

# تحقق من أن الملف غير فارغ + بصمة سلامة أساسية عبر رأس pg_dump (يبدأ بـ PGDMP).
[ -s "${LOCAL_PATH}" ] || fail "dump_empty" "dump file is empty"
if ! head -c 5 "${LOCAL_PATH}" | grep -q "PGDMP"; then
  fail "dump_corrupt" "dump header is not a valid pg_dump custom archive"
fi
SIZE_BYTES="$(wc -c < "${LOCAL_PATH}" | tr -d ' ')"
log "info" "dump_ok" "size_bytes=${SIZE_BYTES}"

# ── 2) الرفع إلى تخزين خارج الموقع (R2/B2) ──────────────────────────────
if [ -n "${RCLONE_REMOTE:-}" ]; then
  command -v rclone >/dev/null 2>&1 || fail "dep_missing" "rclone not found on PATH"
  log "info" "upload_start" "rclone -> ${RCLONE_REMOTE}/${REMOTE_KEY}"
  rclone copyto "${LOCAL_PATH}" "${RCLONE_REMOTE}/${REMOTE_KEY}" \
    --s3-no-check-bucket --checksum \
    || fail "upload_failed" "rclone copyto failed"
  # تحقق فعلي من وجود الكائن بعد الرفع (نسخة لم تُرفع = لا نسخة).
  rclone lsf "${RCLONE_REMOTE}/${REMOTE_KEY}" >/dev/null 2>&1 \
    || fail "verify_failed" "uploaded object not found on remote"
elif [ -n "${S3_BUCKET:-}" ]; then
  command -v aws >/dev/null 2>&1 || fail "dep_missing" "aws cli not found on PATH"
  DEST="${S3_BUCKET%/}/${REMOTE_KEY}"
  log "info" "upload_start" "aws s3 cp -> ${DEST}"
  aws s3 cp "${LOCAL_PATH}" "${DEST}" --only-show-errors \
    || fail "upload_failed" "aws s3 cp failed"
  aws s3 ls "${DEST}" >/dev/null 2>&1 \
    || fail "verify_failed" "uploaded object not found on bucket"
else
  fail "config_missing" "set RCLONE_REMOTE or S3_BUCKET for offsite upload"
fi

log "info" "backup_ok" "uploaded ${REMOTE_KEY} (${SIZE_BYTES} bytes)"
# الاحتفاظ: دورة حياة الـ bucket (30 يوماً يومي + شهرية لسنة §12). لا حذف من هنا عمداً.
exit 0
