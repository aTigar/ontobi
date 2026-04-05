import { describe, it, expect } from 'vitest'
import { searchConcepts } from '../src/tools/search-concepts.js'
import type { SparqlClient, SparqlRow } from '../src/sparql-client.js'

/**
 * Mock SparqlClient that returns pre-programmed responses based on
 * substring matching in the query. Lets us simulate the Oxigraph behaviour
 * observed in production (duplicated rows from union-of-named-graphs).
 */
class MockSparqlClient {
  public readonly calls: string[] = []

  constructor(private readonly responses: Array<(query: string) => SparqlRow[] | null>) {}

  async select(query: string): Promise<SparqlRow[]> {
    this.calls.push(query)
    for (const matcher of this.responses) {
      const result = matcher(query)
      if (result !== null) return result
    }
    return []
  }

  async ask(): Promise<boolean> {
    return true
  }
}

// Helper: matches the main search query (by projected column names).
const isMainSearch = (q: string): boolean =>
  q.includes('?identifier ?label ?definition') && q.includes('skos:altLabel')

// Helper: matches the per-concept relation query (by VALUES clause + altLabel UNION).
const isRelationQuery = (q: string): boolean =>
  q.includes('VALUES ?pred') && q.includes('skos:altLabel')

// ── broader/related deduplication (regression protection from PR #44) ────────

describe('searchConcepts — broader/related deduplication', () => {
  it('deduplicates broader IDs that appear multiple times in SPARQL results', async () => {
    const mock = new MockSparqlClient([
      // Main search query
      (q) =>
        isMainSearch(q)
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: 'The Foo concept.' }]
          : null,
      // Relation lookup, simulating duplicated rows across named graphs
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'broader', value: 'concept-bar' },
              { rel: 'broader', value: 'concept-bar' },
              { rel: 'broader', value: 'concept-bar' },
              { rel: 'related', value: 'concept-baz' },
              { rel: 'related', value: 'concept-baz' },
              { rel: 'related', value: 'concept-qux' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.broader).toEqual(['concept-bar'])
    expect(results[0]?.related).toEqual(['concept-baz', 'concept-qux'])
  })

  it('preserves the order of first occurrence when deduplicating', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [{ identifier: 'concept-x', label: 'X', definition: '' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'related', value: 'concept-a' },
              { rel: 'related', value: 'concept-b' },
              { rel: 'related', value: 'concept-a' }, // dup of first
              { rel: 'related', value: 'concept-c' },
              { rel: 'related', value: 'concept-b' }, // dup of second
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'X', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0]?.related).toEqual(['concept-a', 'concept-b', 'concept-c'])
  })

  it('filters out empty-string target IDs', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [{ identifier: 'concept-x', label: 'X', definition: '' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'broader', value: 'concept-a' },
              { rel: 'broader', value: '' },
              { rel: 'related', value: 'concept-b' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'X', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0]?.broader).toEqual(['concept-a'])
    expect(results[0]?.related).toEqual(['concept-b'])
  })

  it('returns empty arrays when no relations exist', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [{ identifier: 'concept-solo', label: 'Solo', definition: '' }]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    const results = await searchConcepts(
      { query: 'Solo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0]?.broader).toEqual([])
    expect(results[0]?.related).toEqual([])
    expect(results[0]?.aliases).toEqual([])
  })

  it('includes DISTINCT in the SPARQL query to deduplicate at the store level', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [{ identifier: 'concept-x', label: 'X', definition: '' }]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    await searchConcepts({ query: 'X', limit: 10 }, mock as unknown as SparqlClient)

    const relationCall = mock.calls.find(isRelationQuery) ?? ''
    expect(relationCall).toMatch(/SELECT\s+DISTINCT/)
  })
})

// ── aliases surfacing (new in this PR) ────────────────────────────────────────

describe('searchConcepts — aliases surfacing', () => {
  it('populates aliases array from skos:altLabel triples', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [{ identifier: 'concept-gdpr', label: 'General Data Protection Regulation', definition: 'EU regulation.' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'alias', value: 'GDPR' },
              { rel: 'alias', value: 'DSGVO' },
              { rel: 'broader', value: 'concept-privacy' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'GDPR', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.aliases).toEqual(['GDPR', 'DSGVO'])
    expect(results[0]?.broader).toEqual(['concept-privacy'])
    expect(results[0]?.related).toEqual([])
  })

  it('returns empty aliases array when concept has no altLabels', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: 'The Foo concept.' }]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.aliases).toEqual([])
  })

  it('matches against aliases in SPARQL FILTER (query shape contains altLabel REGEX)', async () => {
    const mock = new MockSparqlClient([
      (q) => (isMainSearch(q) ? [] : null),
    ])

    await searchConcepts({ query: 'CVSS', limit: 10 }, mock as unknown as SparqlClient)

    // The main search query must REGEX-match against altLabel too
    const mainQuery = mock.calls[0] ?? ''
    expect(mainQuery).toContain('skos:altLabel')
    expect(mainQuery).toMatch(/REGEX\(STR\(\?altLabel\)/)
  })
})

// ── identifier-row deduplication (belt-and-braces with SPARQL DISTINCT) ──────

describe('searchConcepts — row deduplication', () => {
  it('deduplicates identifier rows before issuing per-concept queries', async () => {
    // Oxigraph's default-graph-as-union behaviour can produce duplicate rows
    // even with DISTINCT when the same concept appears across multiple graphs.
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [
              { identifier: 'concept-foo', label: 'Foo', definition: 'Foo.' },
              { identifier: 'concept-foo', label: 'Foo', definition: 'Foo.' },
              { identifier: 'concept-foo', label: 'Foo', definition: 'Foo.' },
            ]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    // Exactly one result and exactly one relation query (per unique identifier)
    expect(results).toHaveLength(1)
    expect(results[0]?.identifier).toBe('concept-foo')
    const relationCalls = mock.calls.filter(isRelationQuery)
    expect(relationCalls).toHaveLength(1)
  })

  it('deduplicates broader/related/aliases values from duplicate relation rows', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [{ identifier: 'concept-rbac', label: 'Role-Based Access Control', definition: 'RBAC.' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'broader', value: 'concept-authorization' },
              { rel: 'broader', value: 'concept-authorization' },
              { rel: 'related', value: 'concept-least-privilege' },
              { rel: 'related', value: 'concept-least-privilege' },
              { rel: 'alias', value: 'RBAC' },
              { rel: 'alias', value: 'RBAC' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'RBAC', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.broader).toEqual(['concept-authorization'])
    expect(results[0]?.related).toEqual(['concept-least-privilege'])
    expect(results[0]?.aliases).toEqual(['RBAC'])
  })

  it('filters out empty identifier rows defensively', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isMainSearch(q)
          ? [
              { identifier: '', label: 'BadRow', definition: '' },
              { identifier: 'concept-good', label: 'Good', definition: '' },
            ]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    const results = await searchConcepts(
      { query: 'Any', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.identifier).toBe('concept-good')
  })
})
