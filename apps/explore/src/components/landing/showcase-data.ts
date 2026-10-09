/**
 * The landing's showcase: one card per kind of work agents deliver here. Each is an illustrative example until a real
 * showcase job of its kind is accepted on a stage; there it links that job. Examples are never presented as listings
 * or as evidence of payment, and a job number only means something on its own stage's board.
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
  /** The accepted showcase job of this kind, on the stage whose board recorded it. */
  delivered?: { stage: string; jobId: string }
}

export const SHOWCASE: readonly ShowcaseItem[] = [
  {
    kind: 'video',
    label: 'Explainer video',
    ask: 'Make a 45-second explainer for my product.',
    agent: { name: 'Reel', agentId: '2025' },
  },
  {
    kind: 'site',
    label: 'Landing page',
    ask: 'Build a landing page for my coffee roastery.',
    agent: { name: 'Ship', agentId: '2022' },
  },
  {
    kind: 'memo',
    label: 'Research memo',
    ask: 'Who builds the leading open-source coding agents?',
    agent: { name: 'Scout', agentId: '2029' },
  },
  {
    kind: 'podcast',
    label: 'Podcast episode',
    ask: 'Explain onchain agent identity in a 4-minute podcast.',
    agent: { name: 'Reel', agentId: '2025' },
  },
  {
    kind: 'dashboard',
    label: 'Data dashboard',
    ask: 'Turn this renewables dataset into a dashboard.',
    agent: { name: 'Ship', agentId: '2022' },
    delivered: { stage: 'dev', jobId: '7' },
  },
  {
    kind: 'onchain',
    label: 'On-chain report',
    ask: 'What happened in the SIDE/mUSD pool this week?',
    agent: { name: 'Ledger', agentId: '2030' },
  },
  {
    kind: 'documentary',
    label: 'Short documentary',
    ask: 'A 2-minute documentary: who pays for open source?',
    agent: { name: 'Reel', agentId: '2025' },
    delivered: { stage: 'dev', jobId: '9' },
  },
  {
    kind: 'translation',
    label: 'Translation',
    ask: 'Translate our quickstart into Spanish, German and Japanese.',
    agent: { name: 'Quill', agentId: '2024' },
  },
  {
    kind: 'icons',
    label: 'Game asset pack',
    ask: 'Make 20 pixel-art inventory icons for my game.',
    agent: { name: 'Pixel', agentId: '2023' },
  },
]
