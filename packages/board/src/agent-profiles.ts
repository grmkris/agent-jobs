import { BoardError } from './board-error.ts'
import { migrateAgentSchema } from './agent-schema.ts'
import { AgentStore } from './agents.ts'
import type { Sql } from './store.ts'

export const PROFILE_LIMITS = { name: 80, description: 600, tagline: 120 } as const
export type ProfileUpdatedBy = 'owner' | 'agent'

export interface AgentProfile {
  agentKey: string
  name: string
  description: string
  tagline: string
  avatarKey: string | null
  avatarPrompt: string | null
  generationsDay: string | null
  generations: number
  updatedAt: number
  updatedBy: ProfileUpdatedBy
}

export interface AgentProfilePatch {
  name?: string
  description?: string
  tagline?: string
  avatarKey?: string | null
  avatarPrompt?: string | null
}

interface ProfileRow {
  agent_key: string
  name: string
  description: string | null
  tagline: string | null
  avatar_key: string | null
  avatar_prompt: string | null
  generations_day: string | null
  generations: number | null
  updated_at: number | null
  updated_by: ProfileUpdatedBy | null
}

const checkText = (value: string, field: keyof typeof PROFILE_LIMITS): string => {
  const normalized = field === 'name' ? value.trim() : value
  if (normalized.length > PROFILE_LIMITS[field] || (field === 'name' && normalized.length === 0))
    throw new BoardError('invalid', `${field} exceeds its length limit`)
  return normalized
}

const checkDay = (day: string): void => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BoardError('invalid', 'generation day must be UTC YYYY-MM-DD')
}

export class AgentProfiles {
  constructor(
    readonly sql: Sql,
    readonly now: () => number,
  ) {
    migrateAgentSchema(sql)
  }

  read(agentKey: string): AgentProfile {
    const row = this.sql.all<ProfileRow>(
      `SELECT a.id AS agent_key,a.name,p.description,p.tagline,p.avatar_key,p.avatar_prompt,
        p.generations_day,p.generations,p.updated_at,p.updated_by
       FROM agents a LEFT JOIN agent_profiles p ON p.agent_key=a.id WHERE a.id=?`,
      agentKey,
    )[0]
    if (row === undefined) throw new BoardError('not-found', 'Agent not found')
    return {
      agentKey: row.agent_key,
      name: row.name,
      description: row.description ?? '',
      tagline: row.tagline ?? '',
      avatarKey: row.avatar_key,
      avatarPrompt: row.avatar_prompt,
      generationsDay: row.generations_day,
      generations: row.generations ?? 0,
      updatedAt: row.updated_at ?? 0,
      updatedBy: row.updated_by ?? 'owner',
    }
  }

  update(agentKey: string, patch: AgentProfilePatch, updatedBy: ProfileUpdatedBy): AgentProfile {
    const current = this.read(agentKey)
    const name = patch.name === undefined ? current.name : checkText(patch.name, 'name')
    const description =
      patch.description === undefined ? current.description : checkText(patch.description, 'description')
    const tagline = patch.tagline === undefined ? current.tagline : checkText(patch.tagline, 'tagline')
    const avatarKey = patch.avatarKey === undefined ? current.avatarKey : patch.avatarKey
    const avatarPrompt = patch.avatarPrompt === undefined ? current.avatarPrompt : patch.avatarPrompt
    const updatedAt = this.now()
    if (this.sql.atomic === undefined) throw new Error('Profile updates require atomic storage')
    this.sql.atomic(() => {
      new AgentStore(this.sql, this.now).rename(agentKey, name)
      this.sql.run(
        `INSERT INTO agent_profiles
          (agent_key,description,tagline,avatar_key,avatar_prompt,generations_day,generations,updated_at,updated_by)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(agent_key) DO UPDATE SET description=excluded.description,tagline=excluded.tagline,
          avatar_key=excluded.avatar_key,avatar_prompt=excluded.avatar_prompt,updated_at=excluded.updated_at,
          updated_by=excluded.updated_by`,
        agentKey,
        description,
        tagline,
        avatarKey,
        avatarPrompt,
        current.generationsDay,
        current.generations,
        updatedAt,
        updatedBy,
      )
    })
    return this.read(agentKey)
  }

  generationCount(agentKey: string, day: string): number {
    checkDay(day)
    const profile = this.read(agentKey)
    return profile.generationsDay === day ? profile.generations : 0
  }

  reserveGeneration(agentKey: string, day: string): number {
    checkDay(day)
    const run = () => {
      const profile = this.read(agentKey)
      const generations = profile.generationsDay === day ? profile.generations : 0
      if (generations >= 10) throw new BoardError('conflict', 'Avatar generation limit reached for today')
      const next = generations + 1
      this.sql.run(
        `INSERT INTO agent_profiles
          (agent_key,description,tagline,avatar_key,avatar_prompt,generations_day,generations,updated_at,updated_by)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(agent_key) DO UPDATE SET generations_day=excluded.generations_day,
          generations=excluded.generations,updated_at=excluded.updated_at`,
        agentKey,
        profile.description,
        profile.tagline,
        profile.avatarKey,
        profile.avatarPrompt,
        day,
        next,
        this.now(),
        profile.updatedBy,
      )
      return next
    }
    return this.sql.atomic === undefined ? run() : this.sql.atomic(run)
  }
}
