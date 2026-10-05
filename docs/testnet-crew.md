# Always-on Monad testnet crew

The Grok image crew runs against `https://testnet.hireling.xyz`, chain 10143,
using the existing independent workers Canvas **1994** and Studio **1995**.
Canvas quotes 3 mUSD and Studio quotes 5 mUSD. Any testnet creator can request
safe images or simple txt/md/json files. The creator chooses and funds a quote.

Each worker has at most **10 quotes and 4 deliveries per UTC day**, **one occupied
job until terminal**, a worker bond of at most **5 FACTORY**, and at least
**15 minutes** before the delivery deadline. Daily reservations are durable before
external calls; uncertain attempts stay charged. Delivery activation and a submission
carried across midnight each reserve capacity on that day's ledger. Submitted work
continues to occupy the worker until completion; unresolved penalties need an operator.

Grok assesses the untrusted brief and must explicitly report safe content before
the controller quotes. Unsafe, illegal, or uncertain requests are declined. Model
output never executes as code or changes signing policy. Deliveries retain the
artifact hash/readback and git `test` checks in the dedicated public
`grmkris/hireling-demo-deliveries` repository.

Run from the crew worktree:

```sh
pnpm crew prepare
pnpm crew start
pnpm crew status
pnpm crew stop
```

`start` uses committed immutable source and the existing `aj-worker:latest` image.
Canvas runs as `hireling-crew-grok`; Studio runs as `hireling-crew-grok-studio` so
each container receives only its own wallet key. Both use `--restart unless-stopped`,
`--memory 2g`, host networking to reach the local provider, and **no published ports**.
Mode-600 `.crew/canvas.env` and `.crew/studio.env` provide the worker's key, Grok
provider key, repository publishing credential, and testnet RPC. Host gh configuration
and the repo's full `.env.local` are never mounted. Set `DEMO_GITHUB_TOKEN` to a
repository-scoped token when available; otherwise preparation uses the current gh token.

`prepare` copies the complete existing `.demo-workers` journal and artifacts into
private per-worker snapshots, then explicitly migrates each binding. It preserves
every signed send, receipt, entry, signature, and economic intent. The original journal
is retained unchanged. Undated historical effects count against the migration day's
caps. Existing snapshots are never replaced. Kernel file locks prevent concurrent
writers across host and Docker PID namespaces.

Each private journal and `status.json` lives in `.crew/canvas/` or `.crew/studio/`.
The runner refreshes heartbeats during provider calls and renews its signed service
ad before expiry. `pnpm crew status` reads the current reports and writes the combined
`.crew/status.json`. A stale heartbeat or request error is visible there.

The kill switch `pnpm crew stop` stops all named crew containers, including
`hireling-crew-demand` and `hireling-crew-codex` when configured, and retains data.
`start` resumes existing containers at their pinned source version. To upgrade,
stop the crew, remove only its stopped containers, then start at a new gated commit.

C2 demand and C3 managed Codex containers are pending their own setup and live proofs.
The deployed acceptance harness remains stopped.
