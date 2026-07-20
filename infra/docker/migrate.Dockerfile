# syntax=docker/dockerfile:1.7
# =============================================================================
# QuickDrop — صورة الترحيلات لمرة واحدة (migrate one-shot). تشغّل ترحيلات drizzle
# (packages/db/scripts/migrate.ts عبر tsx) بدور migrator ضد قاعدة الإنتاج.
#
# لماذا صورة مستقلة (لا صورة api/worker): تلك حِزَم `pnpm deploy --prod` مجرّدة من
# devDependencies (بلا tsx) ومن scripts/migrations — فلا تصلح للترحيل. هذه الصورة
# تُبقي tsx + drizzle + pg + مجلّد migrations. لا تُكشف لأي منفذ ولا تعمل كمسار تطبيق.
# =============================================================================
FROM node:24-slim

ENV CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable

WORKDIR /repo

COPY . .

# db + تبعياته فقط (workspace) مع devDependencies (tsx) — لا --prod. migrate.ts يستورد
# drizzle-orm + pg فقط (تبعيات db الإنتاجية) ويقرأ migrations/*.sql المنسوخة أعلاه.
RUN pnpm install --frozen-lockfile --filter "@quickdrop/db..."

# db:migrate = pnpm --filter @quickdrop/db migrate = tsx scripts/migrate.ts (يعمل بدور migrator
# عبر DATABASE_URL_MIGRATOR من env_file). idempotent — drizzle يتخطّى المطبّق.
CMD ["pnpm", "--filter", "@quickdrop/db", "migrate"]
