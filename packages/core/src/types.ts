/**
 * Shared types for @ontobi/core public API.
 */

export interface OntobiConfig {
  /** Absolute path to the vault root directory */
  vaultPath: string
  /** SPARQL endpoint port (default: 14321) */
  sparqlPort?: number
  /** Path to N-Quads persistence file (default: <vaultPath>/.ontobi/store.nq) */
  persistencePath?: string
}

/** Typed concept metadata extracted from .md YAML frontmatter */
export interface ConceptMetadata {
  prefLabel: string
  definition: string
  broader: string[]    // resolved concept identifiers, e.g. ['concept-ensemble-methods']
  narrower: string[]
  related: string[]
  type: string         // always 'DefinedTerm'
  identifier: string   // e.g. 'concept-centroid'
  dateCreated: string  // normalized ISO date, e.g. '2026-01-17'
  aliases: string[]
  tags: string[]
  /** File path relative to vault root, e.g. '_concepts/Centroid.md' */
  filePath: string
}

export interface GraphNode {
  id: string
  label: string
  identifier: string
  filePath: string
}

export interface GraphEdge {
  source: string
  target: string
  relation: 'broader' | 'narrower' | 'related'
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** Row of SPARQL SELECT results: variable name → string value */
export type SparqlBindings = Map<string, string>
export type SparqlResult = SparqlBindings[]
