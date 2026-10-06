import { Button } from './ui/button.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import * as sdk from '@sidequest/sdk'
import { useState } from 'react'
import { type Address } from 'viem'
import { useSignTypedData } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { useDelegatorUpgrade } from './Privy.tsx'
import { AgentGrantReview } from './AgentGrantReview.tsx'

import { sponsorApi, useSponsorStatus } from '../sponsor.ts'
import { reviewAgentGrant, type PreparedGrant } from '../agent-grant.ts'
import { typedDataArgs } from '../typed-data.ts'
import { chain, deployment, wagmiConfig } from '../wallet.ts'

export function OperatorGrant({ operator, onReady }: { operator: Address; onReady: () => void }) {
  const status = useSponsorStatus(operator, true)
  const upgrade = useDelegatorUpgrade(operator)
  const { signTypedDataAsync } = useSignTypedData()
  const [review, setReview] = useState<ReturnType<typeof reviewAgentGrant> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function prepare() {
    setBusy(true)
    setError(null)
    try {
      const response = await sponsorApi.prepare(operator)
      const message = JSON.parse(response.sign.typedData).message
      const grant = sdk.parseDelegation(
        JSON.stringify({
          ...message,
          caveats: message.caveats.map((item: object) => ({ ...item, args: '0x' })),
          signature: '0x',
        }),
      )
      const timestamp = grant.caveats.find(
        (item) => item.enforcer.toLowerCase() === deployment.delegation.enforcers.timestamp.toLowerCase(),
      )!
      const expires = Number(BigInt(`0x${timestamp.terms.slice(-32)}`))
      const prepared: PreparedGrant = {
        hash: sdk.delegationHash(grant),
        grant: JSON.parse(sdk.delegationJson(grant)),
        description: { validAfter: expires - sdk.GRANT_VALIDITY },
      }
      setReview(reviewAgentGrant(prepared, { kind: 'operator', delegator: operator }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sponsorship is unavailable')
    } finally {
      setBusy(false)
    }
  }
  async function confirm() {
    if (review === null) return
    setBusy(true)
    setError(null)
    try {
      if (upgrade === null) throw new Error('Your embedded operator wallet is unavailable')
      const txHash = await upgrade()
      if (txHash !== null) await waitForTransactionReceipt(wagmiConfig, { hash: txHash, chainId: chain.id })
      const signature = await signTypedDataAsync(typedDataArgs(review.typedData))
      await sponsorApi.confirm(operator, signature)
      await status.refetch()
      onReady()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The operator permission could not be confirmed')
    } finally {
      setBusy(false)
    }
  }
  if (status.data?.status === 'live') return <Button onClick={onReady}>Continue with gas sponsorship enabled</Button>
  return (
    <div className="grid gap-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        First, enable gas sponsorship for your operator wallet. Your browser signs its upgrade and this grant; the relay sends the upgrade.
      </p>
      {review === null ? (
        <Button busy={busy} onClick={() => void prepare()}>
          Review operator permission
        </Button>
      ) : (
        <>
          <AgentGrantReview description={review.description} />

          <Button busy={busy} onClick={() => void confirm()}>
            Upgrade and sign operator permission
          </Button>
        </>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
