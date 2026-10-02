/**
 * The board's REST API and the indexer's chain facts, same-origin through the Explore Worker, for the board the
 * current route is on: `/b/<slug>/…` and `/embed/<slug>` address that board, everything else the public one
 * (ADR-0008). The client, the session and the result types come from `@agent-jobs/react`; the session token is
 * kept in localStorage (so a new tab stays signed in until it expires) and is valid on every board. Which address it
 * belongs to is kept beside it (`Wallet.tsx`), so another wallet never inherits it.
 */
import { ApiError, type BoardApi, PUBLIC_BOARD_ID, createBoardApi } from '@agent-jobs/react'
import type { DirectoryAgent } from '@agent-jobs/sdk'
import { LAUNCH_MESSAGE, toolAllowed } from './launch.ts'
import { writesOpen } from './wallet.ts'

export {
  ApiError,
  DELIVERABLE_KINDS,
  type AdvanceBudgetTerms,
  type Budget,
  type CallBudgetTerms,
  type ChainJob,
  type Deliverable,
  type DeliverableCheck,
  type DeliverableKind,
  type DeliverableSpec,
  type Quote,
  type QuoteRequest,
  type TaskIndexEntry,
  type TxRequest,
  type BoardInfo,
} from '@agent-jobs/react'

/** The board slug of the current URL (`/b/<slug>`, `/embed/<slug>`), or `public`. */
export function currentBoardId(): string {
  const m = /^\/(?:b|embed)\/([a-z0-9-]{3,32})(?:\/|$)/.exec(window.location.pathname)
  return m?.[1] ?? PUBLIC_BOARD_ID
}

/** `/b/<slug>` on a board route, empty on the public board: what every in-app link is prefixed with. */
export function boardPrefix(): string {
  const b = currentBoardId()
  return b === PUBLIC_BOARD_ID ? '' : `/b/${b}`
}

const apis = new Map<string, BoardApi>()

/** localStorage where the browser allows it (private windows and blocked storage can throw), else this tab only. */
const persistent = {
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return sessionStorage.getItem(k)
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      sessionStorage.setItem(k, v)
    }
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k)
    } catch {
      sessionStorage.removeItem(k)
    }
  },
}

export function boardApi(id = currentBoardId()): BoardApi {
  let api = apis.get(id)
  if (api === undefined) {
    const client = createBoardApi({ baseUrl: '', boardId: id, storage: persistent })
    // Mainnet before launch (D16): only the board's read tools leave the browser, whatever page asks.
    api = writesOpen
      ? client
      : { ...client, tool: <T,>(name: string, args?: Record<string, unknown>) => (toolAllowed(name, false) ? client.tool<T>(name, args) : Promise.reject(new ApiError('launching', LAUNCH_MESSAGE))) }
    apis.set(id, api)
  }
  return api
}

export const session = (): string | null => boardApi().session()
export const setSession = (token: string | null): void => boardApi().setSession(token)
export const tool = <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => boardApi().tool<T>(name, args)
export const data = <T = any>(path: string): Promise<T> => boardApi().data<T>(path)

export interface DirectoryPage {
  agents: DirectoryAgent[]
  nextCursor: string | null
  observedAt: number
  chainId: number
  identityRegistry: string
  scope: string
}

export const fetchDirectory = (after?: string) => data<DirectoryPage>(`directory${after === undefined ? '' : `?after=${encodeURIComponent(after)}`}`)

export const fetchDirectoryAgent = (agentId: string) => data<{ agent: DirectoryAgent }>(`directory/${encodeURIComponent(agentId)}`)
