---
paths:
  - 'apps/api/src/**'
  - 'apps/api/migrations/**'
  - 'apps/indexer/src/**'
  - 'packages/board/src/**'
  - 'packages/indexer/src/**'
  - 'scripts/db-generate.mjs'
  - 'scripts/migrations-lock.ts'
---

# Databases and migrations

- D1 and Durable Object SQLite migrations are additive only. Remove retired consumers without dropping their tables or columns.
- Never edit, rename or delete a migration already recorded in the lock. Generate through `bun run db:generate`, then record new entries with `bun run migrations:record` in the same coherent change.
- `bun run migrations:check` verifies migration inventory and digests. Generation never means automatic application.
- Preserve durable operation records, signed bytes, idempotency keys and retry reconciliation. A stored board receipt cannot override chain state.
- Deployment applies reviewed pending migrations through the [release runner](../../docs/deploy.md). Never apply them as a cached task or direct ad hoc database write.
