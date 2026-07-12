# syntax=docker/dockerfile:1.7
# =============================================================================
# QuickDrop — صورة إنتاج @quickdrop/dashboard (Next.js 15 App Router، إخراج standalone)
# -----------------------------------------------------------------------------
# تدفّق متعدد المراحل (§12/§11):
#
#   [build]  node:24-slim كامل — نسخ الـ monorepo، install --frozen-lockfile،
#            بناء dashboard + تبعيته @quickdrop/shared عبر turbo. next.config يضبط
#            output:'standalone' + outputFileTracingRoot=جذر الـ monorepo، فينتج
#            Next مجلد .next/standalone مكتفياً ذاتياً (server.js + node_modules
#            مصغّرة بملفات فعلية) بتخطيط الـ monorepo: apps/dashboard/server.js.
#            متغيّرات NEXT_PUBLIC_* تُحقن وقت البناء (تُدمَج في حزمة المتصفح) عبر ARG.
#
#   [runtime] node:24-slim نحيف — مستخدم 'app' (uid 1001) غير جذر، ننسخ standalone
#            إلى /app ثم .next/static إلى موضعه ضمنه (Next لا يضع static داخل
#            standalone). لا أسرار في الصورة: STAFF_API_TOKEN وغيره تُمرَّر وقت
#            التشغيل فقط (§11). CMD بصيغة exec → SIGTERM يصل Node مباشرة (§12).
# =============================================================================

# ---------- build ----------
FROM node:24-slim AS build

# BUILD_STANDALONE=1 يفعّل output:'standalone' في next.config (مبوَّب كي لا يكسر بناء
# ويندوز المحلي بروابطه الرمزية الممنوعة؛ لينكس هنا يسمح بها).
ENV CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    NODE_ENV=production \
    BUILD_STANDALONE=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# أصل الـ API عام (ليس سرّاً §11) لكنه يُدمَج في المتصفح وقت البناء (NEXT_PUBLIC_*):
# CSP connect-src + عميل Socket.IO يحتاجانه. مرّره: --build-arg NEXT_PUBLIC_API_URL=...
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN corepack enable

WORKDIR /repo

COPY . .

RUN pnpm install --frozen-lockfile

# بناء dashboard + @quickdrop/shared عبر turbo ^build → ينتج .next/standalone.
RUN pnpm exec turbo run build --filter=@quickdrop/dashboard

# ---------- runtime ----------
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0

RUN groupadd --gid 1001 app \
    && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin app

WORKDIR /app

# standalone (يضم server.js وnode_modules مصغّرة وpackage.json وقناة الـ .next الخادمية).
COPY --from=build --chown=app:app /repo/apps/dashboard/.next/standalone ./
# الأصول الساكنة: Next لا يدرجها في standalone — تُنسخ إلى موضعها المتوقّع بجانب server.js.
COPY --from=build --chown=app:app /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
# ملاحظة: لا مجلد apps/dashboard/public في المشروع ⇒ لا نسخ له (COPY لمسار غير موجود يفشل).

USER app

EXPOSE 3001

# صحّة حيّة خفيفة: الخادم يستجيب على المنفذ (أي رد HTTP = العملية حيّة). fetch مدمج (Node 24).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(()=>process.exit(0)).catch(()=>process.exit(1))"

# مدخل standalone بتخطيط الـ monorepo. صيغة exec: SIGTERM يصل Node مباشرة (§12).
CMD ["node", "apps/dashboard/server.js"]
