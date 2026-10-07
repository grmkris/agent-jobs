/** Anonymous deployed Chromium smoke. No login, wallet injection, signatures or writes. */
import { HostedBrowser } from './browser.ts'
import { ORIGIN, publicFailure, sourceCommit } from './guards.ts'
import { RunState } from './state.ts'

async function smoke(): Promise<void> {
  const run = new RunState('read-only-smoke', `smoke:${ORIGIN}`)
  const browser = new HostedBrowser(run)
  try {
    await browser.start(true)
    const response = await browser.page.goto(ORIGIN, { waitUntil: 'networkidle', timeout: 60_000 })
    if (response?.status() !== 200) throw new Error('P8_PUBLIC_SITE_UNAVAILABLE')
    const release = await browser.page.request.get(`${ORIGIN}/release.json`)
    const info = (await release.json()) as { network?: string }
    if (!release.ok() || info.network !== 'monad-testnet') throw new Error('P8_WRONG_DEPLOYED_NETWORK')
    await browser.settle()
    console.log(
      JSON.stringify({
        fixture: true,
        result: 'pass',
        commit: sourceCommit(),
        network: 'monad-testnet',
        tier: 'anonymous deployed Chromium smoke; no spec-v2 acceptance claim',
        txHashes: [],
        gas: [],
        spendMon: '0',
      }),
    )
  } finally {
    await browser.close()
    run.close()
  }
}

if (import.meta.main) {
  await smoke().catch((error) => {
    console.error(publicFailure(error))
    process.exitCode = 1
  })
}
