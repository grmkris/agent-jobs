import { useEffect, useState, useSyncExternalStore } from 'react'

/** At most this many live WebGL shaders per page; the rest draw their CSS stand-in. */
const SHADER_LIMIT = 8

/** A first-come slot store: a released slot goes to the next one waiting. */
export function createShaderBudget(limit: number) {
  let used = 0
  const waiting = new Set<() => boolean>()
  const release = () => {
    used--
    for (const retry of waiting) if (retry()) break
  }
  return {
    /** Calls `granted` with a release function when a slot is free, now or later; returns a cancel. */
    request(granted: (release: () => void) => void): () => void {
      let held = false
      let done = false
      const free = () => {
        if (held && !done) {
          done = true
          release()
        }
      }
      const attempt = () => {
        if (used >= limit) return false
        used++
        held = true
        waiting.delete(attempt)
        granted(free)
        return true
      }
      if (!attempt()) waiting.add(attempt)
      return () => {
        waiting.delete(attempt)
        free()
      }
    },
    get used() {
      return used
    },
  }
}

const budget = createShaderBudget(SHADER_LIMIT)

let webgl2: boolean | undefined
/** Whether this browser can run the shaders at all; the probe's context is released at once. */
function canRunShaders(): boolean {
  if (webgl2 !== undefined) return webgl2
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    webgl2 = gl !== null
  } catch {
    webgl2 = false
  }
  return webgl2
}

/** True while this component holds one of the page's live shader slots. */
export function useShaderSlot(wanted: boolean): boolean {
  const [granted, setGranted] = useState(false)
  useEffect(() => {
    if (!wanted || !canRunShaders()) return
    let release: (() => void) | undefined
    const cancel = budget.request((free) => {
      release = free
      setGranted(true)
    })
    return () => {
      cancel()
      release?.()
      setGranted(false)
    }
  }, [wanted])
  return granted
}

const REDUCE = '(prefers-reduced-motion: reduce)'
/** Motion stops when the person asks for less of it; a stopped shader draws one frame and runs no loop. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (change) => {
      const query = matchMedia(REDUCE)
      query.addEventListener('change', change)
      return () => query.removeEventListener('change', change)
    },
    () => matchMedia(REDUCE).matches,
    () => true,
  )
}
