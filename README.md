# QuickDrop

A multi-tenant delivery and dispatch system in which each tenant delivers restaurant orders with its own riders.

- Customers order on WhatsApp or Telegram; on WhatsApp an AI model can take the order, but prices come only from the server's pricing engine.
- Orders are offered automatically to the tenant's riders, with live tracking, proof-of-delivery photos and online payment through Billplz (MYR).
- Tenant data is isolated in code (`withTenant()`) and by PostgreSQL row-level security with `FORCE`; money is stored as `BIGINT` in the smallest currency unit.

Stack: TypeScript monorepo (pnpm, Turborepo) with NestJS, BullMQ, Next.js, Vite/React, Drizzle, PostgreSQL 16 + PostGIS and Redis.

## Run

```bash
pnpm install
pnpm dev:up        # PostgreSQL + PostGIS and Redis in Docker
pnpm db:migrate    # export the variables from .env.example first
pnpm test
```

MIT License, see [LICENSE](LICENSE).
