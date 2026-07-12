# syntax=docker/dockerfile:1.7
# =============================================================================
# QuickDrop — صورة إنتاج @quickdrop/api (NestJS + Socket.IO على نفس خادم HTTP)
# -----------------------------------------------------------------------------
# تدفّق متعدد المراحل (§12 نشر متوافق للخلف + §11 صورة بلا أسرار، مستخدم غير جذر):
#
#   [build]  node:24-slim كامل — نسخ الـ monorepo، pnpm install --frozen-lockfile،
#            بناء api وكل تبعيات الـ workspace (@quickdrop/db, shared, telegram)
#            عبر turbo (يحترم ^build فيبني بالترتيب الطوبولوجي)، ثم
#            `pnpm deploy --prod --legacy` يُخرج حزمة مكتفية ذاتياً في /app:
#            dist المبني + node_modules إنتاجية فقط تضم dist حزم الـ workspace.
#            legacy مقصود: ينسخ ملفات الحزم كما هي على القرص (بما فيها dist المتجاهَل
#            في .gitignore) بدل تطبيق قواعد npm-publish التي كانت ستُسقط dist.
#
#   [runtime] node:24-slim نحيف — مستخدم 'app' (uid 1001) غير جذر، ننسخ /app كما هي
#            إلى نفس المسار /app (روابط pnpm الرمزية داخل node_modules مطلقة/نسبية —
#            نفس مسار الوجهة يُبقيها صالحة)، HEALTHCHECK يضرب /health عبر fetch
#            المدمج في Node 24 (لا curl في slim)، وCMD بصيغة exec كي يصل SIGTERM
#            مباشرة إلى Node فيعمل الإغلاق النظيف (main.ts يمسك الإشارة صراحةً §12).
# =============================================================================

# ---------- build ----------
FROM node:24-slim AS build

# CI=true يمنع أي تأكيد تفاعلي (purge modules) في بيئة بلا TTY؛ تعطيل تتبّع turbo.
ENV CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# corepack يفعّل pnpm بالإصدار المثبَّت في package.json (packageManager: pnpm@11.5.2)
RUN corepack enable

WORKDIR /repo

# نسخ الـ monorepo كاملاً (workspace). .dockerignore يستبعد node_modules/dist/.next
# على المضيف فيُعاد توليدها نظيفة على منصّة لينكس — لا تلوّث من بناء ويندوز.
COPY . .

# تثبيت كل التبعيات (بما فيها dev) اللازمة للبناء — قفل مجمَّد يمنع الانجراف (§12).
RUN pnpm install --frozen-lockfile

# بناء api + تبعياته فقط (shared → db → telegram → api) عبر turbo dependsOn ^build.
RUN pnpm exec turbo run build --filter=@quickdrop/api

# استخراج حزمة إنتاجية مكتفية ذاتياً إلى /app (dist + node_modules إنتاجية فقط).
RUN pnpm --filter @quickdrop/api deploy --prod --legacy /app

# ---------- runtime ----------
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000

# مستخدم خدمة غير جذر (uid 1001) بلا home وبلا شِل تسجيل دخول (§11).
RUN groupadd --gid 1001 app \
    && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

# ننسخ إلى نفس مسار البناء (/app) للحفاظ على صلاحية روابط node_modules الرمزية.
COPY --from=build --chown=app:app /app /app

USER app

EXPOSE 3000

# §13 — يفحصه المنسّق/Uptime الخارجي: /health يتحقق من DB+Redis. fetch مدمج في Node 24.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# صيغة exec: Node يصير PID 1 ويستقبل SIGTERM مباشرة → إغلاق نظيف (§12).
CMD ["node", "dist/main.js"]
