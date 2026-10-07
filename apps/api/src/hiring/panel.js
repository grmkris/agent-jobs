/* oxlint-disable unicorn/consistent-function-scoping -- Keep the inline App isolated from host globals. */
// Portable MCP Apps bridge. All state is in memory; opaque-origin frames have no storage.
;(() => {
  const el = (id) => document.getElementById(id)
  const content = el('content')
  const status = el('status')
  const confirmation = el('confirmation')
  let sequence = 0
  let capabilities = {}
  let current
  let operation
  const pending = new Map()
  const send = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*')
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Response uncertain. Reconcile or retry the identical action.'))
      }, 125000)
      pending.set(id, { resolve, reject, timer })
      send({ id, method, params })
    })
  const node = (tag, text, cls) => {
    const item = document.createElement(tag)
    if (text !== undefined) item.textContent = String(text)
    if (cls) item.className = cls
    return item
  }
  const button = (label, action, disabled = false) => {
    const item = node('button', label)
    item.type = 'button'
    item.disabled = disabled
    item.addEventListener('click', action)
    return item
  }
  const readable = (value) =>
    value === undefined || value === null
      ? 'Unavailable'
      : typeof value === 'object'
        ? JSON.stringify(value, null, 2)
        : String(value)
  const detail = (parent, label, value) => {
    const item = node('div', undefined, 'fact')
    item.append(node('dt', label), node('dd', readable(value)))
    parent.append(item)
  }
  const date = (value) =>
    typeof value === 'number' ? `${new Date(value * 1000).toISOString()} (${value})` : 'Unavailable'
  const toolResult = (result) => {
    if (result.structuredContent) return result.structuredContent
    const text = (result.content || []).find((block) => block.type === 'text')
    if (!text) throw new Error('The server returned no display data.')
    return JSON.parse(text.text)
  }
  const resize = () =>
    send({
      method: 'ui/notifications/size-changed',
      params: { height: document.documentElement.scrollHeight, width: window.innerWidth },
    })
  function hostContext(context = {}) {
    if (context.theme) document.documentElement.dataset.theme = context.theme
    for (const [key, value] of Object.entries(context.styles?.variables || {})) {
      if (key.startsWith('--')) document.documentElement.style.setProperty(key, value)
    }
  }
  async function load(name, args = {}) {
    if (!capabilities.serverTools) return
    status.textContent = 'Reading current chain and board facts…'
    try {
      render(toolResult(await request('tools/call', { name, arguments: args })))
    } catch (error) {
      status.textContent = error.message
    }
  }
  function indicators(parent, item) {
    const facts = node('dl', undefined, 'facts')
    detail(facts, 'Chain', item.chain?.status || 'No hire yet')
    detail(facts, 'Funding', item.funding?.state || 'unknown')
    detail(facts, 'Operation', item.operationStatus || 'No operation reported')
    parent.append(facts)
    if (item.chain?.paused) parent.append(node('p', 'Core paused · actions unavailable', 'notice'))
    if (item.nextAction)
      parent.append(
        node(
          'p',
          `Next: ${item.nextAction.actor} · ${item.nextAction.action} · ${date(item.nextAction.deadline)}`,
          'next',
        ),
      )
  }
  function exactTerms(parent, item, extra = {}) {
    const facts = node('dl', undefined, 'facts')
    const terms = item.terms || item
    for (const [label, value] of Object.entries({
      'Terms hash': item.termsHash,
      'Reward asset': extra.assetAddress || item.rewardAsset,
      Reward: extra.amount || item.reward,
      'Amount unit': extra.amount ? 'display units' : 'base units',
      Creator: item.creator,
      Worker: extra.worker || item.worker,
      Approver: item.approver || terms.approver,
      Arbitrator: item.arbitrator || terms.arbitrator,
      'Creator bond (base units)': item.creatorBond || terms.creatorBond,
      'Worker bond (base units)': item.workerBond || terms.workerBond,
      Windows: item.windows || terms.windows,
      'Delivery deadline': date(item.deliveryDeadline || terms.deliveryDeadline),
      'Acceptance criteria': terms.acceptanceCriteria,
      'Execution budget': terms.executionBudget || 'None',
      ...extra,
    }))
      detail(facts, label, value)
    parent.append(facts)
  }
  function propose(name, args, item, extra = {}) {
    if (operation?.uncertain || operation?.sending || operation?.awaiting) {
      status.textContent = 'Resolve the existing operation before starting another action.'
      return
    }
    confirmation.replaceChildren(node('h2', `Confirm ${name}`))
    confirmation.hidden = false
    exactTerms(confirmation, item, extra)
    const freshKey =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const exactArgs = { ...args, operationKey: `app-${freshKey}` }
    confirmation.append(node('pre', JSON.stringify(exactArgs, null, 2)))
    confirmation.append(
      node('p', 'This invokes the hosted executor. The server and operator approval decide whether it proceeds.'),
    )
    confirmation.append(
      button('Confirm these terms', () => {
        operation = { name, args: exactArgs, item, extra }
        confirmation.hidden = true
        execute()
      }),
      button('Cancel', () => {
        confirmation.hidden = true
      }),
    )
    resize()
  }
  async function execute() {
    if (!operation || operation.sending) return
    operation.sending = true
    el('retry').hidden = true
    status.textContent = 'Awaiting the executor response…'
    try {
      const result = toolResult(await request('tools/call', { name: operation.name, arguments: operation.args }))
      const reply = result.result || result
      operation.sending = false
      operation.uncertain = false
      operation.awaiting = ['pending', 'approval'].includes(reply.status)
      status.replaceChildren(
        node('strong', reply.status || result.code || 'Server response'),
        node('pre', JSON.stringify(result, null, 2)),
      )
      // Every displayed hosted state above comes verbatim from this response.
      if (reply.status === 'approval' && typeof reply.approveUrl === 'string') {
        try {
          const url = new URL(reply.approveUrl)
          if (url.protocol === 'https:') {
            if (capabilities.openLinks)
              status.append(
                button('Open operator approval', () =>
                  request('ui/open-link', { url: url.href }).catch((error) => {
                    status.append(node('p', error.message))
                  }),
                ),
              )
            else status.append(node('p', `Operator approval: ${url.href}`))
          }
        } catch {
          /* An invalid link remains visible only in the server response. */
        }
      }
      if (operation.awaiting || ['same-key', 'after-operator'].includes(result.retry)) el('retry').hidden = false
    } catch (error) {
      operation.sending = false
      operation.uncertain = true
      status.textContent = error.message
      el('retry').hidden = false
    }
    resize()
  }
  function quotes(parent, item) {
    for (const quote of item.quotes || []) {
      const card = node('article', undefined, 'quote')
      card.append(
        node('h3', `Agent ${quote.agentId}`),
        node('p', `${quote.amount} ${quote.symbol || quote.assetAddress}`),
        node('p', quote.note),
      )
      const facts = node('dl', undefined, 'facts')
      detail(facts, 'Worker', quote.worker)
      detail(facts, 'Declared costs', quote.expectedCosts)
      detail(facts, 'Quote hash', quote.quoteHash)
      card.append(facts)
      if (!item.taskId)
        card.append(
          button(
            'Choose this quote',
            () =>
              propose('pick_quote', { requestId: item.requestId, quoteId: quote.quoteId }, item, {
                assetAddress: quote.assetAddress,
                amount: quote.amount,
                worker: quote.worker,
                quoteHash: quote.quoteHash,
                'Execution budget': 'None',
              }),
            !capabilities.serverTools || !String(item.status).startsWith('Accepting'),
          ),
        )
      parent.append(card)
    }
  }
  function taskDetail(task) {
    content.append(node('h1', task.title || task.taskId))
    indicators(content, task)
    exactTerms(content, task)
    const comparison = node('section', undefined, 'comparison')
    const criteria = node('article')
    criteria.append(
      node('h2', 'Acceptance criteria'),
      node('pre', readable(task.terms?.acceptanceCriteria)),
      node('p', readable(task.terms?.brief)),
    )
    const delivery = node('article')
    delivery.append(
      node('h2', 'Submitted delivery'),
      node('pre', readable(task.onchainSubmission)),
      node('pre', readable(task.deliverables)),
      node('p', 'The on-chain submission identifies the paid delivery. Candidate records are supporting evidence.'),
    )
    comparison.append(criteria, delivery)
    content.append(comparison)
    const actions = node('div', undefined, 'actions')
    const roles = task.you || []
    const unavailable =
      !capabilities.serverTools || task.chain?.paused || !!operation?.uncertain || !!operation?.awaiting
    if (roles.includes('creator') && task.nextAction?.action === 'select_worker') {
      for (const applicant of task.applications || []) {
        actions.append(
          button(
            `Select agent ${applicant.agent_id}`,
            () => {
              const activateBy = Math.min(Math.floor(Date.now() / 1000) + 86400, task.deliveryDeadline - 60)
              propose('select_worker', { taskId: task.taskId, applicationId: applicant.id, activateBy }, task, {
                worker: applicant.worker,
                activateBy: date(activateBy),
              })
            },
            unavailable,
          ),
        )
      }
    }
    if (roles.includes('approver') && task.nextAction?.action === 'approve_or_reject') {
      actions.append(
        button('Accept submitted work', () => propose('approve_work', { taskId: task.taskId }, task), unavailable),
      )
      const violation = node('select')
      violation.setAttribute('aria-label', 'Rejection violation')
      for (const name of ['None', 'Quality', 'Falsified']) {
        const option = node('option', name)
        option.value = name
        violation.append(option)
      }
      const reason = node('textarea')
      reason.setAttribute('aria-label', 'Published rejection reason')
      reason.placeholder = 'Explain against the published criteria'
      reason.maxLength = 4000
      actions.append(
        violation,
        reason,
        button(
          'Review rejection',
          () => {
            if (!reason.value.trim()) {
              status.textContent = 'A published rejection reason is required.'
              return
            }
            propose('reject_work', { taskId: task.taskId, violation: violation.value, reason: reason.value }, task)
          },
          unavailable,
        ),
      )
    }
    content.append(actions, node('h2', 'Quote comparison'))
    quotes(content, task)
  }
  function render(reply) {
    if (!reply.ok) {
      status.textContent = reply.message || 'Hiring data unavailable'
      return
    }
    current = reply.result
    content.replaceChildren()
    status.textContent = 'Current chain and board facts. Refresh after an operation to read funding again.'
    if (current.view === 'task') taskDetail(current.task)
    else {
      content.append(node('h1', 'Your hiring desk'))
      for (const [stage, items] of Object.entries(current.groups || {})) {
        const section = node('section', undefined, 'stage')
        section.append(node('h2', `${stage} · ${items.length}`))
        if (!items.length) section.append(node('p', 'Nothing here yet.', 'muted'))
        for (const item of items) {
          const card = node('article', undefined, 'card')
          card.append(node('h3', item.title || item.taskId || item.requestId))
          indicators(card, item)
          if (item.taskId)
            card.append(
              button('Read hire', () => load('show_task', { taskId: item.taskId }), !capabilities.serverTools),
            )
          else {
            exactTerms(card, item)
            quotes(card, item)
          }
          section.append(card)
        }
        content.append(section)
      }
      content.append(
        node(
          'p',
          `Newest ${current.hireLimit} hires shown. Read linked request history and use list_quote_requests to page older requests.`,
          'muted',
        ),
      )
      if (current.nextRequestCursor) content.append(node('p', `More requests: ${current.nextRequestCursor}`))
    }
    resize()
  }
  window.addEventListener('message', (event) => {
    // The parent is opaque in Goblin: authenticate the sender window, never the origin string.
    if (event.source !== window.parent || !event.data || event.data.jsonrpc !== '2.0') return
    const message = event.data
    if (pending.has(message.id)) {
      const wait = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(wait.timer)
      if (message.error) wait.reject(new Error(message.error.message))
      else wait.resolve(message.result)
    } else if (message.method === 'ui/notifications/tool-result') {
      try {
        render(toolResult(message.params))
      } catch (error) {
        status.textContent = error.message
      }
    } else if (message.method === 'ui/notifications/host-context-changed') hostContext(message.params)
    else if (message.method === 'ui/notifications/tool-input') status.textContent = 'Reading the requested hiring view…'
    else if (message.method === 'ui/resource-teardown') {
      for (const wait of pending.values()) {
        clearTimeout(wait.timer)
        wait.reject(new Error('View closed; reconcile the original operation before retry.'))
      }
      pending.clear()
      send({ id: message.id, result: {} })
    }
  })
  el('retry').addEventListener('click', execute)
  el('refresh').addEventListener('click', () =>
    load(
      current?.view === 'task' ? 'show_task' : 'show_hiring_dashboard',
      current?.view === 'task' ? { taskId: current.task.taskId } : {},
    ),
  )
  el('dashboard').addEventListener('click', () => load('show_hiring_dashboard'))
  el('context').addEventListener('click', () => {
    if (capabilities.updateModelContext && current)
      request('ui/update-model-context', {
        content: [{ type: 'text', text: JSON.stringify(current).slice(0, 7900) }],
      }).catch((error) => {
        status.textContent = error.message
      })
  })
  el('fullscreen').addEventListener('click', () =>
    request('ui/request-display-mode', { mode: 'fullscreen' }).catch((error) => {
      status.textContent = error.message
    }),
  )
  request('ui/initialize', {
    appInfo: { name: 'Sidequest hiring desk', version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    protocolVersion: '2026-01-26',
  })
    .then((result) => {
      capabilities = result.hostCapabilities || {}
      hostContext(result.hostContext)
      send({ method: 'ui/notifications/initialized' })
      el('context').hidden = !capabilities.updateModelContext
      el('fullscreen').hidden = !result.hostContext?.availableDisplayModes?.includes('fullscreen')
      el('refresh').disabled = el('dashboard').disabled = !capabilities.serverTools
      if (!current) status.textContent = 'Connected. Waiting for hiring data…'
    })
    .catch((error) => {
      status.textContent = error.message
    })
})()
