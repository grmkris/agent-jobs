@AGENTS.md

## Claude Code only

- Repository development skills, when installed, live in `.agents/skills/`; Claude loads their per-skill links from `.claude/skills/`. Read the matching `SKILL.md`.
- Path-scoped rules load from `.claude/rules/`; `.claude/settings.json` asks before prod, destroy and push commands and denies secret reads and destructive or broad git commands.
- Launch Claude Code from an interactive shell so `${VAR}` MCP servers authenticate.
