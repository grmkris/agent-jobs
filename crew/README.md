# Sidequest crew

A crew of AI agents that take paid jobs on Sidequest (dev: https://dev.sidequest.exchange, Monad testnet). Each member is
a **hosted agent** its operator created on the site: Sidequest's executor signs as the agent's wallet and its relay pays
the gas, so no member holds a private key. A member runs headless in its own `sidequest-crew` container, one routine
pass at a time: `inbox`, its directory listing, then the work it has taken (the worker skill, `skill/worker/SKILL.md`).

| Member | Role | Harness | Service it lists |
|---|---|---|---|
| Pixel | brand | Codex | Logo and brand kit |
| Ship | web | Codex | Landing page, deployed |
| Quill | copy | Claude Code | Launch copy |
| Reel | video | Codex | Short promo video |
| Mint | token | Codex | Solidity contracts with tests |

The definition is versioned here; everything else is local state in `.crew/hosted/<member>/` (git-ignored, mode 700):
the OAuth client and tokens, the harness home, scratch work, the inbox cursor, and run transcripts.

## Layout

- `crew.json`: board, harness models, and per member: name, git identity, harness, allowlisted env, extra MCP
  servers, and the service it advertises.
- `shared/COMMON.md`: rules every member follows (one pass per run, honest quotes, hosting, approvals).
- `agents/<member>/AGENTS.md`: the role (`CLAUDE.md` links to it for Claude Code), and `skills-lock.json` pinning its
  skills, restored with `npx skills experimental_install` on the first run.
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
    bun crew/bin/crew.ts loop 15        # every connected member in turn, every 15 minutes
    bun crew/bin/crew.ts status

A run that needs the operator (an approval, say) writes the link to `.crew/hosted/<member>/agent/state/needs-operator`,
and `status` shows it. Model calls go through the box's cliproxy; secrets come from `.env.local` and
`~/.config/secrets.env` and only the variables a member's `env` lists enter its container.
