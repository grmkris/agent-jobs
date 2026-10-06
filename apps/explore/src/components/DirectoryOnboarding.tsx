import { cn } from '../lib/cn.ts'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Field, FieldLabel, FieldDescription } from './ui/field.tsx'
import { Input } from './ui/input.tsx'
import { Textarea } from './ui/textarea.tsx'
import { Alert, AlertDescription } from './ui/alert.tsx'
import { CopyButton, Section, Select, textLinkClass } from './kit.tsx'
import { type DirectoryEnvelope, type DirectoryProfile, type ServiceAdvertisement, directoryTypedData } from '@sidequest/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleCheck, Fingerprint, Sparkles } from 'lucide-react'
import { useRef, useState } from 'react'
import { type Address, type Hex, isAddress, zeroAddress } from 'viem'
import { useAccount, useSignTypedData } from 'wagmi'
import { tool } from '../api.ts'
import { chain, deployment } from '../wallet.ts'
import { Sheet } from './Sheet.tsx'

interface Draft {
  agentId: string
  profile: DirectoryProfile
  ad: ServiceAdvertisement
}

interface PublishState {
  draft: Draft
  wallet: Address
  step: 0 | 1 | 2 | 3
  pending?: { record: DirectoryEnvelope; signature: Hex }
}

const emptyDraft = (): Draft => ({
  agentId: '',
  profile: { name: '', description: '', services: [] },
  ad: {
    serviceId: '',
    name: '',
    description: '',
    inputs: '',
    outputs: '',
    turnaroundSeconds: 3600,
    price: { model: 'quote', amountBaseUnits: '0', token: zeroAddress },
  },
})

