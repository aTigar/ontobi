import { z } from 'zod'
import type { SparqlClient } from '../sparql-client.js'
import { fetchCandidatePool } from '../search/candidates.js'
import { tokenize } from '../search/tokenize.js'
import { runTiers, type MatchTier } from '../search/tiers.js'

export const searchConceptsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'Search term — matched through a 6-tier fallback engine against concept ' +
        'labels, aliases, and definitions. Exact label/alias matches always ' +
        'surface first; multi-word and fuzzy matches fill in below.',
    ),
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
  /** Vault-relative file path (forward-slash, no URL encoding). */
  file_path: string
  /** All `skos:altLabel` values (from `aliases:` frontmatter). */
  aliases: string[]
  broader: string[]
  related: string[]
  /**
   * Which tier matched this concept. Lower is stronger:
   *   1 EXACT_LABEL, 2 EXACT_ALIAS, 3 PHRASE_SUBSTRING,
   *   4 TOKEN_MATCH, 5 FUZZY_TRIGRAM.
   */
  match_tier: MatchTier
  /** Relative score within `match_tier`. Not comparable across tiers. */
  match_score: number
}

/**
 * search_concepts tool handler.
 *
 * Runs a 5-tier fallback search over the concept pool:
 *
 *   Tier 1 EXACT_LABEL       — always contributes
 *   Tier 2 EXACT_ALIAS       — always contributes
 *   Tier 3 PHRASE_SUBSTRING  ─┐
 *   Tier 4 TOKEN_MATCH        │ first non-empty wins
 *   Tier 5 FUZZY_TRIGRAM     ─┘
 *
 * The candidate pool (one row per concept, with aliases collapsed) is
 * fetched via a single SPARQL query and then ranked entirely in JS.
 * For each selected hit, broader/related IDs are fetched in a second
 * round of per-hit relation queries (same pattern as before).
 *
 * Design: metadata-first. The agent inspects summaries (including
 * match_tier so it knows how much to trust the hit) and navigates the
 * graph before any full .md body enters the context window.
 */
export async function searchConcepts(
  input: SearchConceptsInput,
  sparql: SparqlClient,
): Promise<ConceptSummary[]> {
  // Step 1: fetch all candidate concepts in one query.
  const pool = await fetchCandidatePool(sparql)

  // Step 2: tokenise the query (stopwords removed) for Tiers 4 & 5.
  const tokens = tokenize(input.query)

  // Step 3: run the tiered matcher to select top candidates.
  const selected = runTiers(input.query, tokens, pool, input.limit)

  if (selected.length === 0) return []

  // Step 4: per-hit, fetch broader/related IDs via the existing
  //         named-graph relation query. Aliases are already in the
  //         candidate pool so we do not re-fetch them.
  const results: ConceptSummary[] = await Promise.all(
    selected.map(async (hit) => {
      const { candidate, tier, score } = hit
      const subjectUri = `urn:ontobi:item:${candidate.identifier}`

      // Reason: broader/related are relations (concept → concept), not
      // literals, so they live in the triple store and are looked up
      // per-hit rather than bulk-fetched. Aliases come from the
      // candidate pool — already present.
      const relQuery = `
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        PREFIX schema: <https://schema.org/>

        SELECT DISTINCT ?rel ?targetId WHERE {
          VALUES ?pred { skos:broader skos:related }
          <${subjectUri}> ?pred ?target .
          ?target schema:identifier ?targetId .
          BIND(REPLACE(STR(?pred), ".*#", "") AS ?rel)
        }
      `

      // Reason: same-triple-across-named-graphs produces duplicate rows.
      // DISTINCT handles the store side; JS Set is a safety net against
      // SKOS authoring mistakes (same target under multiple predicates).
      const relRows = await sparql.select(relQuery)
      const broader = [
        ...new Set(
          relRows.filter((r) => r['rel'] === 'broader').map((r) => r['targetId'] ?? ''),
        ),
      ].filter((v) => v !== '')
      const related = [
        ...new Set(
          relRows.filter((r) => r['rel'] === 'related').map((r) => r['targetId'] ?? ''),
        ),
      ].filter((v) => v !== '')

      return {
        identifier: candidate.identifier,
        label: candidate.label,
        definition: candidate.definition,
        file_path: candidate.filePath,
        aliases: candidate.aliases,
        broader,
        related,
        match_tier: tier,
        match_score: score,
      }
    }),
  )

  return results
}
