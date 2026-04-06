import { z } from 'zod'
import type { SparqlClient } from '../sparql-client.js'
import { graphUriToRelPath } from '../file-reader.js'

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
    .default(1)
    .describe(
      'Traversal depth in hops (1–5, default 1). ' +
        'Depth 1 returns immediate neighbours only. ' +
        'For wider exploration call this tool multiple times from different starting concepts.',
    ),
})

export type ExpandConceptGraphInput = z.infer<typeof expandConceptGraphInput>

export interface GraphNode {
  id: string
  label: string
  definition: string
  /** Vault-relative file path (forward-slash, no URL encoding). */
  file_path: string
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

// Reason: Oxigraph does not support SPARQL 1.1 {n,m} property path repetition.
// Build explicit UNION chains instead. Depth 1 is the recommended default —
// the agent can call this tool multiple times to traverse wider neighbourhoods.
const REL = '(skos:broader|skos:narrower|skos:related)'

/** Returns UNION of 1..depth single-hop chains for node discovery. */
function nodePathUnion(subjectUri: string, depth: number): string {
  return Array.from(
    { length: depth },
    (_, i) =>
      `  { <${subjectUri}> ${Array(i + 1)
        .fill(REL)
        .join('/')} ?node . }`,
  ).join('\n  UNION\n')
}

/** Returns UNION of the center + 0..depth-1 hop chains for edge source discovery. */
function intermediateUnion(subjectUri: string, depth: number): string {
  const branches = [`  { BIND(<${subjectUri}> AS ?intermediate) }`]
  for (let i = 1; i < depth; i++) {
    branches.push(`  { <${subjectUri}> ${Array(i).fill(REL).join('/')} ?intermediate . }`)
  }
  return branches.join('\n  UNION\n')
}

/**
 * expand_concept_graph tool handler.
 *
 * Traverses the SKOS hierarchy up to `depth` hops from the given concept.
 * Returns node + edge metadata only — no document bodies.
 *
 * Default depth is 1 (immediate neighbours). The agent can call this tool
 * multiple times from different starting concepts to explore wider neighbourhoods
 * without loading large subgraphs into the context window in one shot.
 */
export async function expandConceptGraph(
  input: ExpandConceptGraphInput,
  sparql: SparqlClient,
): Promise<ConceptGraph> {
  const subjectUri = `urn:ontobi:item:${input.concept_id}`

  const nodeSparql = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <https://schema.org/>

    SELECT DISTINCT ?node ?label ?identifier ?definition ?graph WHERE {
      ${nodePathUnion(subjectUri, input.depth)}
      UNION
      { BIND(<${subjectUri}> AS ?node) }
      GRAPH ?graph {
        ?node schema:identifier ?identifier .
        ?node skos:prefLabel ?label .
        OPTIONAL { ?node skos:definition ?definition . }
      }
    }
  `

  const edgeSparql = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <https://schema.org/>

    SELECT DISTINCT ?sourceId ?targetId ?relation WHERE {
      {
${intermediateUnion(subjectUri, input.depth)}
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
    const graphUri = row['graph'] ?? ''
    nodes.push({
      id,
      label: row['label'] ?? id,
      definition: row['definition'] ?? '',
      file_path: graphUri ? graphUriToRelPath(graphUri) : '',
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
