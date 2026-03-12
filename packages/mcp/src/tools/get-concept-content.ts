import { z } from 'zod'
import type { SparqlClient } from '../sparql-client.js'
import { readConceptByGraphUri } from '../file-reader.js'

export const getConceptContentInput = z.object({
  concept_id: z
    .string()
    .describe(
      'Concept identifier, e.g. "concept-centroid". Use search_concepts or expand_concept_graph first.',
    ),
})

export type GetConceptContentInput = z.infer<typeof getConceptContentInput>

export interface ConceptContent {
  identifier: string
  label: string
  filePath: string
  content: string
}

/**
 * get_concept_content tool handler.
 *
 * Resolves the concept's file path from the SPARQL named graph URI,
 * then reads the .md body directly from disk (fs.readFile).
 *
 * No Obsidian API. No HTTP round-trip for file content.
 * vaultPath is static config — the same path used by ontobi-core.
 *
 * Design: content-on-demand. Only called after the agent has inspected
 * metadata via search_concepts + expand_concept_graph and decided this
 * concept's full body is needed for the answer.
 */
export async function getConceptContent(
  input: GetConceptContentInput,
  sparql: SparqlClient,
  vaultPath: string,
): Promise<ConceptContent> {
  const subjectUri = `urn:ontobi:item:${input.concept_id}`

  // Resolve the named graph URI — this encodes the file path
  const metaSparql = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

    SELECT ?label ?graphUri WHERE {
      GRAPH ?graphUri {
        <${subjectUri}> skos:prefLabel ?label .
      }
    }
    LIMIT 1
  `

  const rows = await sparql.select(metaSparql)
  const row = rows[0]

  if (!row) {
    throw new Error(`Concept not found: ${input.concept_id}`)
  }

  const graphUri = row['graphUri'] ?? ''
  const label = row['label'] ?? input.concept_id
  const filePath = graphUri.replace(/^file:\/\/\//, '')

  const content = await readConceptByGraphUri(vaultPath, graphUri)

  return {
    identifier: input.concept_id,
    label,
    filePath,
    content,
  }
}
