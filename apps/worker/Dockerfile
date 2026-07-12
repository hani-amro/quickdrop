# syntax=docker/dockerfile:1.7
# =============================================================================
# QuickDrop — صورة إنتاج @quickdrop/worker (BullMQ consumers + outbox poller +
# housekeeping). لا منفذ HTTP ⇒ لا EXPOSE ولا HEALTHCHECK عبر HTTP.
# -----------------------------------------------------------------------------
# نفس تدفّق api متعدد المراحل (§12/§11):
#
#   [build]  node:24-slim كامل — نسخ الـ monorepo، install --frozen-lockfile،
#            بناء worker + تبعياته (@quickdrop/db, shared, telegram) عبر turbo،
#            ثم `pnpm deploy --prod --legacy /app` يُخرج حزمة مكتفية ذاتياً:
#            dist المبني + node_modules إنتاجية فقط تضم dist حزم الـ workspace.
#            legacy مقصود لينسخ dist المتجاهَل في .gitignore بدل قواعد npm-publish.
#
#   [runtime] node:24-slim نحيف — مستخدم 'app' (uid 1001) غير جذر، نسخ /app إلى
#            نفس المسار /app (يُبقي روابط node_modules الرمزية صالحة)، وCMD بصيغة
#            exec كي يصل SIGTERM مباشرة إلى Node → إغلاق نظيف يستنزف المهام الجارية
#            ويُغلق الطوابير/DB/Redis قبل الخروج (main.ts يمسك الإشارة صراحةً §12).
# =============================================================================

# ---------- build ----------
FROM node:24-slim AS build

ENV CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable

WORKDIR /repo

COPY . .

RUN pnpm install --frozen-lockfile

# بناء worker + تبعياته فقط (shared → db → telegram → worker) عبر turbo ^build.
RUN pnpm exec turbo run build --filter=@quickdrop/worker

RUN pnpm --filter @quickdrop/worker deploy --prod --legacy /app

# ---------- runtime ----------
FROM node:24-slim AS runtime

ENV NODE_ENV=production

RUN groupadd --gid 1001 app \
    && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

COPY --from=build --chown=app:app /app /app

USER app

# لا EXPOSE ولا HEALTHCHECK: العامل بلا منفذ. صحّته تُراقَب عبر عمق الطوابير/اللوغ (§13).
# صيغة exec: Node يصير PID 1 ويستقبل SIGTERM مباشرة → إغلاق نظيف (§12).
CMD ["node", "dist/main.js"]
