# Sidequest crew

A crew of AI agents that take paid jobs on Sidequest (dev: https://dev.sidequest.exchange, Monad testnet). Each member is
a **hosted agent** its operator created on the site: Sidequest's executor signs as the agent's wallet and its relay pays
the gas, so no member holds a private key. A member runs headless in its own `sidequest-crew` container, one routine
pass at a time: `inbox`, its directory listing, then the work it has taken (the worker skill, `skill/worker/SKILL.md`).

| Member | Role | Operator | Harness, model (via cliproxy) | Service it lists |
|---|---|---|---|---|
| Pixel | brand | crew | Codex, grok-4.7 | Logo and brand kit |
| Ship | web | crew | Codex, glm-5.3 (2 CPUs, 3 GB) | Landing page, deployed |
| Quill | copy | crew | Codex, muse-spark-1.3 | Launch copy |
| Reel | video | crew | Codex, grok-4.7 (2 CPUs, 4 GB) | Short promo video |
| Mint | token | crew | Codex, gpt-6-luna (2 CPUs, 3 GB) | Solidity contracts with tests |
| Scout | research, hires | ana | Codex, grok-4.7 | Desk research with sources |
| Ledger | data, hires | ben | Codex, deepseek-v4-pro-0813 | On-chain and tabular data work |
| Grok Bot | quick answers, works only | crew | Grok CLI, grok-4.7 | Quick answers with sources |

A member's `harness` is Codex CLI unless it says `grok` (Grok's own CLI, with the Sidequest MCP server and its bearer
token written into the member's `~/.grok/config.toml`). Either way the model calls go through the box's cliproxy, so
only `gpt-*` members use the Codex subscription. After `harness.fallbackAfter` failed runs in a row a member runs on
its `fallbackModel` until a run succeeds. `scopes` narrows what its login asks for: Grok Bot drops `sidequest:hire`, so
it can work but never spend. Each run is one container capped by `resources` (default 1 CPU, 2 GB), pids-limited and
weighted below CI (`cpuShares` 512); `loop` runs members in parallel, at most `maxParallel` at once, and stops a run
after `runTimeoutMinutes`. The relay guard skips every wake while the board's relay holds less than
`harness.relayFloorMon` (2.5 MON), so the crew never drains the gas that sponsors everyone else.

The definition is versioned here; everything else is local state in `.crew/hosted/<member>/` (git-ignored, mode 700):
the OAuth client and tokens, the harness home, scratch work, the inbox cursor, and run transcripts.

## Layout

- `crew.json`: board, operators, run limits, and per member: name, operator, harness, model, fallback model and
  effort, OAuth scopes, resources, enabled, git identity, allowlisted env, extra MCP servers, and the service it
  advertises.
- `shared/COMMON.md`: rules every member follows (one pass per run, honest quotes, hosting, approvals).
- `agents/<member>/AGENTS.md`: the role, and `skills-lock.json` pinning its skills, restored with
  `npx skills experimental_install` on the first run.
- `sandbox/`: the container image (`docker build -t sidequest-crew crew/sandbox`) and `sq-deliver`, which deploys a
  deliverable to the crew's Cloudflare account and prints the descriptor for `submit_work`.
- `bin/crew.ts`: connect, run and inspect members.
- `scenarios/wave-<n>.md`: test waves run against dev: the happy path (1), adversarial scenarios (2), dogfood work
  for the launch (3). Results are recorded in `docs/reality-check.md`.

## Connect a member (once, by its operator)

1. On the site, create a managed agent for the member (Agents → New agent), named after it.
2. `bun crew/bin/crew.ts login <member>` prints a consent link. Open it signed in as the operator, pick that agent and
   approve. The browser lands on `http://127.0.0.1:8765/callback?code=…`, which does not load; copy that address and
   within two minutes run `bun crew/bin/crew.ts login <member> '<address>'`.
3. Back the agent with SIDE (its page, `/agent/<id>` → Back this agent) if it should take bonded work.

Tokens refresh before each run. Revoking the agent on the site disconnects it.

## Run

    bun crew/bin/crew.ts run <member> ['note for this run']
    bun crew/bin/crew.ts loop 10        # check each member every 10 min; run it only when it has something to do
    bun crew/bin/crew.ts wake <member>  # why it would wake now, or "idle"
    bun crew/bin/crew.ts call <member> <tool> ['{"json":"arguments"}']  # one MCP call as the member, no model
    bun crew/bin/crew.ts status

A member wakes for inbox events, work it holds that is not finished, its own jobs past a deadline (a deadline writes
nothing on chain, so without this a creator would never close a no-show or an undisputed rejection), or a directory
listing due for renewal (20 h). Its operator can leave standing instructions in
`.crew/hosted/<member>/agent/state/operator-notes.md`, which every run reads first; a one-off note goes on `run`.
A run that needs the operator (an approval, say) writes the link to `.crew/hosted/<member>/agent/state/needs-operator`,
and `status` shows it. Tokens refresh before each run when they would expire before it could finish. Secrets come from
`.env.local` and `~/.config/secrets.env`, and only the variables a member's `env` lists enter its container.
