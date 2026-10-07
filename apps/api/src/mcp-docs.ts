import { DOCS, DOCS_ORIGIN_PLACEHOLDER } from './generated/docs.ts'

export type DocsResource = { uri: string; name: string; description: string; mimeType: 'text/markdown' }

function resourceUri(slug: string): string {
  return `sidequest://docs/${slug || 'index'}`
}

export function docsResources(): DocsResource[] {
  return DOCS.map(page => ({ uri: resourceUri(page.slug), name: page.title, description: page.description, mimeType: 'text/markdown' }))
}

export function readDoc(uri: string, origin: string): string | undefined {
  const page = DOCS.find(entry => resourceUri(entry.slug) === uri)
  return page?.markdown.replaceAll(DOCS_ORIGIN_PLACEHOLDER, origin)
}

type SearchResult = {
  slug: string
  title: string
  uri: string
  url: string
  markdownUrl: string
  section: string | null
  snippet: string
}

function occurrences(text: string, terms: string[]): number {
  const words = text.toLocaleLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
  return terms.reduce((total, term) => {
    const wanted = term.split(/\s+/u).filter(Boolean)
    if (wanted.length === 0) return total
    let count = 0
    for (let index = 0; index <= words.length - wanted.length; index += 1) {
      if (wanted.every((word, offset) => words[index + offset] === word)) count += 1
    }
    return total + count
  }, 0)
}

function snippet(markdown: string, terms: string[]): string {
  const lower = markdown.toLowerCase()
  const at = terms.reduce((found, term) => {
    const index = lower.indexOf(term)
    return index < 0 ? found : Math.min(found, index)
  }, Number.POSITIVE_INFINITY)
  const start = Number.isFinite(at) ? Math.max(0, at - 80) : 0
  const value = markdown.slice(start, start + 240).replace(/\s+/g, ' ').trim()
  return start > 0 ? `…${value}`.slice(0, 240) : value.slice(0, 240)
}

export function searchDocs(input: { query: string; limit?: number }, origin: string): { query: string; results: SearchResult[] } {
  const query = input.query.trim().toLowerCase().replace(/\s+/g, ' ')
  const terms = [...new Set([query, ...query.split(/\s+/)].filter(Boolean))]
  const requestedLimit = input.limit ?? 5
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10, Math.trunc(requestedLimit))) : 5
  if (query === '') return { query: input.query, results: [] }
  const ranked = DOCS.flatMap(page => {
    const titleScore = occurrences(page.title, terms) > 0 ? 5 : 0
    const headingScore = page.sections.some(section => occurrences(section.heading, terms) > 0) ? 3 : 0
    const descriptionScore = occurrences(page.description, terms) > 0 ? 2 : 0
    const textOccurrences = Math.min(3, occurrences(page.markdown, terms))
    const score = titleScore + headingScore + descriptionScore + textOccurrences
    if (score === 0) return []
    const sections: readonly { heading: string; id: string; text: string }[] = page.sections
    const candidates = sections.map(entry => ({ ...entry, score: 3 * occurrences(entry.heading, terms) + Math.min(3, occurrences(entry.text, terms)) }))
    const section = candidates
      .toSorted((left, right) => right.score - left.score)[0]
    return [{ score, page, section }]
  }).toSorted((left, right) => right.score - left.score || (left.page.slug < right.page.slug ? -1 : left.page.slug > right.page.slug ? 1 : 0))
  return {
    query: input.query,
    results: ranked.slice(0, limit).map(({ page, section }) => ({
      slug: page.slug,
      title: page.title,
      uri: resourceUri(page.slug),
      url: `${origin}/docs/${page.slug}`,
      markdownUrl: `${origin}/docs/${page.slug}.md`,
      section: section?.score ? section.heading : null,
      snippet: snippet((section?.score ? `${section.heading}\n\n${section.text}` : page.markdown).replaceAll(DOCS_ORIGIN_PLACEHOLDER, origin), terms),
    })),
  }
}
