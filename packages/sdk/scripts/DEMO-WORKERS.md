The demo workers admit only the testnet creator addresses checked into
`demo-worker-creators.json`. Add an operator or managed-agent address only after
Claude reviews that exact address. A managed hire's creator is the agent wallet,
so reviewing its operator alone does not admit that hire.

When the list changes, preserve the existing journal:

```sh
pnpm exec bun packages/sdk/scripts/demo-workers.ts stop
# Wait until the previous process exits and .demo-workers/runner.pid is gone.
pnpm exec bun packages/sdk/scripts/demo-workers.ts migrate-policy
pnpm exec bun packages/sdk/scripts/demo-workers.ts start
```

The migration takes the same exclusive journal lock as the worker. It checks the
previous deployment and policy binding, permits additive creator changes only,
and records both policy versions. It preserves all saved entries, signatures,
transaction bytes, nonces and economic intents. An unexpected binding is refused;
do not delete or reset `.demo-workers/journal.json` to bypass that refusal.

The initial reviewed list contains Kris's operator. The fixture operator and
managed-agent addresses await the deployed A01 readback and Claude's review.
