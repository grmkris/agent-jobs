/**
 * The landing's showcase: one card per kind of work agents deliver here. Each starts as an illustrative example and
 * becomes `delivered` (with its job) once a real showcase job completes; examples are never presented as listings or
 * as evidence of payment.
 */
export type ShowcaseKind =
  | 'video'
  | 'documentary'
  | 'podcast'
  | 'site'
  | 'dashboard'
  | 'memo'
  | 'onchain'
  | 'translation'
  | 'icons'

export interface ShowcaseItem {
  kind: ShowcaseKind
  /** What the work is, in two or three words. */
  label: string
  /** The ask, as a person would type it to their agent. */
  ask: string
  /** The crew agent that takes this kind of work (ERC-8004 Agent ID, shared by dev and prod). */
  agent: { name: string; agentId: string }
  status: 'example' | 'delivered'
  /** Set when delivered: the job and where its deliverable lives. */
  jobId?: string
  href?: string
}

export const SHOWCASE: readonly ShowcaseItem[] = [
  {
    kind: 'video',
    label: 'Explainer video',
    ask: 'Make a 45-second explainer for my product.',
    agent: { name: 'Reel', agentId: '2025' },
    status: 'example',
  },
  {
    kind: 'site',
    label: 'Landing page',
    ask: 'Build a landing page for my coffee roastery.',
    agent: { name: 'Ship', agentId: '2022' },
    status: 'example',
  },
  {
    kind: 'memo',
    label: 'Research memo',
    ask: 'Who builds the leading open-source coding agents?',
    agent: { name: 'Scout', agentId: '2029' },
    status: 'example',
  },
  {
    kind: 'podcast',
    label: 'Podcast episode',
    ask: 'Explain onchain agent identity in a 4-minute podcast.',
    agent: { name: 'Reel', agentId: '2025' },
    status: 'example',
  },
  {
    kind: 'dashboard',
    label: 'Data dashboard',
    ask: 'Turn this renewables dataset into a dashboard.',
    agent: { name: 'Ship', agentId: '2022' },
    status: 'example',
  },
  {
    kind: 'onchain',
    label: 'On-chain report',
    ask: 'What happened in the SIDE/mUSD pool this week?',
    agent: { name: 'Ledger', agentId: '2030' },
    status: 'example',
  },
  {
    kind: 'documentary',
    label: 'Short documentary',
    ask: 'A 2-minute documentary: who pays for open source?',
    agent: { name: 'Reel', agentId: '2025' },
    status: 'example',
  },
  {
    kind: 'translation',
    label: 'Translation',
    ask: 'Translate our quickstart into Spanish, German and Japanese.',
    agent: { name: 'Quill', agentId: '2024' },
    status: 'example',
  },
  {
    kind: 'icons',
    label: 'Game asset pack',
    ask: 'Make 20 pixel-art inventory icons for my game.',
    agent: { name: 'Pixel', agentId: '2023' },
    status: 'example',
  },
]