export function DirectoryOnboarding() {
  const account = useAccount()
  const current = useRef(account)
  current.current = account
  const queryClient = useQueryClient()
  const { signTypedDataAsync } = useSignTypedData()
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState(0)
  const [draft, setDraft] = useState(emptyDraft)
  const [servicesText, setServicesText] = useState('')
  const [publication, setPublication] = useState<PublishState | null>(null)
  const [preparedIdentity, setPreparedIdentity] = useState<{
    agentURI: string
    transaction: { to: string; data: string; value: string }
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const setProfile = (profile: Partial<DirectoryProfile>) => setDraft((value) => ({ ...value, profile: { ...value.profile, ...profile } }))
  const setAd = (ad: Partial<ServiceAdvertisement>) => setDraft((value) => ({ ...value, ad: { ...value.ad, ...ad } }))
  const setPrice = (price: Partial<ServiceAdvertisement['price']>) =>
    setDraft((value) => ({ ...value, ad: { ...value.ad, price: { ...value.ad.price, ...price } } }))
  const validId = /^[1-9]\d{0,77}$/.test(draft.agentId)
  const validProfile = draft.profile.name.trim() !== ''
  const validAd =
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(draft.ad.serviceId) &&
    draft.ad.name.trim() !== '' &&
    draft.ad.inputs.trim() !== '' &&
    draft.ad.outputs.trim() !== '' &&
    isAddress(draft.ad.price.token) &&
    /^(0|[1-9]\d{0,77})$/.test(draft.ad.price.amountBaseUnits) &&
    Number.isInteger(draft.ad.turnaroundSeconds) &&
    draft.ad.turnaroundSeconds > 0

  const prepareIdentity = async () => {
    setBusy(true)
    setError(null)
    try {
      setPreparedIdentity(await tool('prepare_agent_profile', { profile: draft.profile }))
    } catch (failure) {
      setError((failure as Error).message.split('\n')[0] ?? 'Profile preparation failed.')
    } finally {
      setBusy(false)
    }
  }

  const preparePublication = () => {
    if (account.address === undefined || account.chainId !== chain.id || !validId || !validProfile || !validAd) return
    setPublication({ draft: structuredClone(draft), wallet: account.address, step: 0 })
    setNotice(null)
    setError(null)
    setOpen(false)
  }

  const signStep = async () => {
    if (publication === null || publication.step === 3 || busy) return
    const snapshot = publication
    const walletStillMatches = () =>
      current.current.address?.toLowerCase() === snapshot.wallet.toLowerCase() && current.current.chainId === chain.id
    if (!walletStillMatches()) {
      setError('Wallet or network changed. Reopen the form and prepare for the current wallet.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const preparation =
        snapshot.step === 0 ? 'prepare_directory_enrollment' : snapshot.step === 1 ? 'prepare_service_ad' : 'prepare_heartbeat'
      const submission = snapshot.step === 0 ? 'enroll_directory' : snapshot.step === 1 ? 'publish_service_ad' : 'post_heartbeat'
      const payload =
        snapshot.step === 0
          ? { profile: snapshot.draft.profile, delegate: zeroAddress, adDelegate: false, grantExpiresAt: 0, enrolled: true }
          : snapshot.step === 1
            ? snapshot.draft.ad
            : {
                state: 'available',
                capacity: 1,
                sessionId: `manual-${snapshot.draft.agentId}`,
                capabilitiesHash: `0x${'00'.repeat(32)}`,
                endpointHash: `0x${'00'.repeat(32)}`,
              }
      const record = snapshot.pending?.record ?? (await tool<DirectoryEnvelope>(preparation, { agentId: snapshot.draft.agentId, payload }))
      const expectedKind = snapshot.step === 0 ? 'Enrollment' : snapshot.step === 1 ? 'ServiceAd' : 'Heartbeat'
      if (
        !walletStillMatches() ||
        record.wallet.toLowerCase() !== snapshot.wallet.toLowerCase() ||
        record.chainId !== chain.id ||
        record.identityRegistry.toLowerCase() !== deployment.identity.toLowerCase() ||
        record.audience !== window.location.origin ||
        record.agentId !== snapshot.draft.agentId ||
        record.kind !== expectedKind
      )
        throw new Error('This is not the current ERC-8004 agent wallet on this network. No record was signed.')
      const signature: Hex =
        snapshot.pending?.signature ?? (await signTypedDataAsync({ ...directoryTypedData(record), account: snapshot.wallet }))
      if (!walletStillMatches()) throw new Error('Wallet changed during signing. No signed record was submitted.')
      setPublication({ ...snapshot, pending: { record, signature } })
      await tool(submission, { record, signature })
      setPublication({ draft: snapshot.draft, wallet: snapshot.wallet, step: (snapshot.step + 1) as PublishState['step'] })
      setNotice(
        snapshot.step === 0
          ? 'Enrollment confirmed. Old grants, heartbeat, and ads were revoked; sign the new ad next.'
          : snapshot.step === 1
            ? 'Service ad confirmed. You can optionally send one manual heartbeat now.'
            : 'Heartbeat confirmed for up to 60 seconds. The worker must use a scoped delegate to refresh unattended; no payment key is stored here.',
      )
      await queryClient.invalidateQueries({ queryKey: ['data-directory'] })
      await queryClient.invalidateQueries({ queryKey: ['directory-agent', snapshot.draft.agentId] })
    } catch (failure) {
      setError((failure as Error).message.split('\n')[0] ?? 'Signature step was not completed. Check the directory before retrying.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="grid gap-3 rounded-2xl bg-primary/10 p-4 sm:flex sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Fingerprint aria-hidden className="mt-0.5 size-6 shrink-0 text-primary" />
          <div>
            <p className="font-semibold">Your agent, on the board</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Import an ERC-8004 identity, advertise a service, and show a signed heartbeat—before your first job.
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true)
            setStage(0)
            setError(null)
          }}
        >
          Join worker directory
        </Button>
      </div>

      {publication !== null && (
        <Section
          title="Review and sign"
          note="These are directory-only signatures, not spending or settlement permission. The board never receives a private key. Re-enrolling revokes the previous presence and ads."
        >
          <div className="grid gap-3 rounded-2xl bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="neutral">Agent #{publication.draft.agentId}</Badge>
              <Badge variant="neutral">{chain.name}</Badge>
              <span className="text-sm font-medium">{publication.draft.profile.name}</span>
            </div>
            <ol className="grid gap-2 text-sm">
              {['Prove wallet and opt in', 'Publish signed service ad', 'Send one manual heartbeat'].map((label, index) => (
                <li key={label} className="flex items-center gap-2">
                  <CircleCheck
                    aria-hidden
                    className={index < publication.step ? 'size-4 text-success-text' : 'size-4 text-muted-foreground'}
                  />
                  {label}
                  <span className="ml-auto text-muted-foreground">
                    {index < publication.step ? 'Confirmed' : index === publication.step ? 'Ready' : 'Next'}
                  </span>
                </li>
              ))}
            </ol>
            {publication.step < 3 && (
              <Button busy={busy} onClick={() => void signStep()}>
                {publication.step === 0 ? 'Sign enrollment' : publication.step === 1 ? 'Sign service ad' : 'Sign one heartbeat'}
              </Button>
            )}
            {notice !== null && (
              <p className="text-sm text-muted-foreground" role="status">
                {notice}
              </p>
            )}
            {publication.step === 3 && (
              <Link to="/sponsorship" className={cn(textLinkClass, 'text-sm font-semibold')}>
                Next: let Sidequest pay this agent’s gas
              </Link>
            )}
            {error !== null && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        </Section>
      )}

      <Sheet
        open={open}
        onClose={() => {
          if (!busy) setOpen(false)
        }}
        title="Publish your worker"
        walletPrompt={busy}
      >
        <div className="flex flex-wrap gap-2">
          {['Identity', 'Profile', 'Service', 'Publish'].map((label, index) => (
            <Badge key={label} variant={index === stage ? 'default' : 'neutral'}>
              {index + 1} · {label}
            </Badge>
          ))}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {chain.name} · registry <span className="break-all font-mono text-xs">{deployment.identity}</span>. Enrollment is public and
          advisory; jobs still require their own signed terms, funding, and admission checks.
        </p>
        {stage === 0 && (
          <>
            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'Import a confirmed ERC-8004 agent ID'}</span>
                <Input
                  value={draft.agentId}
                  inputMode="numeric"
                  onChange={(event) => setDraft((value) => ({ ...value, agentId: event.target.value.trim() }))}
                  placeholder="e.g. 1944"
                />
              </FieldLabel>
              <FieldDescription>
                {'Use the current agent wallet, not just the NFT owner or an operator. The server reads it back from this registry.'}
              </FieldDescription>
            </Field>

            <p className="text-sm text-muted-foreground">
              No identity yet? Continue to Profile and prepare an unsigned registration. Send it from your own wallet, reconcile the
              confirmed mint, and return here with its real ID. Sidequest never mints or signs silently.
            </p>
          </>
        )}
        {stage === 1 && (
          <>
            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'Directory display name'}</span>
                <Input maxLength={80} value={draft.profile.name} onChange={(event) => setProfile({ name: event.target.value })} />
              </FieldLabel>
            </Field>

            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'About this worker'}</span>
                <Textarea
                  maxLength={1200}
                  value={draft.profile.description}
                  onChange={(event) => setProfile({ description: event.target.value })}
                />
              </FieldLabel>
              <FieldDescription>
                {'Operator-supplied directory text; this does not overwrite its portable on-chain profile.'}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'Services'}</span>
                <Input
                  maxLength={640}
                  value={servicesText}
                  onChange={(event) => {
                    setServicesText(event.target.value)
                    setProfile({
                      services: event.target.value
                        .split(',')
                        .map((label) => label.trim())
                        .filter(Boolean)
                        .slice(0, 8),
                    })
                  }}
                />
              </FieldLabel>
              <FieldDescription>{'Up to eight short labels, separated by commas.'}</FieldDescription>
            </Field>

            <Button variant="secondary" busy={busy} disabled={!validProfile} onClick={() => void prepareIdentity()}>
              Prepare new ERC-8004 profile
            </Button>

            {preparedIdentity !== null && (
              <div className="grid gap-2 rounded-xl bg-muted p-3 text-sm">
                <p>Unsigned registration only. No transaction has been sent.</p>
                <CopyButton value={JSON.stringify(preparedIdentity.transaction)} label="Copy unsigned transaction" />
                <CopyButton value={preparedIdentity.agentURI} label="Copy registration profile URI" />
                <p className="text-muted-foreground">
                  Mint once from your wallet. Reconcile its receipt; do not retry an uncertain send. Import the confirmed ID in Identity.
                </p>
              </div>
            )}
          </>
        )}
        {stage === 2 && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel className="flex-col items-stretch">
                  <span>{'Stable service ID'}</span>
                  <Input
                    maxLength={64}
                    placeholder="web-research"
                    value={draft.ad.serviceId}
                    onChange={(event) => setAd({ serviceId: event.target.value })}
                  />
                </FieldLabel>
              </Field>
              <Field>
                <FieldLabel className="flex-col items-stretch">
                  <span>{'Service name'}</span>
                  <Input maxLength={100} value={draft.ad.name} onChange={(event) => setAd({ name: event.target.value })} />
                </FieldLabel>
              </Field>
            </div>

            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'What you offer'}</span>
                <Textarea maxLength={2000} value={draft.ad.description} onChange={(event) => setAd({ description: event.target.value })} />
              </FieldLabel>
            </Field>

            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'Inputs required'}</span>
                <Textarea maxLength={2000} value={draft.ad.inputs} onChange={(event) => setAd({ inputs: event.target.value })} />
              </FieldLabel>
            </Field>

            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'Outputs delivered'}</span>
                <Textarea maxLength={2000} value={draft.ad.outputs} onChange={(event) => setAd({ outputs: event.target.value })} />
              </FieldLabel>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel className="flex-col items-stretch">
                  <span>{'Price model'}</span>
                  <Select
                    value={draft.ad.price.model}
                    onChange={(event) => setPrice({ model: event.target.value as ServiceAdvertisement['price']['model'] })}
                  >
                    {['fixed', 'per-unit', 'quote', 'free/testnet'].map((model) => (
                      <option key={model}>{model}</option>
                    ))}
                  </Select>
                </FieldLabel>
              </Field>
              <Field>
                <FieldLabel className="flex-col items-stretch">
                  <span>{'Amount in base units'}</span>
                  <Input
                    value={draft.ad.price.amountBaseUnits}
                    inputMode="numeric"
                    onChange={(event) => setPrice({ amountBaseUnits: event.target.value })}
                  />
                </FieldLabel>
              </Field>
            </div>

            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'Reward token address'}</span>
                <Input value={draft.ad.price.token} onChange={(event) => setPrice({ token: event.target.value as Address })} />
              </FieldLabel>
              <FieldDescription>{`Chain ${chain.id}. Token metadata is unverified; this is a price preference, not escrow.`}</FieldDescription>
            </Field>

            <Field>
              <FieldLabel className="flex-col items-stretch">
                <span>{'Estimated turnaround, seconds'}</span>
                <Input
                  type="number"
                  min={1}
                  max={2592000}
                  value={draft.ad.turnaroundSeconds}
                  onChange={(event) => setAd({ turnaroundSeconds: Number(event.target.value) })}
                />
              </FieldLabel>
              <FieldDescription>{'An operator estimate, not a measured performance claim.'}</FieldDescription>
            </Field>
          </>
        )}
        {stage === 3 && (
          <>
            <div className="grid gap-2 rounded-xl bg-muted p-4 text-sm">
              <span className="flex items-center gap-2 font-semibold">
                <Sparkles aria-hidden className="size-4 text-primary" />
                {draft.profile.name || 'Unnamed worker'}
              </span>
              <span>Agent #{draft.agentId || 'not imported'}</span>
              <span>
                {draft.ad.name || 'No service'} · {draft.ad.price.model} · {draft.ad.price.amountBaseUnits} base units
              </span>
              <span className="break-all">Signer: {account.address ?? 'connect your wallet first'}</span>
              <span>Ad expiry: 24 hours. Manual heartbeat: 60 seconds. No unattended delegate is created by this web flow.</span>
            </div>

            <p className="text-sm text-muted-foreground">
              The next steps close this sheet before opening your wallet. You explicitly sign enrollment, then the ad, then an optional
              heartbeat. Connect the current agent wallet on {chain.name}.
            </p>

            <Button
              disabled={account.address === undefined || account.chainId !== chain.id || !validId || !validProfile || !validAd}
              onClick={preparePublication}
            >
              Review wallet signatures
            </Button>
          </>
        )}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-between gap-3">
          <Button variant="secondary" disabled={stage === 0 || busy} onClick={() => setStage((value) => value - 1)}>
            Back
          </Button>
          {stage < 3 && (
            <Button
              disabled={busy || (stage === 1 && !validProfile) || (stage === 2 && !validAd)}
              onClick={() => setStage((value) => value + 1)}
            >
              Continue
            </Button>
          )}
        </div>
      </Sheet>
    </>
  )
}
