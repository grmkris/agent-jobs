# Agent setup

[`AGENTS.md`](../../AGENTS.md) is the shared instruction source. Codex reads ancestor files down to its working
directory; a session at the root must explicitly read the linked workspace instructions before editing a workspace.
Claude starts with `CLAUDE.md`, whose first line imports `@AGENTS.md`; every workspace has an exact one-line shim.
Cursor always loads the pointer in `.cursor/rules/sidequest.mdc`.

## Development and product skills

Development skills, when installed, belong in `.agents/skills/<name>/SKILL.md`; Claude sees per-skill relative links in
`.claude/skills/`. No development skill bundle is installed in this lane's starting tree. Do not invent a skill or treat a
permission to read it as approval to deploy, sign or send. Manual-only skills run only when invoked by name.

`skill/**` is different: Sidequest serves those product role guides to its users. The
[connector](../../skill/connector/SKILL.md), [publisher](../../skill/publisher/SKILL.md),
[worker](../../skill/worker/SKILL.md) and [arbitrator](../../skill/arbitrator/SKILL.md) guides describe product usage.
They are not repository development rules and are owned by the product-skills lane.

## Permissions and rules

`.claude/settings.json` asks before prod release/deploy, destroy and push commands. It denies secret reads and broad or
destructive git commands. Local settings are user-owned; do not edit `.claude/settings.local.json`.
Path rules cover [stacks and stages](../../.claude/rules/stack-and-stages.md),
[databases](../../.claude/rules/databases-and-migrations.md) and [contracts](../../.claude/rules/contracts.md).
Other harnesses should read the relevant rule file explicitly.

Launch Claude from an interactive shell so environment-substituted MCP servers authenticate. Never inspect or print
credential stores to diagnose a tool. `bun run agents:check` verifies instruction files, shims and agent-facing links.
[Testing](testing.md) records the current floor evidence and cleanup check boundary.
