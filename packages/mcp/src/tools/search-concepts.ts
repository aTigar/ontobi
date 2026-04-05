import { z } from 'zod'
import type { SparqlClient } from '../sparql-client.js'

export const searchConceptsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe('Search term — matched against concept labels, aliases, and definitions'),
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
  /** All `skos:altLabel` values (from `aliases:` frontmatter). */
  aliases: string[]
  broader: string[]
  related: string[]
}

/**
 * search_concepts tool handler.
 *
 * Searches concept labels, aliases (`skos:altLabel`), and definitions using
 * SPARQL REGEX. Returns a ranked list of matching concepts with metadata
 * (no document bodies).
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

  // Reason: altLabel is OPTIONAL because not every concept has aliases.
  // It is not projected in SELECT, so DISTINCT over (identifier, label,
  // definition) collapses the multi-row join from multiple altLabels.
  const sparqlQuery = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <https://schema.org/>

    SELECT DISTINCT ?identifier ?label ?definition WHERE {
      ?concept schema:identifier ?identifier .
      ?concept skos:prefLabel ?label .
      OPTIONAL { ?concept skos:definition ?definition . }
      OPTIONAL { ?concept skos:altLabel ?altLabel . }
      FILTER(
        REGEX(STR(?label), "${escaped}", "i") ||
        REGEX(STR(?definition), "${escaped}", "i") ||
        REGEX(STR(?altLabel), "${escaped}", "i")
      )
    }
    LIMIT ${input.limit}
  `

  const rows = await sparql.select(sparqlQuery)

  // Defensive JS-side dedup by identifier. SPARQL DISTINCT already collapses
  // on (identifier, label, definition), but per-graph triple duplication
  // (see relation-query comment below) can still produce duplicate rows.
  const seenIds = new Set<string>()
  const uniqueRows = rows.filter((r) => {
    const id = r['identifier']
    if (!id || seenIds.has(id)) return false
    seenIds.add(id)
    return true
  })

  // For each result, fetch broader + related + aliases in one query.
  const results: ConceptSummary[] = await Promise.all(
    uniqueRows.map(async (row) => {
      const identifier = row['identifier'] ?? ''
      const subjectUri = `urn:ontobi:item:${identifier}`

      // Reason: union broader/related/altLabel into a single round-trip to
      // keep per-hit latency at one query. `?rel` distinguishes the three
      // categories in the result rows.
      const relQuery = `
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        PREFIX schema: <https://schema.org/>

        SELECT DISTINCT ?rel ?value WHERE {
          {
            VALUES ?pred { skos:broader skos:related }
            <${subjectUri}> ?pred ?target .
            ?target schema:identifier ?value .
            BIND(REPLACE(STR(?pred), ".*#", "") AS ?rel)
          }
          UNION
          {
            <${subjectUri}> skos:altLabel ?value .
            BIND("alias" AS ?rel)
          }
        }
      `

      // Reason: each concept is stored in its own named graph and the default
      // graph is the union of all named graphs, so the same (subject, predicate,
      // object) triple can match once per graph it appears in. SPARQL DISTINCT
      // handles this at the store level; the JS Set is a safety net against any
      // remaining duplicates from sloppy SKOS authoring (same target appearing
      // under multiple predicates, or duplicate triples across graphs).
      const relRows = await sparql.select(relQuery)
      const broader = [
        ...new Set(
          relRows.filter((r) => r['rel'] === 'broader').map((r) => r['value'] ?? ''),
        ),
      ].filter((v) => v !== '')
      const related = [
        ...new Set(
          relRows.filter((r) => r['rel'] === 'related').map((r) => r['value'] ?? ''),
        ),
      ].filter((v) => v !== '')
      const aliases = [
        ...new Set(
          relRows.filter((r) => r['rel'] === 'alias').map((r) => r['value'] ?? ''),
        ),
      ].filter((v) => v !== '')

      return {
        identifier,
        label: row['label'] ?? identifier,
        definition: row['definition'] ?? '',
        aliases,
        broader,
        related,
      }
    }),
  )

  return results
}
