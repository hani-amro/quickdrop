#!/usr/bin/env bash
# اختبار استرجاع فعلي شهري (§12: «نسخة لم تُسترجع = لا نسخة»).
#
# يسحب أحدث لقطة من التخزين الخارجي، يستعيدها في قاعدة عابرة (throwaway)، ينفّذ
# استعلامات سلامة، يقيس RTO، ثم يُسقط القاعدة. خروج ≠ 0 عند أي فشل → تنبيه (§13).
# يُشغَّل شهرياً بحاوية/سيرفر نظيف؛ لا يمسّ قاعدة الإنتاج (قاعدة معزولة باسم عشوائي).
#
# متغيّرات البيئة:
#   RESTORE_ADMIN_URL   إلزامي — وصلة إدارية لقاعدة الصيانة (postgres) تملك CREATEDB/DROP،
#                       مثال: postgres://migrator:PASS@127.0.0.1:5432/postgres
#   RCLONE_REMOTE       مصدر rclone للقطات (نفس backup.sh)، مثال: r2:quickdrop-backups
#   S3_BUCKET           بديل: دلو aws s3، مثال: s3://quickdrop-backups
#   BACKUP_PREFIX       بادئة المفتاح (افتراضي quickdrop)
#   RESTORE_LOCAL_FILE  اختياري — استعمل ملف .dump محلياً بدل السحب من الخارج
#   BACKUP_TMPDIR       مجلد عمل محلي (افتراضي /var/backups/quickdrop)
set -euo pipefail

TMPDIR="${BACKUP_TMPDIR:-/var/backups/quickdrop}"
PREFIX="${BACKUP_PREFIX:-quickdrop}"
SCRATCH_DB="quickdrop_restore_test_$(date -u +%Y%m%d%H%M%S)_$$"
LOCAL_DUMP=""
DOWNLOADED=0

# لوغ JSON منظّم (§13). رسائل msg نصوص محكومة بلا محارف تحتاج هروب — لا اعتماد على sed/jq.
log() { # log <level> <event> <msg>
  printf '{"ts":"%s","level":"%s","component":"restore-test","event":"%s","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3"
}
fail() { log "error" "$1" "$2"; exit 1; }

# يُسقط القاعدة العابرة وينظّف اللقطة المسحوبة مهما كان سبب الخروج.
cleanup() {
  if command -v psql >/dev/null 2>&1 && [ -n "${RESTORE_ADMIN_URL:-}" ]; then
    psql -d "${RESTORE_ADMIN_URL}" -v ON_ERROR_STOP=0 -q \
      -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE);" >/dev/null 2>&1 || true
  fi
  [ "${DOWNLOADED}" = "1" ] && rm -f "${LOCAL_DUMP}" 2>/dev/null || true
}
trap cleanup EXIT

[ -n "${RESTORE_ADMIN_URL:-}" ] || fail "config_missing" "RESTORE_ADMIN_URL is required"
command -v pg_restore >/dev/null 2>&1 || fail "dep_missing" "pg_restore not found on PATH"
command -v psql >/dev/null 2>&1 || fail "dep_missing" "psql not found on PATH"
mkdir -p "${TMPDIR}"

# ── 1) الحصول على أحدث لقطة ──────────────────────────────────────────────
if [ -n "${RESTORE_LOCAL_FILE:-}" ]; then
  LOCAL_DUMP="${RESTORE_LOCAL_FILE}"
  [ -s "${LOCAL_DUMP}" ] || fail "input_missing" "RESTORE_LOCAL_FILE not found or empty"
elif [ -n "${RCLONE_REMOTE:-}" ]; then
  command -v rclone >/dev/null 2>&1 || fail "dep_missing" "rclone not found on PATH"
  # أحدث كائن حسب زمن التعديل (مفاتيحنا مؤرّخة تصاعدياً أيضاً).
  LATEST="$(rclone lsf "${RCLONE_REMOTE}/${PREFIX}" --recursive --files-only \
            --format tp | sort | tail -n 1 | cut -d';' -f2)"
  [ -n "${LATEST}" ] || fail "no_backup" "no dump found under ${RCLONE_REMOTE}/${PREFIX}"
  LOCAL_DUMP="${TMPDIR}/restore-test-$(basename "${LATEST}")"
  DOWNLOADED=1
  log "info" "download_start" "rclone ${RCLONE_REMOTE}/${PREFIX}/${LATEST}"
  rclone copyto "${RCLONE_REMOTE}/${PREFIX}/${LATEST}" "${LOCAL_DUMP}" \
    || fail "download_failed" "rclone copyto failed"
