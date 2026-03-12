import { z } from 'zod'
import type { SparqlClient } from '../sparql-client.js'

export const searchConceptsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe('Search term — matched against concept labels and definitions'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return (1–50, default 10)'),
})

export type SearchConceptsInput = z.infer<typeof searchConceptsInput>

export interface ConceptSummary {
  identifier: string
  label: string
  definition: string
  broader: string[]
  related: string[]
}

/**
 * search_concepts tool handler.
 *
 * Searches concept labels and definitions using SPARQL REGEX.
 * Returns a ranked list of matching concepts with metadata (no document bodies).
 *
 * Design: metadata-first. The agent inspects summaries and navigates the
 * graph before any full .md body enters the context window.
 */
export async function searchConcepts(
  input: SearchConceptsInput,
  sparql: SparqlClient,
): Promise<ConceptSummary[]> {
  // Escape regex special chars in query string
  const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const sparqlQuery = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <https://schema.org/>

    SELECT DISTINCT ?identifier ?label ?definition WHERE {
      ?concept schema:identifier ?identifier .
      ?concept skos:prefLabel ?label .
      OPTIONAL { ?concept skos:definition ?definition . }
      FILTER(
        REGEX(STR(?label), "${escaped}", "i") ||
        REGEX(STR(?definition), "${escaped}", "i")
      )
    }
    LIMIT ${input.limit}
  `

  const rows = await sparql.select(sparqlQuery)

  // For each result, fetch broader + related (two extra queries batched by identifier)
  const results: ConceptSummary[] = await Promise.all(
    rows.map(async (row) => {
      const identifier = row['identifier'] ?? ''
      const subjectUri = `urn:ontobi:item:${identifier}`

      const relQuery = `
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        PREFIX schema: <https://schema.org/>

        SELECT ?rel ?targetId WHERE {
          VALUES ?pred { skos:broader skos:related }
          <${subjectUri}> ?pred ?target .
          ?target schema:identifier ?targetId .
          BIND(REPLACE(STR(?pred), ".*#", "") AS ?rel)
        }
      `

      const relRows = await sparql.select(relQuery)
      const broader = relRows.filter((r) => r['rel'] === 'broader').map((r) => r['targetId'] ?? '')
      const related = relRows.filter((r) => r['rel'] === 'related').map((r) => r['targetId'] ?? '')

      return {
        identifier,
        label: row['label'] ?? identifier,
        definition: row['definition'] ?? '',
        broader,
        related,
      }
    }),
  )

  return results
}
