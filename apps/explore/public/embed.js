/*
 * sidequest drop-in widget (ADR-0008). Put this on any page:
 *
 *   <script src="https://<explore-host>/embed.js" data-board="monad-pet" data-view="publish"
 *           data-title="New skin for the pet"></script>
 *
 * It inserts an iframe of the hosted widget for that board right after the script tag, relays the widget's events
 * to `window.Sidequest.on(type, fn)` (ready, signed-in, published, approved, rejected, cancelled, disputed, settled,
 * error, resize), and lets the page prefill the form with `Sidequest.prefill({title, brief, reward, token})`.
 * data-* attributes: board, view (publish | task | jobs), taskId, jobId (for the "Open in Sidequest" link of a task
 * view), title, brief, reward, token, mode (hire | quotes), wallet (privy | injected), worker, agentId,
 * theme (light | dark | auto: follow the visitor's system, the default), accent (a #rrggbb colour for buttons and
 * links), explore (override the widget origin), height.
 */
;(() => {
  const script = document.currentScript
  if (script === null) return
  const ds = script.dataset
  const base = (ds.explore || new URL(script.src).origin).replace(/\/$/, '')
  const board = ds.board || 'public'
  const view = ds.view || 'publish'
  const params = new URLSearchParams()
  for (const k of ['taskId', 'title', 'brief', 'reward', 'token', 'mode', 'wallet', 'worker', 'agentId', 'theme']) if (ds[k]) params.set(k, ds[k])
  if (ds.accent && /^#?[0-9a-fA-F]{6}$/.test(ds.accent)) params.set('accent', ds.accent.replace(/^#/, ''))
  params.set('view', view)
  const iframe = document.createElement('iframe')
  iframe.src = `${base}/embed/${encodeURIComponent(board)}?${params.toString()}`
  iframe.title = 'Sidequest'
  iframe.setAttribute('allow', 'clipboard-write; publickey-credentials-get *; web-share')
  iframe.style.cssText = `width:100%;border:0;display:block;min-height:${ds.height || '520'}px;background:transparent`
  const wrap = document.createElement('div')
  wrap.className = 'sidequest-embed'
  wrap.appendChild(iframe)
  const open = document.createElement('a')
  const target = view === 'task' && ds.jobId ? `${base}/b/${board}/job/${ds.jobId}` : view === 'jobs' ? `${base}/b/${board}` : `${base}/b/${board}/publish?${params.toString()}`
  open.href = target
  open.target = '_blank'
  open.rel = 'noreferrer'
  open.textContent = 'Open in Sidequest ↗'
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
      if (iframe.contentWindow) iframe.contentWindow.postMessage({ source: 'sidequest-host', type: 'prefill', payload }, base)
    },
    iframe,
    board,
  }
  window.Sidequest = api
  window.addEventListener('message', (e) => {
    if (e.origin !== base) return
    const m = e.data
    if (!m || m.source !== 'sidequest' || m.board !== board) return
    if (m.type === 'resize' && m.payload && m.payload.height) iframe.style.minHeight = `${Math.max(240, m.payload.height)}px`
    for (const fn of listeners[m.type] || []) fn(m.payload, m)
    for (const fn of listeners['*'] || []) fn(m)
  })
})()
