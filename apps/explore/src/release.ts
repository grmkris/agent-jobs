/**
 * Whether Sidequest on Monad mainnet is open (D16, PROD-GATE-006). False until launch day: the coordinator sets it true
 * only after the D16 live gate passes. The build writes it to `release.json`, which the production artifact pins and
 * the release checks. On mainnet, false means reads only: every write path (the pages that publish, stake, collect,
 * link or administer; the board's write tools; wallet sends and signatures) is closed, also by direct URL. Testnet
 * ignores it. No environment variable opens it: the value is this source line, and this file imports nothing so the
 * build config can read it.
 */
export const MAINNET_LIVE = false
