import { describe, it, expect } from 'vitest'
import { searchConcepts } from '../src/tools/search-concepts.js'
import type { SparqlClient, SparqlRow } from '../src/sparql-client.js'

/**
 * Mock SparqlClient that returns pre-programmed responses based on
 * substring matching in the SPARQL query. Used to drive the tiered
 * search engine with known fixtures without needing an endpoint.
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

// Helper: matches the candidate-pool query (fetches all concepts with
// identifier, label, definition, altLabel, graph).
const isPoolQuery = (q: string): boolean =>
  q.includes('?identifier ?label ?definition ?altLabel ?graph') && !q.includes('FILTER')

// Helper: matches the per-hit relation query (broader/narrower/related lookup
// for a specific concept URI). Excludes the linkCount pool query which also
// has VALUES ?pred but uses GROUP BY / COUNT instead.
const isRelationQuery = (q: string): boolean =>
  q.includes('VALUES ?pred') &&
  q.includes('skos:broader skos:narrower skos:related') &&
  q.includes('?targetLabel') &&
  !q.includes('GROUP BY')

// ── Candidate pool fetching ──────────────────────────────────────────────────

describe('searchConcepts — candidate pool', () => {
  it('fetches the full concept pool via a single unfiltered query', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [
              { identifier: 'concept-rbac', label: 'Role-Based Access Control', altLabel: 'RBAC', graph: 'file:///_concepts/Role-Based%20Access%20Control.md' },
              { identifier: 'concept-foo', label: 'Foo', graph: 'file:///_concepts/Foo.md' },
            ]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    await searchConcepts({ query: 'RBAC', limit: 10 }, mock as unknown as SparqlClient)

    const poolCalls = mock.calls.filter(isPoolQuery)
    expect(poolCalls).toHaveLength(1)
    // Must not contain a FILTER — all filtering is in JS.
    expect(poolCalls[0]).not.toContain('FILTER')
  })

  it('groups multiple altLabel rows for one concept into an aliases array', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [
              { identifier: 'concept-gdpr', label: 'General Data Protection Regulation', altLabel: 'GDPR', graph: 'file:///_concepts/General%20Data%20Protection%20Regulation.md' },
              { identifier: 'concept-gdpr', label: 'General Data Protection Regulation', altLabel: 'DSGVO', graph: 'file:///_concepts/General%20Data%20Protection%20Regulation.md' },
            ]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    const results = await searchConcepts(
      { query: 'GDPR', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.aliases.sort()).toEqual(['DSGVO', 'GDPR'])
  })
})

// ── Tier matching end-to-end ─────────────────────────────────────────────────

describe('searchConcepts — tier matching', () => {
  const poolRow = (identifier: string, label: string, definition = '', altLabel?: string) => {
    const graph = `file:///_concepts/${label}.md`
    return altLabel
      ? { identifier, label, definition, altLabel, graph }
      : { identifier, label, definition, graph }
  }

  const smallPool = [
    poolRow('concept-rbac', 'Role-Based Access Control', 'Access control model.', 'RBAC'),
    poolRow('concept-sast', 'Static Application Security Testing', 'Code analysis.', 'SAST'),
    poolRow('concept-dast', 'Dynamic Application Security Testing', 'Runtime testing.', 'DAST'),
  ]

  const makeMock = () =>
    new MockSparqlClient([
      (q) => (isPoolQuery(q) ? smallPool : null),
      (q) => (isRelationQuery(q) ? [] : null),
    ])

  it('returns exact-label matches with match_tier=1', async () => {
    const results = await searchConcepts(
      { query: 'Role-Based Access Control', limit: 10 },
      makeMock() as unknown as SparqlClient,
    )
    expect(results[0]?.identifier).toBe('concept-rbac')
    expect(results[0]?.match_tier).toBe(1)
  })

  it('returns exact-alias matches with match_tier=2', async () => {
    const results = await searchConcepts(
      { query: 'RBAC', limit: 10 },
      makeMock() as unknown as SparqlClient,
    )
    expect(results[0]?.identifier).toBe('concept-rbac')
    expect(results[0]?.match_tier).toBe(2)
  })

  it('returns substring matches with match_tier=3', async () => {
    const results = await searchConcepts(
      { query: 'Access Control', limit: 10 },
      makeMock() as unknown as SparqlClient,
    )
    const rbac = results.find((r) => r.identifier === 'concept-rbac')
    expect(rbac?.match_tier).toBe(3)
  })

  it('rescues multi-word combined-concept queries via tier 4', async () => {
    // "SAST DAST" is not a substring of any concept. Tier 4 TOKEN_MATCH
    // matches both — each concept has one of the two tokens as a label word.
    const results = await searchConcepts(
      { query: 'SAST DAST', limit: 10 },
      makeMock() as unknown as SparqlClient,
    )
    const ids = results.map((r) => r.identifier).sort()
    expect(ids).toContain('concept-sast')
    expect(ids).toContain('concept-dast')
    const sast = results.find((r) => r.identifier === 'concept-sast')
    expect(sast?.match_tier).toBe(4)
  })

  it('returns empty array when query matches nothing across all tiers', async () => {
    const results = await searchConcepts(
      { query: 'xyzzy completely unrelated gibberish', limit: 10 },
      makeMock() as unknown as SparqlClient,
    )
    expect(results).toEqual([])
  })

  it('includes match_tier and match_score on every result', async () => {
    const results = await searchConcepts(
      { query: 'application security', limit: 10 },
      makeMock() as unknown as SparqlClient,
    )
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.match_tier).toBeGreaterThanOrEqual(1)
      expect(r.match_tier).toBeLessThanOrEqual(6)
      expect(typeof r.match_score).toBe('number')
    }
  })

  it('includes file_path decoded from the named graph URI', async () => {
    const results = await searchConcepts(
      { query: 'Role-Based Access Control', limit: 10 },
      makeMock() as unknown as SparqlClient,
    )
    expect(results[0]?.file_path).toBe('_concepts/Role-Based Access Control.md')
  })

  it('decodes percent-encoded spaces in file_path', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-cia', label: 'CIA Triad', definition: 'Security model.', graph: 'file:///_concepts/CIA%20Triad.md' }]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])
    const results = await searchConcepts(
      { query: 'CIA Triad', limit: 10 },
      mock as unknown as SparqlClient,
    )
    expect(results[0]?.file_path).toBe('_concepts/CIA Triad.md')
  })
})

// ── broader/related per-hit relation fetching ────────────────────────────────

describe('searchConcepts — broader/related per-hit lookup', () => {
  it('fires one relation query per selected hit', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: '', graph: 'file:///_concepts/Foo.md' }]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    await searchConcepts({ query: 'Foo', limit: 10 }, mock as unknown as SparqlClient)

    expect(mock.calls.filter(isRelationQuery)).toHaveLength(1)
  })

  it('deduplicates broader IDs returned with duplicate rows', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: '', graph: 'file:///_concepts/Foo.md' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'broader', targetId: 'concept-bar', targetLabel: 'Bar' },
              { rel: 'broader', targetId: 'concept-bar', targetLabel: 'Bar' },
              { rel: 'broader', targetId: 'concept-bar', targetLabel: 'Bar' },
              { rel: 'related', targetId: 'concept-baz', targetLabel: 'Baz' },
              { rel: 'related', targetId: 'concept-baz', targetLabel: 'Baz' },
              { rel: 'related', targetId: 'concept-qux', targetLabel: 'Qux' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0]?.broader).toEqual(['concept-bar'])
    expect(results[0]?.related).toEqual(['concept-baz', 'concept-qux'])
  })

  it('filters out empty-string target IDs', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: '', graph: 'file:///_concepts/Foo.md' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'broader', targetId: 'concept-a', targetLabel: 'A' },
              { rel: 'broader', targetId: '', targetLabel: '' },
              { rel: 'related', targetId: 'concept-b', targetLabel: 'B' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0]?.broader).toEqual(['concept-a'])
    expect(results[0]?.related).toEqual(['concept-b'])
  })

  it('returns empty arrays when no relations exist', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-solo', label: 'Solo', definition: '', graph: 'file:///_concepts/Solo.md' }]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    const results = await searchConcepts(
      { query: 'Solo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0]?.broader).toEqual([])
    expect(results[0]?.related).toEqual([])
    expect(results[0]?.neighbors).toEqual([])
  })

  it('uses DISTINCT in the relation query', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-x', label: 'X', definition: '', graph: 'file:///_concepts/X.md' }]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    await searchConcepts({ query: 'X', limit: 10 }, mock as unknown as SparqlClient)

    const relQuery = mock.calls.find(isRelationQuery) ?? ''
    expect(relQuery).toMatch(/SELECT\s+DISTINCT/)
  })

  it('includes skos:narrower in the relation query (#48)', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-x', label: 'X', definition: '', graph: 'file:///_concepts/X.md' }]
          : null,
      (q) => (isRelationQuery(q) ? [] : null),
    ])

    await searchConcepts({ query: 'X', limit: 10 }, mock as unknown as SparqlClient)

    const relQuery = mock.calls.find(isRelationQuery) ?? ''
    expect(relQuery).toContain('skos:narrower')
  })
})

// ── neighbors auto-expansion (#48) ──────────────────────────────────────────

describe('searchConcepts — neighbors auto-expansion', () => {
  it('populates neighbors with all relation types and labels (#48)', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: '', graph: 'file:///_concepts/Foo.md' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'broader', targetId: 'concept-parent', targetLabel: 'Parent Concept' },
              { rel: 'narrower', targetId: 'concept-child', targetLabel: 'Child Concept' },
              { rel: 'related', targetId: 'concept-sibling', targetLabel: 'Sibling Concept' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0]?.neighbors).toHaveLength(3)
    expect(results[0]?.neighbors).toContainEqual({
      identifier: 'concept-parent',
      label: 'Parent Concept',
      relation: 'broader',
    })
    expect(results[0]?.neighbors).toContainEqual({
      identifier: 'concept-child',
      label: 'Child Concept',
      relation: 'narrower',
    })
    expect(results[0]?.neighbors).toContainEqual({
      identifier: 'concept-sibling',
      label: 'Sibling Concept',
      relation: 'related',
    })
  })

  it('deduplicates neighbors by identifier (#48)', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: '', graph: 'file:///_concepts/Foo.md' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'broader', targetId: 'concept-dup', targetLabel: 'Dup' },
              { rel: 'related', targetId: 'concept-dup', targetLabel: 'Dup' },
              { rel: 'related', targetId: 'concept-other', targetLabel: 'Other' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    // concept-dup appears in both broader and related — kept once (first seen wins)
    const dupNeighbors = results[0]?.neighbors.filter((n) => n.identifier === 'concept-dup')
    expect(dupNeighbors).toHaveLength(1)
    expect(results[0]?.neighbors).toHaveLength(2)
  })

  it('preserves backward-compatible broader/related arrays alongside neighbors (#48)', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        isPoolQuery(q)
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: '', graph: 'file:///_concepts/Foo.md' }]
          : null,
      (q) =>
        isRelationQuery(q)
          ? [
              { rel: 'broader', targetId: 'concept-b', targetLabel: 'B' },
              { rel: 'narrower', targetId: 'concept-n', targetLabel: 'N' },
              { rel: 'related', targetId: 'concept-r', targetLabel: 'R' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    // broader and related still populated (backward compat)
    expect(results[0]?.broader).toEqual(['concept-b'])
    expect(results[0]?.related).toEqual(['concept-r'])
    // neighbors includes all three
    expect(results[0]?.neighbors).toHaveLength(3)
  })
})
