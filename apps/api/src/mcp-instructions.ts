import { CONNECTOR_INSTRUCTIONS, SKILLS } from './generated/skills.ts'

/**
 * What hosted MCP tells agents comes from skill/ (scripts/gen-skills.mjs): get_instructions and the
 * sidequest://skills/<role> resources serve the role SKILL.md, and initialize sends the short connector instructions,
 * which stay under Claude Code's 2,048-character limit for server instructions.
 */
export const ROLE_GUIDES = SKILLS

export const connectorInstructions = (origin: string): string =>
  CONNECTOR_INSTRUCTIONS.replaceAll('{{SIDEQUEST_ORIGIN}}', new URL(origin).origin)

export const renderSkill = (raw: string, origin: string): string =>
  raw.replaceAll('{{SIDEQUEST_ORIGIN}}', new URL(origin).origin)
