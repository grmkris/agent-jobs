/* Sidequest board widget: jobs (default) or one task. Attributes: board, view, taskId,
 * jobId, wallet, theme, accent, explore, height. Events: ready, signed-in, approved,
 * rejected, cancelled, disputed, settled, error, resize. Listen with Sidequest.on(type, fn).
 */
;(() => {
  const script = document.currentScript
  if (script === null) return
  const ds = script.dataset
  const base = (ds.explore || new URL(script.src).origin).replace(/\/$/, '')
  const board = ds.board || 'public'
  const view = ds.view || 'jobs'
  const params = new URLSearchParams()
  for (const k of ['taskId', 'wallet', 'theme']) if (ds[k]) params.set(k, ds[k])
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
  const target = view === 'task' && ds.jobId ? `${base}/b/${board}/job/${ds.jobId}` : `${base}/b/${board}`
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
