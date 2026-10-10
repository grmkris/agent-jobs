/**
 * What a delivery is and where it opens (ADR-0006: a git commit, a patch, a file, a live URL or an on-chain result),
 * in words the job page, the activity rows and the receipt card share.
 */
import type { Deliverable } from './api.ts'
import { explorer } from './wallet.ts'

/** An `ipfs://` link through a public gateway; any other URL as given. */
export const httpUrl = (url: string) =>
  url.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${url.slice('ipfs://'.length)}` : url

export const KIND: Readonly<Record<Deliverable['kind'], string>> = {
  git: 'Git commit',
  patch: 'Patch',
  artifact: 'File',
  url: 'Live URL',
  onchain: 'On-chain result',
}

const isWeb = (url: string) => /^https?:\/\//i.test(url)

/** A commit's browsable tree on the hosts that have one; any other git URL as given. */
export function gitTree(url: string, sha: string): string {
  return /^https:\/\/(github\.com|gitlab\.com|codeberg\.org|gitea\.com)\//.test(url)
    ? `${url.replace(/\.git$/, '')}/tree/${sha}`
    : url
}

/** `owner/repo` from a git URL; the URL itself when it does not parse. */
export function repoName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/|\.git$/g, '')
  } catch {
    return url
  }
}

/** The host of a web address, without `www.`; the address itself when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Where the delivery opens in a browser. Only web links: a deliverable names its own URL, so any other scheme
 * (javascript:, data:) opens nothing.
 */
export function deliveryHref(d: Deliverable): string | null {
  switch (d.kind) {
    case 'git':
      return isWeb(d.url) ? gitTree(d.url, d.sha) : null
    case 'patch':
    case 'artifact':
    case 'url': {
      const href = httpUrl(d.url)
      return isWeb(href) ? href : null
    }
    case 'onchain':
      if (d.txHash !== undefined) return explorer('tx', d.txHash)
      return d.address === undefined ? null : explorer('address', d.address)
  }
}

/** The delivery in a few words: a host, a file, a repository at a commit, a transaction or contract. */
export function deliveryWhere(d: Deliverable): string {
  switch (d.kind) {
    case 'git':
      return `${repoName(d.url)} @ ${d.sha.slice(0, 7)}`
    case 'patch':
      return `patch on ${d.base.slice(0, 7)}`
    case 'artifact':
      return d.name
    case 'url':
      return hostOf(d.url)
    case 'onchain':
      return d.txHash === undefined ? `contract ${(d.address ?? '').slice(0, 10)}…` : `tx ${d.txHash.slice(0, 10)}…`
  }
}
