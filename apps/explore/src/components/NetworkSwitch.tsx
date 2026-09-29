import { MAINNET_LIVE, NETWORK_ORIGINS, isMainnet } from '../wallet.ts'

const base = 'rounded-full px-2.5 py-0.5 whitespace-nowrap'
const current = `${base} bg-surface font-medium text-label shadow-sm`
const other = `${base} text-label-2 hover:text-label`
const disabled = `${base} cursor-not-allowed text-label-3`

function Option({ net, label }: { net: keyof typeof NETWORK_ORIGINS; label: string }) {
  if ((net === 'monad-mainnet') === isMainnet) return <span className={current} aria-current="true">{label}</span>
  if (net === 'monad-mainnet' && !MAINNET_LIVE) {
    return (
      <span className={disabled} aria-disabled="true" title="Mainnet is not live yet">
        {label} <span className="text-[10px] uppercase tracking-wide">soon</span>
      </span>
    )
  }
  return <a href={`${NETWORK_ORIGINS[net]}/`} className={other}>{label}</a>
}

/**
 * Testnet / Mainnet pill. The other option links to the other network's origin root, never the same path:
 * job ids differ per network. Local dev and workers.dev hosts point at the canonical origins too.
 */
export function NetworkSwitch() {
  return (
    <span role="group" aria-label="Network" className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-sep bg-fill p-0.5 text-xs">
      <Option net="monad-testnet" label="Testnet" />
      <Option net="monad-mainnet" label="Mainnet" />
    </span>
  )
}
