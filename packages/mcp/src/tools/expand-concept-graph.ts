import { z } from 'zod'
import type { SparqlClient } from '../sparql-client.js'

export const expandConceptGraphInput = z.object({
  concept_id: z
    .string()
    .describe(
      'Concept identifier, e.g. "concept-centroid". Use search_concepts to find identifiers.',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe('Traversal depth in hops (1–5, default 2)'),
})

export type ExpandConceptGraphInput = z.infer<typeof expandConceptGraphInput>

export interface GraphNode {
  id: string
  label: string
  definition: string
}

export interface GraphEdge {
  source: string
  target: string
  relation: 'broader' | 'narrower' | 'related'
}

export interface ConceptGraph {
  center: string
  depth: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * expand_concept_graph tool handler.
 *
 * Traverses the SKOS hierarchy up to `depth` hops from the given concept
 * using SPARQL property paths. Returns node + edge metadata only —
 * no document bodies in the response.
 *
 * The agent uses this output to decide which concepts are relevant, then
 * calls get_concept_content selectively to load only the needed bodies.
 */
export async function expandConceptGraph(
  input: ExpandConceptGraphInput,
  sparql: SparqlClient,
): Promise<ConceptGraph> {
  const subjectUri = `urn:ontobi:concept:${input.concept_id}`
  const pathExpr =
    input.depth > 1
      ? `(skos:broader|skos:narrower|skos:related){1,${input.depth}}`
      : '(skos:broader|skos:narrower|skos:related)'

  const nodeSparql = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <https://schema.org/>

    SELECT DISTINCT ?node ?label ?identifier ?definition WHERE {
      {
        <${subjectUri}> ${pathExpr} ?node .
      } UNION {
        BIND(<${subjectUri}> AS ?node)
      }
      ?node schema:identifier ?identifier .
      ?node skos:prefLabel ?label .
      OPTIONAL { ?node skos:definition ?definition . }
    }
  `

  const edgeSparql = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <https://schema.org/>

    SELECT DISTINCT ?sourceId ?targetId ?relation WHERE {
      {
        <${subjectUri}> (skos:broader|skos:narrower|skos:related){0,${input.depth}} ?intermediate .
      } UNION {
        BIND(<${subjectUri}> AS ?intermediate)
      }
      VALUES ?pred { skos:broader skos:narrower skos:related }
      ?intermediate ?pred ?neighbour .
      ?intermediate schema:identifier ?sourceId .
      ?neighbour schema:identifier ?targetId .
      BIND(REPLACE(STR(?pred), ".*#", "") AS ?relation)
    }
  `

  const [nodeRows, edgeRows] = await Promise.all([
    sparql.select(nodeSparql),
    sparql.select(edgeSparql),
  ])

  const seenNodes = new Set<string>()
  const nodes: GraphNode[] = []
  for (const row of nodeRows) {
    const id = row['identifier'] ?? ''
    if (!id || seenNodes.has(id)) continue
    seenNodes.add(id)
    nodes.push({
      id,
      label: row['label'] ?? id,
      definition: row['definition'] ?? '',
    })
  }

  const edges: GraphEdge[] = edgeRows
    .map((row) => {
      const rel = row['relation'] as 'broader' | 'narrower' | 'related' | undefined
      if (!rel) return null
      return {
        source: row['sourceId'] ?? '',
        target: row['targetId'] ?? '',
        relation: rel,
      }
    })
    .filter((e): e is GraphEdge => e !== null)

  return {
    center: input.concept_id,
    depth: input.depth,
    nodes,
    edges,
  }
}
