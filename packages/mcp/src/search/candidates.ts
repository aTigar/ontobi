import type { SparqlClient } from '../sparql-client.js'

/**
 * A single candidate concept: all the data needed to run tier matching
 * without re-querying the store.
 *
 * The shape mirrors what the agent ultimately needs, with `broader` /
 * `related` omitted — those are fetched per-hit after tier selection
 * (see the orchestrator in `tools/search-concepts.ts`).
 */
export interface ConceptCandidate {
  identifier: string
  label: string
  definition: string
  aliases: string[]
}

/**
 * Fetch the full candidate pool from the SPARQL endpoint.
 *
 * Returns every concept with its pref-label, definition, and altLabels,
 * in a shape that groups all altLabels for one concept into a single
 * entry. Alphabetical order by identifier (deterministic for tests).
 *
 * Design: one round-trip fetches all data; all tier logic runs in JS.
 * For a 212-concept vault this is ~50KB and sub-10ms, so caching is not
 * yet necessary. If vaults grow beyond low thousands, introduce an
 * in-memory cache with TTL here.
 */
export async function fetchCandidatePool(sparql: SparqlClient): Promise<ConceptCandidate[]> {
  // Reason: a single query pulls every (identifier, label, definition,
  // altLabel) row. Concepts with no altLabel show up once with altLabel
  // unbound; concepts with N altLabels show up N times. Post-processing
  // groups by identifier.
  const query = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <https://schema.org/>

    SELECT ?identifier ?label ?definition ?altLabel WHERE {
      ?concept schema:identifier ?identifier .
      ?concept skos:prefLabel ?label .
      OPTIONAL { ?concept skos:definition ?definition . }
      OPTIONAL { ?concept skos:altLabel ?altLabel . }
    }
    ORDER BY ?identifier
  `

  const rows = await sparql.select(query)

  // Group by identifier; collect altLabels into an array, dedup.
  const byIdent = new Map<string, ConceptCandidate>()
  for (const row of rows) {
    const identifier = row['identifier']
    if (!identifier) continue
    const label = row['label'] ?? identifier
    const definition = row['definition'] ?? ''
    const altLabel = row['altLabel']

    const existing = byIdent.get(identifier)
    if (existing) {
      if (altLabel && !existing.aliases.includes(altLabel)) {
        existing.aliases.push(altLabel)
      }
    } else {
      byIdent.set(identifier, {
        identifier,
        label,
        definition,
        aliases: altLabel ? [altLabel] : [],
      })
    }
  }

  return [...byIdent.values()]
}
