import { SPONSOR_OBJECT_NAME, sponsorToolNames } from '@sidequest/board'
import { COMMONS_OBJECT_NAME, commonsToolNames } from '@sidequest/commons'

export function objectFor(tool: string, boardId: string): string {
  if (sponsorToolNames.has(tool)) return SPONSOR_OBJECT_NAME
  return commonsToolNames.has(tool) ? COMMONS_OBJECT_NAME : boardId
}
