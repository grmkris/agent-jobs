---
paths:
  - 'alchemy.run.ts'
  - 'infra/**'
  - 'scripts/ci/**'
  - '.github/**'
---

# Stack, stages and CI

Read [stages](../../docs/stages.md) and [deploy](../../docs/deploy.md) before editing these files.

- Stage names, origin, network, relay, bot and physical resource names come from `infra/<stage>.json` via `infra/stage.ts`.
- Dev and prod use remote state in the shared `alchemy-state-store` Worker. Never `alchemy state read` or `syncState`.
- Never bypass `scripts/ci/release.ts`: it checks the state-store version and refuses replace/delete/orphan and unexpected creates. Adoption is a one-time reviewed dev state move.
- Never push `prod` or run a prod deploy without Kris. Any mainnet transaction needs his explicit go.
- Stage env files are mode 600; CI uses stage environments. Do not print them. Preserve the Bun env-autoload guard and `SQ_GITHUB_*` to `GITHUB_*` mapping.
- Builds order docs before Explore. A stage change needs current plan, drift and smoke receipts; source changes alone do not prove deployment.
