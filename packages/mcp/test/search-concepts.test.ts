import { describe, it, expect } from 'vitest'
import { searchConcepts } from '../src/tools/search-concepts.js'
import type { SparqlClient, SparqlRow } from '../src/sparql-client.js'

/**
 * Mock SparqlClient that returns pre-programmed responses based on
 * substring matching in the query. Lets us simulate the Oxigraph behaviour
 * observed in production (duplicated rows from union-of-named-graphs).
 */
class MockSparqlClient {
  constructor(private readonly responses: Array<(query: string) => SparqlRow[] | null>) {}

  async select(query: string): Promise<SparqlRow[]> {
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

describe('searchConcepts — broader/related deduplication', () => {
  it('deduplicates broader IDs that appear multiple times in SPARQL results', async () => {
    const mock = new MockSparqlClient([
      // First query: the main search
      (q) =>
        q.includes('?identifier ?label ?definition')
          ? [{ identifier: 'concept-foo', label: 'Foo', definition: 'The Foo concept.' }]
          : null,
      // Second query: the broader/related lookup, simulating duplicated rows
      (q) =>
        q.includes('skos:broader skos:related')
          ? [
              { rel: 'broader', targetId: 'concept-bar' },
              { rel: 'broader', targetId: 'concept-bar' },
              { rel: 'broader', targetId: 'concept-bar' },
              { rel: 'related', targetId: 'concept-baz' },
              { rel: 'related', targetId: 'concept-baz' },
              { rel: 'related', targetId: 'concept-qux' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'Foo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results).toHaveLength(1)
    expect(results[0].broader).toEqual(['concept-bar'])
    expect(results[0].related).toEqual(['concept-baz', 'concept-qux'])
  })

  it('preserves the order of first occurrence when deduplicating', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        q.includes('?identifier ?label ?definition')
          ? [{ identifier: 'concept-x', label: 'X', definition: '' }]
          : null,
      (q) =>
        q.includes('skos:broader skos:related')
          ? [
              { rel: 'related', targetId: 'concept-a' },
              { rel: 'related', targetId: 'concept-b' },
              { rel: 'related', targetId: 'concept-a' }, // dup of first
              { rel: 'related', targetId: 'concept-c' },
              { rel: 'related', targetId: 'concept-b' }, // dup of second
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'X', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0].related).toEqual(['concept-a', 'concept-b', 'concept-c'])
  })

  it('filters out empty-string target IDs', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        q.includes('?identifier ?label ?definition')
          ? [{ identifier: 'concept-x', label: 'X', definition: '' }]
          : null,
      (q) =>
        q.includes('skos:broader skos:related')
          ? [
              { rel: 'broader', targetId: 'concept-a' },
              { rel: 'broader', targetId: '' },
              { rel: 'related', targetId: 'concept-b' },
            ]
          : null,
    ])

    const results = await searchConcepts(
      { query: 'X', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0].broader).toEqual(['concept-a'])
    expect(results[0].related).toEqual(['concept-b'])
  })

  it('returns empty arrays when no relations exist', async () => {
    const mock = new MockSparqlClient([
      (q) =>
        q.includes('?identifier ?label ?definition')
          ? [{ identifier: 'concept-solo', label: 'Solo', definition: '' }]
          : null,
      (q) => (q.includes('skos:broader skos:related') ? [] : null),
    ])

    const results = await searchConcepts(
      { query: 'Solo', limit: 10 },
      mock as unknown as SparqlClient,
    )

    expect(results[0].broader).toEqual([])
    expect(results[0].related).toEqual([])
  })

  it('includes DISTINCT in the SPARQL query to deduplicate at the store level', async () => {
    let capturedRelQuery = ''
    const mock = new MockSparqlClient([
      (q) =>
        q.includes('?identifier ?label ?definition')
          ? [{ identifier: 'concept-x', label: 'X', definition: '' }]
          : null,
      (q) => {
        if (q.includes('skos:broader skos:related')) {
          capturedRelQuery = q
          return []
        }
        return null
      },
    ])

    await searchConcepts({ query: 'X', limit: 10 }, mock as unknown as SparqlClient)

    expect(capturedRelQuery).toMatch(/SELECT\s+DISTINCT/)
  })
})
