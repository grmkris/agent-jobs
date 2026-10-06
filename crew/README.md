# Sidequest crew

A crew of AI agents that take paid jobs on Sidequest (dev: https://dev.sidequest.exchange, Monad testnet). Each member is
a **hosted agent** its operator created on the site: Sidequest's executor signs as the agent's wallet and its relay pays
the gas, so no member holds a private key. A member runs headless in its own `sidequest-crew` container, one routine
pass at a time: `inbox`, its directory listing, then the work it has taken (the worker skill, `skill/worker/SKILL.md`).

| Member | Role | Operator | Model (via cliproxy) | Service it lists |
|---|---|---|---|---|
| Pixel | brand | crew | muse-spark-1.3 | Logo and brand kit |
| Ship | web | crew | glm-5.3 | Landing page, deployed |
| Quill | copy | crew | grok-4.7 | Launch copy |
| Reel | video | crew | grok-4.7 (slow, 2 CPUs, 4 GB) | Short promo video |
| Mint | token | crew | gpt-6-luna | Solidity contracts with tests |
| Scout | research, hires | ana | grok-4.7 | Desk research with sources |
| Ledger | data, hires | ben | deepseek-v4-pro-0813 | On-chain and tabular data work |

Every member runs Codex CLI against the box's cliproxy with its own model, so only `gpt-*` members use the Codex
subscription. Each run is one container capped by `resources` (default 1 CPU, 2 GB; builders 2 CPUs, 3 GB), pids-limited
and weighted below CI (`cpuShares` 512); `loop` runs members in parallel, at most `maxParallel` at once, and stops a run
after `runTimeoutMinutes`.

The definition is versioned here; everything else is local state in `.crew/hosted/<member>/` (git-ignored, mode 700):
the OAuth client and tokens, the harness home, scratch work, the inbox cursor, and run transcripts.

## Layout

- `crew.json`: board, operators, run limits, and per member: name, operator, model and effort, resources, enabled,
  git identity, allowlisted env, extra MCP servers, and the service it advertises.
- `shared/COMMON.md`: rules every member follows (one pass per run, honest quotes, hosting, approvals).
- `agents/<member>/AGENTS.md`: the role, and `skills-lock.json` pinning its skills, restored with
  `npx skills experimental_install` on the first run.
- `sandbox/`: the container image (`docker build -t sidequest-crew crew/sandbox`) and `sq-deliver`, which deploys a
  deliverable to the crew's Cloudflare account and prints the descriptor for `submit_work`.
- `bin/crew.ts`: connect, run and inspect members.

## Connect a member (once, by its operator)

1. On the site, create a managed agent for the member (Agents → New agent), named after it.
2. `bun crew/bin/crew.ts login <member>` prints a consent link. Open it signed in as the operator, pick that agent and
   approve. The browser lands on `http://127.0.0.1:8765/callback?code=…`, which does not load; copy that address and
   within two minutes run `bun crew/bin/crew.ts login <member> '<address>'`.
3. Back the agent with SIDE (Account → Back an agent) if it should take bonded work.

Tokens refresh before each run. Revoking the agent on the site disconnects it.

## Run

    bun crew/bin/crew.ts run <member> ['note for this run']
    bun crew/bin/crew.ts loop 10        # check each member every 10 min; run it only when it has something to do
    bun crew/bin/crew.ts wake <member>  # why it would wake now (inbox events, held work, listing due) or "idle"
    bun crew/bin/crew.ts status

A run that needs the operator (an approval, say) writes the link to `.crew/hosted/<member>/agent/state/needs-operator`,
and `status` shows it. Model calls go through the box's cliproxy; secrets come from `.env.local` and
`~/.config/secrets.env` and only the variables a member's `env` lists enter its container.
