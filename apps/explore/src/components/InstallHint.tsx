/**
 * How to install Hireling as an app, only where it works and only until it is installed or dismissed: Safari on an
 * iPhone or iPad (Share → Add to Home Screen) and Safari on a Mac (File → Add to Dock). There is no install prompt on
 * Apple platforms, so this is a hint, not a button.
 */
import { Share, X } from 'lucide-react'
import { useState } from 'react'

const KEY = 'hireling.install-hint-dismissed'

function platform(): 'ios' | 'mac' | null {
  const nav = window.navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches) return null
  const ua = nav.userAgent
  const safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Edg\//.test(ua)
  if (!safari) return null
  const touchMac = /Macintosh/.test(ua) && nav.maxTouchPoints > 1
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) return 'ios'
  if (/Macintosh/.test(ua)) return 'mac'
  return null
}

export function InstallHint() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== null
    } catch {
      return false
    }
  })
  const where = platform()
  if (dismissed || where === null) return null
  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      // storage blocked: hidden for this page view
    }
  }
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-tint/10 px-4 py-3.5">
      <Share aria-hidden className="mt-0.5 size-5 shrink-0 text-tint" />
      <p className="flex-1 text-[0.92rem] leading-snug">
        <span className="font-semibold">Install Hireling as an app.</span>{' '}
        {where === 'ios' ? (
          <>In Safari, tap Share, then Add to Home Screen. It opens full screen; sign in once inside the app.</>
        ) : (
          <>In Safari, choose File, then Add to Dock.</>
        )}
      </p>
      <button type="button" aria-label="Dismiss" onClick={dismiss} className="grid size-7 shrink-0 place-items-center rounded-full text-label-3 active:bg-fill">
        <X className="size-4" />
      </button>
    </div>
  )
}
