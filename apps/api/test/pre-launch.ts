/** What the shipped config and artifact may still lack before launch: R2's keys, Safe policy and default arbitrator, the
 *  deploy and promotion records, the Privy and provider approvals (LAUNCH-AUDIT-FIX-002/003). A structural failure
 *  (stage, URLs, faucet, hold gates, known tokens, stacks, legacy pairs, secret sources, artifact structure) or an
 *  Explore pin is never one of them. */
const PRE_LAUNCH = new Set(['chain/providers', 'Privy app/origin approval', 'deployment network/block', 'open-token main Holding metadata',
  'main v1 kind', 'v1 factory consistency', 'hireling block/T0', 'hireling:safeOwners/safeThreshold', 'rewardTokens:USDC',
  'artifact rewardTokens', 'hireling.defaultArbitrator is not roles.arbitrator', 'hireling.defaultArbitrator is a retired 1 Oct key'])

export const preLaunch = (label: string) => PRE_LAUNCH.has(label) || /^(hireling|main|address):[A-Za-z]+$/.test(label) ||
  /^(role|address):[A-Za-z]+ is a retired 1 Oct key$/.test(label)
