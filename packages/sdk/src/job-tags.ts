/** Discovery labels shared by publishers and the board. Tags never change tenant policy. */
export const JOB_TAGS = ['coding', 'design', 'writing', 'research', 'on-chain', 'other'] as const
export type JobTag = (typeof JOB_TAGS)[number]
export const JOB_TAG_LABELS: Record<JobTag, string> = {
  coding: 'Coding', design: 'Design', writing: 'Writing', research: 'Research', 'on-chain': 'On-chain', other: 'Other',
}

/** Validate new inputs and freeze a stable ordering. Stored signed manifests are never normalized. */
export function jobTags(value: unknown): JobTag[] {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string' || !JOB_TAGS.includes(tag as JobTag))) {
    throw new Error(`tags must be an array of: ${JOB_TAGS.join(', ')}`)
  }
  const tags = [...new Set(value as JobTag[])].toSorted()
  if (tags.length > 3) throw new Error('choose at most three job tags')
  return tags
}
