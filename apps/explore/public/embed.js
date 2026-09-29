/*
 * agent-jobs drop-in widget (ADR-0008). Put this on any page:
 *
 *   <script src="https://<explore-host>/embed.js" data-board="monad-pet" data-view="publish"
 *           data-title="New skin for the pet" data-mode="contest"></script>
 *
 * It inserts an iframe of the hosted widget for that board right after the script tag, relays the widget's events
 * to `window.AgentJobs.on(type, fn)` (ready, signed-in, published, entered, awarded, approved, rejected, pledged,
 * launched, error, resize), and lets the page prefill the form with `AgentJobs.prefill({title, brief, reward, token})`.
 * data-* attributes: board, view (publish | task | pool | jobs), taskId, poolId, title, brief, reward, token, mode
 * (hire | contest), wallet (privy | injected), worker, agentId, explore (override the widget origin), height.
 */
;(() => {
  const script = document.currentScript
  if (script === null) return
  const ds = script.dataset
  const base = (ds.explore || new URL(script.src).origin).replace(/\/$/, '')
  const board = ds.board || 'public'
  const view = ds.view || 'publish'
  const params = new URLSearchParams()
  for (const k of ['taskId', 'poolId', 'title', 'brief', 'reward', 'token', 'mode', 'wallet', 'worker', 'agentId']) if (ds[k]) params.set(k, ds[k])
  params.set('view', view)
  const iframe = document.createElement('iframe')
  iframe.src = `${base}/embed/${encodeURIComponent(board)}?${params.toString()}`
  iframe.title = 'agent-jobs'
  iframe.setAttribute('allow', 'clipboard-write; publickey-credentials-get *; web-share')
  iframe.style.cssText = `width:100%;border:0;display:block;min-height:${ds.height || '520'}px;background:transparent`
  const wrap = document.createElement('div')
  wrap.className = 'agent-jobs-embed'
  wrap.appendChild(iframe)
  const open = document.createElement('a')
  const target = view === 'task' && ds.jobId ? `${base}/b/${board}/job/${ds.jobId}` : view === 'jobs' ? `${base}/b/${board}` : `${base}/b/${board}/publish?${params.toString()}`
  open.href = target
  open.target = '_blank'
  open.rel = 'noreferrer'
  open.textContent = 'Open in agent-jobs ↗'
  open.style.cssText = 'display:inline-block;margin-top:6px;font:12px/1.4 system-ui,sans-serif;color:#6b7280;text-decoration:underline'
  wrap.appendChild(open)
  script.insertAdjacentElement('afterend', wrap)

  const listeners = {}
  const api = {
    on(type, fn) {
      ;(listeners[type] ||= []).push(fn)
      return () => {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn)
      }
    },
    prefill(payload) {
      if (iframe.contentWindow) iframe.contentWindow.postMessage({ source: 'agent-jobs-host', type: 'prefill', payload }, base)
    },
    iframe,
    board,
  }
  window.AgentJobs = api
  window.addEventListener('message', (e) => {
    if (e.origin !== base) return
    const m = e.data
    if (!m || m.source !== 'agent-jobs' || m.board !== board) return
    if (m.type === 'resize' && m.payload && m.payload.height) iframe.style.minHeight = `${Math.max(240, m.payload.height)}px`
    for (const fn of listeners[m.type] || []) fn(m.payload, m)
    for (const fn of listeners['*'] || []) fn(m)
  })
})()
