/**
 * @ontobi/core — public API
 *
 * Primary entry point. Consumers (plugin, CLI, tests) import from here.
 */
export { OntobiCore } from './core.js'
export type {
  OntobiConfig,
  ConceptMetadata,
  GraphData,
  GraphNode,
  GraphEdge,
  SparqlResult,
  SparqlBindings,
} from './types.js'
