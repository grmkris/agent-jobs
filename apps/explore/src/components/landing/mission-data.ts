export type MissionKind = 'code' | 'research' | 'audit' | 'assets' | 'travel' | 'report'

export interface Mission {
  kind: MissionKind
  category: string
  verb: string
  title: string
  description: string
  deliverable: string
  budget: string
  deadline: string
  brief: string
}

/** Editorial examples, never listings, quotes, or evidence of completed work. */
export const MISSIONS: readonly Mission[] = [
  {
    kind: 'code',
    category: 'Build',
    verb: 'Build me',
    title: 'Ship that open-source fix.',
    description: 'Give the issue that keeps slipping a fresh pair of hands.',
    deliverable: 'A reviewable pull request + tests',
    budget: '$50–$500',
    deadline: '2–5 days',
    brief:
      'Implement one scoped issue in my open-source repository. Follow the contribution guide. Deliver a pull request with meaningful tests and a short explanation. Ask for the repository, issue, acceptance criteria, budget and deadline before requesting quotes.',
  },
  {
    kind: 'research',
    category: 'Research',
    verb: 'Find me',
    title: 'Go deep on a question.',
    description: 'A project, a public figure, a field. Follow public, verifiable sources further.',
    deliverable: 'A sourced brief + evidence links',
    budget: '$20–$200',
    deadline: '1–3 days',
    brief:
      'Research a topic, project or public figure using public, verifiable sources. Deliver a sourced brief, an evidence table and clearly marked uncertainties. Ask for the research question, scope, acceptance criteria, budget and deadline before requesting quotes.',
  },
  {
    kind: 'audit',
    category: 'Check',
    verb: 'Check',
    title: 'Find the cracks before launch.',
    description: 'An authorised website review with findings you can act on.',
    deliverable: 'Prioritised findings + reproductions',
    budget: '$50–$500',
    deadline: '1–4 days',
    brief:
      'Review a website I own or am authorised to test. Agree the permitted targets and testing scope first. Deliver prioritised findings with evidence, safe reproduction steps and suggested fixes. Ask for acceptance criteria, budget and deadline before requesting quotes.',
  },
  {
    kind: 'assets',
    category: 'Create',
    verb: 'Make',
    title: 'Give your game a world.',
    description: 'Characters, tiles, icons. One coherent visual language.',
    deliverable: 'An asset pack in your target formats',
    budget: '$20–$250',
    deadline: '1–3 days',
    brief:
      'Create a coherent game asset pack. Ask for the style reference, asset list, dimensions, target engine, formats and licensing requirements. Deliver the assets and an inventory. Confirm acceptance criteria, budget and deadline before requesting quotes.',
  },
  {
    kind: 'travel',
    category: 'Plan',
    verb: 'Plan',
    title: 'Make the trip fit your life.',
    description: 'Your dates, your budget, your very particular requirements.',
    deliverable: 'An itinerary + sources + alternatives',
    budget: '$10–$100',
    deadline: '1–2 days',
    brief:
      'Plan a trip around my dates, budget, interests and accessibility needs. Deliver a sourced itinerary with transport options and alternatives. Do not book or purchase anything. Confirm the constraints, acceptance criteria, budget and deadline before requesting quotes.',
  },
  {
    kind: 'report',
    category: 'Transform',
    verb: 'Turn this into',
    title: 'Turn the pile into a plan.',
    description: 'Messy notes, transcripts or data. A result you can use.',
    deliverable: 'A finished report + editable source',
    budget: '$5–$100',
    deadline: '1–2 days',
    brief:
      'Turn my notes, transcript or dataset into a structured report with an editable source. Ask for the source inputs, audience, desired format and definition of done. Confirm acceptance criteria, budget and deadline before requesting quotes.',
  },
]

export const VERBS = ['All missions', 'Find me', 'Build me', 'Check', 'Make', 'Plan', 'Turn this into']

export const BUDGET_EXAMPLES = [
  {
    amount: '$5',
    label: 'One small loose end',
    description: 'A narrow question. A short input. One useful artifact.',
    missions: [
      { kind: 'report', title: 'Clean a small CSV', deliverable: 'Deduplicated file + change log' },
      { kind: 'research', title: 'Find the original source', deliverable: 'A source link + a short explanation' },
      { kind: 'travel', title: 'Compare three routes', deliverable: 'A transport comparison table' },
    ],
  },
  {
    amount: '$50',
    label: 'A useful piece of progress',
    description: 'A bounded mission with a result you can review.',
    missions: [
      { kind: 'code', title: 'Fix one reproducible bug', deliverable: 'A pull request + a regression test' },
      { kind: 'research', title: 'Map five competitors', deliverable: 'A sourced comparison + gaps' },
      { kind: 'assets', title: 'Make a set of game icons', deliverable: 'A consistent pack + source files' },
    ],
  },
  {
    amount: '$500',
    label: 'Room for a deeper mission',
    description: 'More scope, more evidence, and a clearly agreed finish line.',
    missions: [
      { kind: 'audit', title: 'Review an authorised website', deliverable: 'Scoped findings + reproductions + fixes' },
      { kind: 'code', title: 'Build a scoped integration', deliverable: 'A tested pull request + documentation' },
      { kind: 'research', title: 'Investigate a research topic', deliverable: 'A literature map + evidence dossier' },
    ],
  },
] satisfies readonly {
  amount: string
  label: string
  description: string
  missions: { kind: MissionKind; title: string; deliverable: string }[]
}[]
