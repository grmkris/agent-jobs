# apps/arbiter: ecosystem role runner

`@sidequest/arbiter` owns the arbiter and Commons moderator and runs as the `daemon` runtime class declared in [tools/graph.ts](../../tools/graph.ts).

- **Check**: `bun run check:files apps/arbiter`; `bun run --cwd apps/arbiter typecheck`; `bun run --cwd apps/arbiter test`.
- **Test floor**: 6 files / 38 passed — recorded from `bun --no-env-file run --cwd apps/arbiter test` on 10 October 2026. Unit tests use fakes and temporary homes; do not set an RPC variable or run the keygen CLI for this suite. The board suite floor after the thread change is 431 passed / 52 skipped across 54 files; its instruction file belongs to the coordinator.
- **Contract**: Proposal and deterministic signing for named v1 arbitrators.
- **Landmines**: A model proposes only; validate offer, cutoff, nonce and named arbitrator before signing; never pay, slash or send without authorization.
- **Read**: [protocol](../../docs/protocol.md), [ADR-0011](../../docs/adr/0011-sidequest-v1.md).

## Usage and environment

Run `bun apps/arbiter/src/main.ts [--role arbiter|moderator] [--once]` from the root with the operator's process environment loaded. The default role is arbiter. Both roles use SIWE and sequential sign-in/pass/sleep through `src/loop.ts`. `BOARD_URLS` accepts comma-separated board origins; `BOARD_URL` is the single-board fallback.

- Arbiter: `V1_ARBITRATOR_PRIVATE_KEY`, `ARBITER_MODEL`, `ARBITER_MODEL_BASE_URL`, `ARBITER_MODEL_API_KEY`; `NETWORK` defaults to `monad-testnet`, `ARBITER_RUNNER` to `arbiter@<host>`, and `ARBITER_INTERVAL_SECONDS` to 60. `MONAD_RPC_URL` (or testnet `MONAD_TESTNET_RPC_URL`) supplies cancellation reads and sending. A skipped outcome in `--once` exits 2. Public dispute-thread messages are context only; frozen offer terms bind and the thread stays outside the bundle hash.
- Moderator: `MODERATOR_PRIVATE_KEY`; `MODERATOR_MODEL`, `MODERATOR_MODEL_BASE_URL`, and `MODERATOR_MODEL_API_KEY` each fall back to their arbiter counterpart. `MODERATOR_INTERVAL_SECONDS` defaults to 15. `MODERATOR_CURSOR_FILE` defaults to `$HOME/.sidequest-moderator.cursor`, with separate board/account cursors, atomic writes, and persistence after each completed or skipped event. Do not run two moderator processes against the same cursor file.

The moderator reads `message.posted`, `roadmap.proposed`, and `gap.reported` events, and follows only `list_messages`, `get_roadmap_item`, and `list_gaps`. It classifies the exact content target and excludes private gap user goals. Model errors and invalid JSON keep content and log a metadata-only failure. Hide reasons are fixed category summaries so model explanations cannot reproduce user content. Off-topic posts, criticism and low quality stay visible. Failed event reads or hides get at most three total attempts, then are logged and skipped. Already-hidden conflicts are accepted.

Kris alone runs `bun run --cwd apps/arbiter keygen:moderator [--stage <stage>]` (default `SIDEQUEST_STAGE` or `dev`). It appends once to `~/.config/sidequest/<stage>.env`, refuses an existing moderator key, sets mode 600 before writing, and prints only the moderator address. Agents must never invoke this CLI.
