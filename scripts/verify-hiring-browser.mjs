// Optional real-browser check. Supply a local playwright-core module and Chromium executable; no install or live host.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL(process.argv[2]).href)
const html = JSON.parse(
  readFileSync(new URL('../apps/api/src/generated/hiring.ts', import.meta.url), 'utf8').match(
    /export const hiringHtml = (.*)\n/,
  )[1],
)
const fixture = {
  ok: true,
  result: {
    view: 'task',
    task: {
      taskId: 'local-fixture',
      title: 'Review a public delivery',
      rewardAsset: '0x1111111111111111111111111111111111111111',
      reward: '1000000',
      amountUnit: 'base units',
      creator: '0x2222222222222222222222222222222222222222',
      approver: '0x2222222222222222222222222222222222222222',
      worker: '0x3333333333333333333333333333333333333333',
      arbitrator: '0x4444444444444444444444444444444444444444',
      creatorBond: '0',
      workerBond: '0',
      windows: { review: 3600, dispute: 3600, arbitration: 43200 },
      deliveryDeadline: 2000000000,
      chain: { status: 'submitted', paused: false },
      funding: { state: 'escrowed', source: 'chain' },
      operationStatus: 'confirmed',
      you: ['creator', 'approver'],
      nextAction: { actor: 'approver', action: 'approve_or_reject', deadline: 2000003600 },
      terms: {
        acceptanceCriteria: ['Readable source and public receipt'],
        brief: 'Compare the actual submission with the frozen criteria.',
      },
      deliverables: [{ descriptor: { content: 'A long untrusted delivery '.repeat(30) } }],
      onchainSubmission: { deliverable_hash: '0x' + 'a'.repeat(64) },
      quotes: [],
    },
  },
}
const browser = await chromium.launch({ executablePath: process.argv[3], headless: true, args: ['--no-sandbox'] })
try {
  for (const width of [390, 1200]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.setContent('<!doctype html><body style="margin:0"></body>')
    await page.evaluate(
      ({ html: appHtml, fixture: displayFixture }) => {
        window.calls = []
        window.addEventListener('message', (event) => {
          if (event.data.method === 'ui/initialize')
            event.source.postMessage(
              {
                jsonrpc: '2.0',
                id: event.data.id,
                result: {
                  protocolVersion: '2026-01-26',
                  hostInfo: { name: 'Local test host', version: '1' },
                  hostCapabilities: { serverTools: {}, openLinks: {} },
                  hostContext: { theme: 'light' },
                },
              },
              '*',
            )
          if (event.data.method === 'ui/notifications/initialized')
            event.source.postMessage(
              { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: displayFixture } },
              '*',
            )
          if (event.data.method === 'tools/call') {
            window.calls.push(event.data.params)
            event.source.postMessage(
              {
                jsonrpc: '2.0',
                id: event.data.id,
                result: {
                  structuredContent: {
                    ok: true,
                    result: { status: 'approval', approveUrl: 'https://example.invalid/approval' },
                  },
                },
              },
              '*',
            )
          }
        })
        const frame = document.createElement('iframe')
        frame.sandbox = 'allow-scripts'
        frame.style = 'width:100%;height:900px;border:0'
        frame.srcdoc = appHtml
        document.body.append(frame)
      },
      { html, fixture },
    )
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame()
    await frame.getByRole('heading', { name: fixture.result.task.title }).waitFor()
    const metrics = await frame.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      origin: location.origin,
      criteria: !!document.querySelector('.comparison'),
      htmlBytes: document.documentElement.outerHTML.length,
    }))
    if (metrics.width !== metrics.scrollWidth || metrics.origin !== 'null' || !metrics.criteria)
      throw new Error('opaque-frame-layout-failed')
    await frame.getByRole('button', { name: 'Accept submitted work' }).click()
    if ((await page.evaluate(() => window.calls)).length !== 0) throw new Error('confirmation-bypassed')
    await frame.getByRole('button', { name: 'Confirm these terms' }).click()
    await frame.getByRole('button', { name: 'Open operator approval' }).waitFor()
    await frame.getByRole('button', { name: 'Reconcile / retry identical action' }).click()
    const calls = await page.evaluate(() => window.calls)
    if (calls.length !== 2 || JSON.stringify(calls[0]) !== JSON.stringify(calls[1]))
      throw new Error('same-key-retry-failed')
    console.log(
      JSON.stringify({
        ...metrics,
        confirmedCalls: calls.length,
        sameKeyRetry: true,
        hostedState: 'approval',
        evidence: 'local browser fixture only',
      }),
    )
    await page.screenshot({ path: `/tmp/sidequest-hiring-${width}.png`, fullPage: true })
    await page.close()
  }
} finally {
  await browser.close()
}
