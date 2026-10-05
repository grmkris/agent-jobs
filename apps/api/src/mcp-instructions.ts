import { CONNECTOR_INSTRUCTIONS, SKILLS } from './generated/skills.ts'

/**
 * What hosted MCP tells agents comes from skill/ (scripts/gen-skills.mjs): get_instructions and the
 * hireling://skills/<role> resources serve the role SKILL.md, and initialize sends the short connector instructions,
 * which stay under Claude Code's 2,048-character limit for server instructions.
 */
export const ROLE_GUIDES = SKILLS

export const connectorInstructions = (origin: string): string => CONNECTOR_INSTRUCTIONS.replaceAll('{{HIRELING_ORIGIN}}', new URL(origin).origin)
