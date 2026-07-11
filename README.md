# QuickDrop

SaaS توصيل متعدد المستأجرين — بوت تيليغرام لكل مكتب، عزل PostgreSQL RLS مُجبَر، NestJS + Drizzle + BullMQ.

**الوثيقة الحاكمة:** [QuickDrop-SaaS-وثيقة-البناء.md](./QuickDrop-SaaS-وثيقة-البناء.md) — كل قرار فيها مُلزم.

## التشغيل محلياً

### التجهيز (مرة واحدة)

```bash
pnpm install
cp .env.example .env   # قيم dev جاهزة للمعاينة؛ للإنتاج ولّد MASTER_KEY وSTAFF_API_TOKEN: openssl rand -hex 32
pnpm dev:up            # Postgres+PostGIS + Redis (docker compose -f infra/compose/docker-compose.dev.yml)
pnpm build             # يبني الحزم المشتركة — السكربتات والتطبيقات تعتمد على dist
set -a && . ./.env && set +a   # حمّل env بجلسة الشِل (انظر ملاحظة env)
pnpm db:migrate        # الترحيلات بدور migrator (DATABASE_URL_MIGRATOR)
pnpm db:seed-dev       # بيانات معاينة: مستأجر demo (بلا بوت) + منطقة دمشق + تسعير + زبونان + سائقان
```

**ملاحظة env:** التطبيقات والسكربتات تقرأ من env الشِل — لا يوجد تحميل `.env` تلقائي
(الاستثناء الوحيد: `db:seed-dev` يحمّل `.env` من الجذر بنفسه، وأسبقية env الشِل محفوظة).
نفّذ سطر التحميل بكل طرفية جديدة قبل أي أمر تالٍ:

- bash / Git Bash: `set -a && . ./.env && set +a`
- PowerShell: `Get-Content .env | Where-Object { $_ -match '^([^#][^=]*)=(.*)$' } | ForEach-Object { Set-Item "env:$($Matches[1])" $Matches[2] }`

### التشغيل (ثلاث طرفيات)

```bash
pnpm dev:api         # NestJS API → http://localhost:3000/health
pnpm dev:worker      # مستهلكو BullMQ (تحديثات تيليغرام، outbox، dispatch، إشعارات)
pnpm dev:dashboard   # داشبورد Next.js RTL → http://localhost:3001
```

`pnpm dev:down` يوقف الحاويات. حارس العزل: `pnpm db:check-rls`. الاختبارات: `pnpm test`.

### env لكل تطبيق (كلها موثقة في `.env.example`)

| التطبيق | المتغيرات |
| --- | --- |
| `apps/api` | `NODE_ENV`، `PORT`، `DATABASE_URL`، `REDIS_URL`، `MASTER_KEY`، `STAFF_API_TOKEN` (اختياري — غيابه: مسارات `/api/*` ترد 503) |
| `apps/worker` | `DATABASE_URL`، `DATABASE_URL_WORKER`، `REDIS_URL`، `MASTER_KEY` |
| `apps/dashboard` | `API_URL`، `STAFF_API_TOKEN` (**نفس قيمة الـ API** — يُحقن بالـ proxy الخادمي ولا يصل المتصفح)، `TENANT_SLUG=demo` |

ملاحظات المعاينة:

- **بوت تيليغرام اختياري:** مستأجر `demo` بلا بوت (حقول البوت NULL) — إنشاء الطلبات من الداشبورد (`/orders/new`) ولوحة الإسناد والـ API تعمل كاملة بلا تيليغرام. لربط بوت لاحقاً (§14): `pnpm tenant:provision -- --slug demo --name "Demo Office" --name-ar "مكتب التجربة" --token <TOKEN> --skip-webhook` — بوت تطوير ينتهي بـ `_dev_bot` (الفخ 24).
- إعادة تشغيل `pnpm db:seed-dev` آمنة: لا تكرر صفوفاً، وتعيد السائقين online بموقع طازج (شرط الترشيح §6.1)، وترفض العمل إذا `NODE_ENV=production`.

## البنية

```
apps/api          بوابة webhook (inbox) + REST للطاقم + health
apps/worker       مستهلكو BullMQ (تحديثات تيليغرام، outbox، dispatch، إشعارات)
apps/dashboard    داشبورد Next.js RTL (لوحة الإسناد /، طلب جديد /orders/new، السائقون /drivers)
packages/shared   الأنواع، المال (bigint)، الوقت، Point، التشفير
packages/db       مخطط Drizzle + ترحيلات + RLS + withTenant + آلة الحالة + التسعير + الإسناد
packages/telegram عميل Bot API
infra/compose     Postgres+PostGIS، Redis، أدوار القاعدة
```

قاعدة ذهبية: **كل استعلام ضمن مستأجر يمر بـ `withTenant`** — أي مسار آخر يفشل بصوت عالٍ (RLS صارم).
