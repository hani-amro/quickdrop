# QuickDrop

SaaS توصيل متعدد المستأجرين — بوت تيليغرام لكل مكتب، عزل PostgreSQL RLS مُجبَر، NestJS + Drizzle + BullMQ.

**الوثيقة الحاكمة:** [QuickDrop-SaaS-وثيقة-البناء.md](./QuickDrop-SaaS-وثيقة-البناء.md) — كل قرار فيها مُلزم.

## التشغيل محلياً

```bash
pnpm install
cp .env.example .env            # وولّد MASTER_KEY: openssl rand -hex 32
docker compose -f infra/compose/docker-compose.dev.yml up -d
pnpm db:migrate                 # يعمل بدور migrator
pnpm db:check-rls               # حارس العزل
pnpm test
pnpm --filter @quickdrop/api dev
pnpm --filter @quickdrop/worker dev
```

## البنية

```
apps/api        بوابة webhook (inbox) + REST + health
apps/worker     مستهلكو BullMQ
packages/shared الأنواع، المال (bigint)، الوقت، Point، التشفير
packages/db     مخطط Drizzle + ترحيلات + RLS + withTenant
infra/compose   Postgres+PostGIS، Redis، أدوار القاعدة
```

قاعدة ذهبية: **كل استعلام ضمن مستأجر يمر بـ `withTenant`** — أي مسار آخر يفشل بصوت عالٍ (RLS صارم).