elif [ -n "${S3_BUCKET:-}" ]; then
  command -v aws >/dev/null 2>&1 || fail "dep_missing" "aws cli not found on PATH"
  BASE="${S3_BUCKET%/}/${PREFIX}"
  LATEST="$(aws s3 ls "${BASE}/" --recursive | sort | tail -n 1 | awk '{print $4}')"
  [ -n "${LATEST}" ] || fail "no_backup" "no dump found under ${BASE}"
  LOCAL_DUMP="${TMPDIR}/restore-test-$(basename "${LATEST}")"
  DOWNLOADED=1
  # LATEST مفتاح كامل من جذر الدلو — أعد بناء عنوان s3 من الدلو نفسه.
  BUCKET_ROOT="$(printf '%s' "${S3_BUCKET}" | sed -E 's#(s3://[^/]+).*#\1#')"
  log "info" "download_start" "aws s3 cp ${BUCKET_ROOT}/${LATEST}"
  aws s3 cp "${BUCKET_ROOT}/${LATEST}" "${LOCAL_DUMP}" --only-show-errors \
    || fail "download_failed" "aws s3 cp failed"
else
  fail "config_missing" "set RESTORE_LOCAL_FILE, RCLONE_REMOTE, or S3_BUCKET"
fi

[ -s "${LOCAL_DUMP}" ] || fail "dump_empty" "fetched dump is empty"
head -c 5 "${LOCAL_DUMP}" | grep -q "PGDMP" || fail "dump_corrupt" "not a valid pg_dump custom archive"

# ── 2) استرجاع في قاعدة عابرة (قياس RTO) ────────────────────────────────
START_EPOCH="$(date -u +%s)"
log "info" "createdb" "${SCRATCH_DB}"
psql -d "${RESTORE_ADMIN_URL}" -v ON_ERROR_STOP=1 -q \
  -c "CREATE DATABASE \"${SCRATCH_DB}\";" \
  || fail "createdb_failed" "could not create scratch database"

# وصلة القاعدة العابرة = وصلة الإدارة مع تبديل اسم القاعدة الأخير في المسار.
SCRATCH_URL="$(printf '%s' "${RESTORE_ADMIN_URL}" | sed -E "s#/[^/?]+(\?|$)#/${SCRATCH_DB}\1#")"

log "info" "restore_start" "pg_restore -> ${SCRATCH_DB}"
# --no-owner/--no-privileges: القاعدة العابرة مملوكة للمستخدم الإداري، لا نحتاج أدوار الإنتاج.
if ! pg_restore --dbname="${SCRATCH_URL}" --no-owner --no-privileges \
      --jobs=2 --exit-on-error "${LOCAL_DUMP}"; then
  fail "restore_failed" "pg_restore exited nonzero"
fi
END_EPOCH="$(date -u +%s)"
RTO_SECONDS=$(( END_EPOCH - START_EPOCH ))

# ── 3) استعلامات السلامة ────────────────────────────────────────────────
# جدول أساسي موجود ومملوء + جدول الدفتر المالي موجود (السجل الحرج §8.1).
TENANTS="$(psql -d "${SCRATCH_URL}" -tAc "SELECT count(*) FROM tenants;" 2>/dev/null || echo "ERR")"
[ "${TENANTS}" != "ERR" ] || fail "sanity_failed" "tenants table missing after restore"
[ "${TENANTS}" -ge 1 ] 2>/dev/null || fail "sanity_failed" "tenants table empty after restore"

LEDGER_OK="$(psql -d "${SCRATCH_URL}" -tAc "SELECT to_regclass('public.ledger_entries') IS NOT NULL;" 2>/dev/null || echo "f")"
[ "${LEDGER_OK}" = "t" ] || fail "sanity_failed" "ledger_entries table missing after restore"

log "info" "restore_test_ok" "tenants=${TENANTS} rto_seconds=${RTO_SECONDS} target_rto_seconds=7200"
exit 0
