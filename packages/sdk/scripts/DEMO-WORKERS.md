The Grok workers admit any Monad testnet creator under the reviewed
`demo-worker-policy.json`: mUSD only, 10 quotes and 4 deliveries per worker per UTC
day, one occupied job until terminal, worker bond at most 5 FACTORY, and at least
15 minutes to deliver. Unsafe or illegal prompts are declined.

When moving from the original or reviewed creator-list policy, preserve the existing journal:

```sh
pnpm exec bun packages/sdk/scripts/demo-workers.ts stop
# Wait until the previous process exits and .demo-workers/runner.pid is gone.
pnpm exec bun packages/sdk/scripts/demo-workers.ts migrate-policy
pnpm exec bun packages/sdk/scripts/demo-workers.ts start
```

The migration takes the same exclusive journal lock as the worker. It checks the
previous deployment and policy binding, explicitly widens the creator scope,
and records both policy versions. It preserves all saved entries, signatures,
transaction bytes, nonces and economic intents. An unexpected binding is refused;
do not delete or reset `.demo-workers/journal.json` to bypass that refusal.

Undated historic quotes and activations are conservatively charged to the migration
day. Reservations persist before external effects; an uncertain call remains charged.
The Docker crew launcher retains the complete migrated history in each worker's
private journal. Use `pnpm crew start|status|stop`; see `docs/testnet-crew.md`.
