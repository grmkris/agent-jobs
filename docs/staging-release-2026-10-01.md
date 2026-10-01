# Testnet recovery evidence — 1 October 2026

Main revision `d6ccc5bc680d72e6744d9ce3523b31411a06bb58` was pushed to
`origin/main` and applied with Alchemy v2 from the authoritative local staging
state. Reviewed plan digest:
`8a33577c5d64d037cc63e19c22267e86924860b906917ea23673b8491fddf497`.

- API `agentjobs-api-staging-ba2zqmaom6el4lws`: `46750921-58a5-4321-8c51-39171944ccbb`
- Indexer `agentjobs-indexer-staging-2unhvhpefxd7n2wb`: `e0f0fef5-4dd6-4855-8f7c-458ea56187d8`
- Explore `agentjobs-explore-staging-67xgxuclftbgtgxn`: `d093dad8-2703-4b82-9f84-ba6fe67989ee`
- D1 `1b2ddfdd-650e-4846-8b55-fca07872efec`
- R2 `agentjobs-manifests-staging-4yyroq65le7dnxbm`
- Board namespace `eab5801c233a4d1f952a457050958175`
- Directory namespace `8ae279bb120d4a1ca4dfbcb87ba3f97c`

The plan had four updates, one noop, and zero resource creates, replacements,
deletes or adoptions. It added `DirectoryObject`, aliased `DIRECTORY_DATABASE`
to the existing D1, and applied `0001_directory_agents.sql`.

Live checks passed:

- `/health`: 200, `ok: true`, Cloudflare Workers, `monad-testnet`.
- `/data/directory`: 200, empty `agents`, `nextCursor: null`, chain ID 10143 and
the expected ERC-8004 registry.
- MCP initialize and tools/list: 200; all 11 directory tools are present.
- Anonymous `create_task`: 401 `unauthenticated`.
- `/api/protocol_info`: chain ID 10143 and expected testnet contracts.
- Apex: 301 to `https://testnet.hireling.xyz/`.
- Indexer: two successful observations; checkpoint advanced from 67284235 to
67284654. Cron remains `* * * * *`.

An isolated disposable Worker rehearsal proved the additive Durable Object
migration, same-Worker old-version rollback, and new-version redeploy with both
old and new counters preserved. It did not exercise product logic. The rehearsal
Worker, duplicate Workers, empty R2 bucket and empty D1 were removed after
read-only checks. Duplicate Durable Object namespaces disappeared with their
Worker. The three clean integrated e38/e39/e30 worktrees and their local branches
were removed. The CRE worktree was privately archived before removal.

No mainnet transaction, wallet signature, directory enrollment, paid job, real
alert or production-admission action was performed. Credential rotation remains
outstanding after the documented state-output exposure.

Final cleanup readback at **15:01:56 UTC** found exactly the three original
Workers, the original D1/R2, and the original Board plus new DirectoryObject
namespaces. The Indexer checkpoint was **67287414**, finalized head **67287757**
(343 blocks behind), with a successful cron observation 24 seconds earlier.
Only `main` remains locally/remotely, with one checkout. Retired branches and the
CRE worktree have private backups under `.alchemy/recovery/`; pre-existing local
media and SDK scripts were preserved. Final `pnpm check` passed; the focused
staging suites passed **96/96**. Contract tests reported **188 passed / 29 skipped**;
the skipped live/fork cases are not new on-chain evidence.
