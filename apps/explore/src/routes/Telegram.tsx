import { useQueryClient } from '@tanstack/react-query'
import { Bell, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { walletRefused } from '../components/txOperation.ts'
import { SignInToPublish } from '../components/post/SignInToPublish.tsx'
import { ConfirmSheet, useToast } from '../components/Sheet.tsx'
import { Countdown, When, useNow } from '../components/Time.tsx'
import { Badge, Button, ErrorText, Group, ListRow, LoadingRows, PageTitle, Section } from '../components/ui.tsx'
import { useAuth } from '../components/Wallet.tsx'
import { TELEGRAM_BOT, TELEGRAM_NOTICES, type TelegramLinkPrep, deepLink, linkMessageProblem, pendingLink, telegramApi, useTelegramStatus } from '../telegram.ts'
import { friendlyError } from '../txErrors.ts'

const SUB = 'A message from the bot when a job needs you.'

/**
 * Link Telegram (U7): the board mints a one-time code, the wallet signs a text naming itself and the code, and the
 * bot's `/start <code>` ties the chat to the wallet. The page polls until the bot has done it.
 */
export function TelegramPage() {
  const auth = useAuth()
  if (auth.address === undefined || !auth.signedIn) {
    return (
      <>
        <PageTitle sub={SUB}>Telegram</PageTitle>
        <section className="grid gap-4 rounded-2xl bg-surface p-5 shadow-float">
          <h2 className="font-display text-[1.4rem] leading-tight font-bold tracking-[-0.02em]">Sign in to link Telegram</h2>
          <SignInToPublish auth={auth} label="Sign in" />
        </section>
      </>
    )
  }
  return <TelegramLink wallet={auth.address} />
}

function TelegramLink({ wallet }: { wallet: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const now = useNow()
  const { signMessageAsync } = useSignMessage()
  // Read on every render, so a code saved before the trip to Telegram is still here when the PWA comes back.
  const [, rerender] = useState(0)
  const pending = pendingLink.load(wallet)
  const waiting = pending !== null && pending.expiresAt > now
  const status = useTelegramStatus(wallet, true, waiting)
  const [prep, setPrep] = useState<TelegramLinkPrep | null>(null)
  const [busy, setBusy] = useState<'prepare' | 'sign' | 'unlink' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unlinking, setUnlinking] = useState(false)
  const linked = status.data?.linked === true

  const forget = () => {
    pendingLink.clear(wallet)
    rerender((n) => n + 1)
  }
  useEffect(() => {
    if (!linked || pendingLink.load(wallet) === null) return
    pendingLink.clear(wallet)
    rerender((n) => n + 1)
    toast('Telegram linked')
  }, [linked, wallet, toast])

  const start = async () => {
    setBusy('prepare')
    setError(null)
    try {
      const p = await telegramApi.prepare(wallet)
      const problem = linkMessageProblem(p, wallet)
      if (problem !== null) setError(problem)
      else setPrep(p)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }
  const sign = async () => {
    if (prep === null) return
    setBusy('sign')
    setError(null)
    try {
      const signature = await signMessageAsync({ message: prep.message })
      await telegramApi.confirm(prep.nonce, signature)
      pendingLink.save(wallet, { nonce: prep.nonce, expiresAt: prep.expiresAt })
      setPrep(null)
      rerender((n) => n + 1)
    } catch (e) {
      setPrep(null)
      setError(walletRefused(e) ? 'You declined to sign. Nothing was linked.' : friendlyError(e))
    } finally {
      setBusy(null)
    }
  }
  const unlink = async () => {
    setBusy('unlink')
    setError(null)
    try {
      await telegramApi.unlink(wallet)
      setUnlinking(false)
      await qc.invalidateQueries({ queryKey: ['telegram_status'] })
      toast('Telegram unlinked')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(null)
    }
  }

  const link = pending === null ? null : deepLink(pending.nonce)
  return (
    <>
      <PageTitle sub={SUB}>Telegram</PageTitle>
      {status.isLoading ? (
        <LoadingRows rows={2} />
      ) : status.isError ? (
        <div role="status" className="grid gap-2 rounded-xl bg-warn-bg p-4 text-[0.9rem] text-warn">
          <p>Whether Telegram is linked cannot be read right now.</p>
          <Button variant="tinted" onClick={() => void status.refetch()}>Retry</Button>
        </div>
      ) : linked ? (
        <Section title="Linked">
          <Group>
            <ListRow inset>
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-ok-bg text-ok">
                <Send aria-hidden className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{status.data?.username == null ? 'Your Telegram chat' : `@${status.data.username}`}</span>
                {status.data?.linkedAt != null && (
                  <span className="block text-[0.85rem] text-label-2">
                    Linked <When at={status.data.linkedAt} show="relative" />
                  </span>
                )}
              </span>
              <Badge tone="success">On</Badge>
            </ListRow>
          </Group>
        </Section>
      ) : waiting && link !== null ? (
        <Section title="Open Telegram" note="Press Start in the chat. This page updates once the bot has linked your wallet.">
          <div className="grid gap-3 rounded-2xl bg-surface p-4">
            <a href={link} target="_blank" rel="noopener noreferrer" className="press inline-flex min-h-[3.125rem] items-center justify-center gap-2 rounded-2xl bg-tint px-5 text-base font-semibold text-on-tint">
              <Send aria-hidden className="size-4" />
              Open @{TELEGRAM_BOT}
            </a>
            <p role="status" className="text-center text-[0.88rem] text-label-2">
              Waiting for Telegram. The code expires in <Countdown to={pending.expiresAt} />.
            </p>
            <Button variant="plain" onClick={forget}>
              Start again
            </Button>
          </div>
        </Section>
      ) : (
        <div className="grid gap-2">
          {pending !== null && <p className="px-4 text-[0.88rem] text-warn">The last code expired before the bot used it. Link again for a new one.</p>}
          <Button size="lg" busy={busy === 'prepare'} onClick={() => void start()}>
            Link Telegram
          </Button>
          <p className="px-4 text-[0.85rem] leading-snug text-label-2">Your wallet signs a short text to show the chat is yours. It costs nothing and allows nothing else.</p>
        </div>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}

      <Section title="What the bot tells you" note={linked ? undefined : 'Only about jobs you are part of. New requests go to the public channel.'}>
        <Group>
          {TELEGRAM_NOTICES.map((n) => (
            <ListRow key={n} inset>
              <Bell aria-hidden className="size-4 shrink-0 text-tint" />
              <span className="flex-1">{n}</span>
            </ListRow>
          ))}
        </Group>
      </Section>
      {linked && (
        <Button variant="danger" busy={busy === 'unlink'} onClick={() => setUnlinking(true)}>
          Unlink Telegram
        </Button>
      )}

      <ConfirmSheet
        open={prep !== null}
        onClose={() => setPrep(null)}
        title="Sign to link Telegram?"
        description="Your wallet signs this text. It costs nothing and gives no access to your funds."
        confirm="Sign"
        busy={busy === 'sign'}
        onConfirm={() => void sign()}
      >
        <pre className="max-h-48 overflow-auto rounded-xl bg-fill p-3 font-mono text-[0.8rem] leading-snug whitespace-pre-wrap break-all">{prep?.message}</pre>
      </ConfirmSheet>
      <ConfirmSheet
        open={unlinking}
        onClose={() => setUnlinking(false)}
        title="Unlink Telegram?"
        description="The bot stops messaging you about your jobs. You can link again at any time."
        confirm="Unlink"
        tone="destructive"
        busy={busy === 'unlink'}
        onConfirm={() => void unlink()}
      />
    </>
  )
}
