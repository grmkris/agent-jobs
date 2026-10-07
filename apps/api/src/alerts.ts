export type AlertKind = 'uptime' | 'indexer_lag' | 'failed_publish' | 'stuck_escrow' | 'admin_event'
export type AlertSeverity = 'warning' | 'critical'
export const myagentOwnerMcp = 'https://myagent-prod.kristjan-grm11775.workers.dev/mcp'

export interface OwnerAlert {
  readonly id: string
  readonly kind: AlertKind
  readonly severity: AlertSeverity
  readonly summary: string
  readonly detail: string
  readonly observedAt: number
}

export function createOwnerAlerts(options: { ownerConfigured: boolean; send: (alert: OwnerAlert) => Promise<void> }) {
  const delivered = new Set<string>()
  const pending = new Set<string>()
  return {
    emit: async (item: OwnerAlert): Promise<'sent' | 'deduplicated' | 'disabled'> => {
      if (!options.ownerConfigured) return 'disabled'
      if (delivered.has(item.id) || pending.has(item.id)) return 'deduplicated'
      pending.add(item.id)
      await options.send(item)
      delivered.add(item.id)
      return 'sent'
    },
    clear: (id: string) => {
      delivered.delete(id)
      pending.delete(id)
    },
  }
}

export const ownerAlert = (
  kind: AlertKind,
  severity: AlertSeverity,
  summary: string,
  detail: string,
  observedAt = Date.now(),
): OwnerAlert => ({
  id: `${kind}:${summary}`,
  kind,
  severity,
  summary,
  detail: detail.slice(0, 1000),
  observedAt,
})

const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export async function ownerOperationId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
  return `sidequest_alert_${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`
}

export function myagentOwnerSender(accessToken: string, transport: typeof fetch): (item: OwnerAlert) => Promise<void> {
  return async (item) => {
    if (!accessToken) throw new Error('owner-only myagent token is not configured')
    const operationId = await ownerOperationId(item.id)
    let response: Response
    try {
      response = await transport(myagentOwnerMcp, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'send_message',
            arguments: {
              operationId,
              text: `<b>Sidequest ${escapeHtml(item.severity)}</b>\n${escapeHtml(item.summary)}\n${escapeHtml(item.detail)}`,
            },
          },
        }),
      })
    } catch {
      throw new Error('myagent delivery unknown; reconcile operation id before any retry')
    }
    if (!response.ok) throw new Error(`myagent owner sink rejected: HTTP ${response.status}`)
    let result: { error?: unknown; result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> } }
    try {
      result = (await response.json()) as typeof result
    } catch {
      throw new Error('myagent delivery outcome unknown; reconcile operation id')
    }
    if (result.error !== undefined || result.result?.isError || result.result?.content?.length !== 1)
      throw new Error('myagent alert receipt unavailable; reconcile operation id')
    let receipt: { status?: string; messageId?: number }
    try {
      receipt = JSON.parse(result.result.content[0]?.text ?? '{}') as typeof receipt
    } catch {
      throw new Error('myagent alert receipt invalid; reconcile operation id')
    }
    if (receipt.status !== 'sent' || !Number.isSafeInteger(receipt.messageId) || (receipt.messageId ?? 0) <= 0)
      throw new Error('myagent alert is not confirmed; reconcile operation id')
  }
}

export interface P0Observations {
  readonly uptime: readonly { id: string; consecutiveFailures: number }[]
  readonly indexer: { chainId: number; lagBlocks: number; checkpointAgeSeconds: number; healthy: boolean }
  readonly publishes: readonly {
    operationId: string
    ageSeconds: number
    status: 'failed' | 'stuck' | 'refused' | 'confirmed'
  }[]
  readonly escrows: readonly { jobId: string; eligible: boolean; overdueSeconds: number; owed: boolean }[]
  readonly adminEvents: readonly { transactionHash: string; expected: boolean }[]
}

export async function monitorP0(
  observations: P0Observations,
  emit: (item: OwnerAlert) => Promise<unknown>,
  observedAt: number,
): Promise<void> {
  const items: OwnerAlert[] = []
  for (const route of observations.uptime) {
    if (route.consecutiveFailures >= 2)
      items.push({
        ...ownerAlert('uptime', 'critical', 'Repeated route failure', `route=${route.id}`, observedAt),
        id: `uptime:${route.id}`,
      })
  }
  const index = observations.indexer
  if (!index.healthy || index.checkpointAgeSeconds >= 120 || index.lagBlocks > 600)
    items.push({
      ...ownerAlert(
        'indexer_lag',
        index.checkpointAgeSeconds >= 900 ? 'critical' : 'warning',
        'Indexer is stale or unavailable',
        `chain=${index.chainId} lagBlocks=${index.lagBlocks} ageSeconds=${index.checkpointAgeSeconds}`,
        observedAt,
      ),
      id: `indexer_lag:${index.chainId}`,
    })
  for (const operation of observations.publishes) {
    if (operation.status === 'failed' || (operation.status === 'stuck' && operation.ageSeconds >= 300))
      items.push({
        ...ownerAlert(
          'failed_publish',
          'critical',
          'Publish needs receipt reconciliation',
          `operation=${operation.operationId}`,
          observedAt,
        ),
        id: `failed_publish:${operation.operationId}`,
      })
  }
  for (const escrow of observations.escrows) {
    if (escrow.eligible && escrow.overdueSeconds >= 300)
      items.push({
        ...ownerAlert(
          'stuck_escrow',
          escrow.overdueSeconds >= 900 ? 'critical' : 'warning',
          escrow.owed ? 'Owed reward needs review' : 'Eligible escrow is unsettled',
          `job=${escrow.jobId}`,
          observedAt,
        ),
        id: `stuck_escrow:${escrow.jobId}`,
      })
  }
  for (const event of observations.adminEvents) {
    if (!event.expected)
      items.push({
        ...ownerAlert(
          'admin_event',
          'critical',
          'Unexpected contract administration',
          `transaction=${event.transactionHash}`,
          observedAt,
        ),
        id: `admin_event:${event.transactionHash}`,
      })
  }
  let failed = 0
  for (const item of items) {
    try {
      await emit(item)
    } catch {
      failed++
    }
  }
  if (failed > 0)
    throw new Error(`${failed} owner alert deliveries are unconfirmed; reconcile incident ids before retry`)
}
