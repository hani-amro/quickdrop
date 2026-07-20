# syntax=docker/dockerfile:1.7
# =============================================================================
# QuickDrop — تطبيق السائق (PWA خفيف). بناء Vite ثم تقديم dist الساكن عبر nginx:alpine
# **داخل الحاوية** (ليس nginx المضيف). VITE_* تُدمَج وقت البناء (Vite ينلاينها) عبر ARG.
# لا وصول للقاعدة/الشبكة الداخلية — ملفات ساكنة فقط. الكومبوز ينشره على 127.0.0.1 حصراً.
# =============================================================================
FROM node:24-slim AS build

ENV CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# أصل الـ API عام (يُدمَج بالمتصفح): مرّره --build-arg VITE_API_BASE=... (بلا شرطة نهائية).
ARG VITE_API_BASE=""
ARG VITE_TENANT_SLUG="demo"
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_TENANT_SLUG=$VITE_TENANT_SLUG

RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@quickdrop/driver..."
RUN pnpm exec turbo run build --filter=@quickdrop/driver

# ---------- runtime: nginx ساكن (معزول عن nginx المضيف) ----------
FROM nginx:alpine AS runtime
COPY --from=build /repo/apps/driver/dist /usr/share/nginx/html
# منفذ 80 داخل الحاوية فقط (الكومبوز يربطه بـ 127.0.0.1:8112). SPA: fallback لـ index.html.
RUN printf 'server{listen 80;root /usr/share/nginx/html;location / {try_files $uri $uri/ /index.html;}}' \
    > /etc/nginx/conf.d/default.conf
EXPOSE 80
