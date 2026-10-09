import { Badge } from '../components/ui/badge.tsx'
import { Button, buttonVariants } from '../components/ui/button.tsx'
import { Alert, AlertDescription } from '../components/ui/alert.tsx'
import { Details, LoadingRows, Section } from '../components/kit.tsx'
import { LaunchNotice } from '../components/LaunchGate.tsx'
import { cn } from '../lib/cn.ts'
import { useQueryClient } from '@tanstack/react-query'
import { Bell, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSignMessage } from 'wagmi'
import { walletRefused } from '../components/txOperation.ts'
import { SignIn } from '../components/SignIn.tsx'
import { ConfirmSheet, useToast } from '../components/Sheet.tsx'
import { Countdown, When, useNow } from '../components/Time.tsx'

import { useAuth } from '../components/Wallet.tsx'
import {
  TELEGRAM_BOT,
  TELEGRAM_NOTICES,
  type TelegramLinkPrep,
  deepLink,
  linkMessageProblem,
  pendingLink,
  telegramApi,
  useTelegramStatus,
} from '../telegram.ts'
import { friendlyError } from '../txErrors.ts'
import { writesOpen } from '../wallet.ts'

/**
 * Link Telegram (U7): the board mints a one-time code, the wallet signs a text naming itself and the code, and the
 * bot's `/start <code>` ties the chat to the wallet. The page polls until the bot has done it. One card: the chat's
 * state, the one action it needs, and what the bot sends, folded away.
 */
export function TelegramSection() {
  const auth = useAuth()
  if (!writesOpen)
    return (
      <Section title="Telegram">
        <LaunchNotice />
      </Section>
    )
  if (auth.address === undefined || !auth.signedIn) {
    return (
      <Section title="Telegram">
        <div className="grid gap-3 rounded-2xl bg-card p-4">
          <p className="font-medium">Sign in to link Telegram</p>
          <SignIn auth={auth} />
        </div>
      </Section>
    )
  }
  return (
    <Section title="Telegram">
      <TelegramLink key={auth.address} wallet={auth.address} />
    </Section>
  )
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
      <div className="grid gap-4 rounded-2xl bg-card p-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-full',
              linked ? 'bg-success/12 text-success-text' : 'bg-primary/12 text-primary',
            )}
          >
            <Send aria-hidden className="size-4" />
          </span>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="font-medium">
              {!linked ? 'Telegram' : status.data?.username == null ? 'Your Telegram chat' : `@${status.data.username}`}
            </p>
            <p className="text-ui leading-snug text-muted-foreground">
              {linked && status.data?.linkedAt != null ? (
                <>
                  Linked <When at={status.data.linkedAt} show="relative" />. The bot messages you when a job needs you.
                </>
              ) : (
                'A private message from the bot when a job needs you.'
              )}
            </p>
          </div>
          {linked && <Badge variant="success">On</Badge>}
        </div>

        {status.isLoading ? (
          <LoadingRows rows={1} />
        ) : status.isError ? (
          <div role="status" className="grid gap-2 rounded-xl bg-warning/14 p-4 text-sm text-warning-text">
            <p>Whether Telegram is linked cannot be read right now.</p>
            <Button variant="secondary" onClick={() => void status.refetch()}>
              Retry
            </Button>
          </div>
        ) : linked ? null : waiting && link !== null ? (
          <div className="grid gap-3">
            <a href={link} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: 'lg' })}>
              <Send aria-hidden data-icon="inline-start" />
              Open @{TELEGRAM_BOT}
            </a>
            <p role="status" className="text-center text-sm text-muted-foreground">
              Press Start in the chat; this page updates once the bot has linked your wallet. The code expires in{' '}
              <Countdown to={pending.expiresAt} />.
            </p>
            <Button variant="link" onClick={forget}>
              Start again
            </Button>
          </div>
        ) : (
          <div className="grid gap-2">
            {pending !== null && (
              <p className="text-sm text-warning-text">
                The last code expired before the bot used it. Link again for a new one.
              </p>
            )}
            <Button busy={busy === 'prepare'} onClick={() => void start()}>
              Link Telegram
            </Button>
            <p className="text-ui leading-snug text-muted-foreground">
              Your wallet signs a short text to show the chat is yours. It costs nothing and allows nothing else.
            </p>
          </div>
        )}

        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Details summary="What the bot tells you" className="bg-muted/40 ring-0">
          <ul className="grid gap-2 px-4 pb-3 text-sm">
            {TELEGRAM_NOTICES.map((n) => (
              <li key={n} className="flex items-center gap-2">
                <Bell aria-hidden className="size-4 shrink-0 text-primary" />
                {n}
              </li>
            ))}
          </ul>
        </Details>

        {linked && (
          <Button
            variant="link"
            className="justify-self-start px-0 text-destructive-text"
            busy={busy === 'unlink'}
            onClick={() => setUnlinking(true)}
          >
            Unlink Telegram
          </Button>
        )}
      </div>

      <ConfirmSheet
        open={prep !== null}
        onClose={() => setPrep(null)}
        title="Sign to link Telegram?"
        description="Your wallet signs this text. It costs nothing and gives no access to your funds."
        confirm="Sign"
        busy={busy === 'sign'}
        onConfirm={() => void sign()}
      >
        <Details summary="Technical details">
          <pre className="max-h-48 overflow-auto rounded-xl bg-muted p-3 font-mono text-ui leading-snug whitespace-pre-wrap break-all">
            {prep?.message}
          </pre>
        </Details>
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
