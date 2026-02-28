import { Writer, DataFactory } from 'n3'
import type { ConceptMetadata } from '../types.js'
import { SKOS, SCHEMA, RDF } from '../parser/prefix-map.js'

const { namedNode, literal, quad } = DataFactory

/**
 * Generate N-Quads for a concept, placed in its own named graph.
 *
 * Named graph URI is used as the Oxigraph key for incremental invalidation:
 *   CLEAR GRAPH <graphUri> → INSERT DATA { GRAPH <graphUri> { ... } }
 *
 * @param concept   Parsed concept metadata
 * @param graphUri  Named graph URI, e.g. 'file:///_concepts/Centroid.md'
 * @returns N-Quads string (synchronous — Writer with no stream)
 */
export function generateTriples(concept: ConceptMetadata, graphUri: string): string {
  const graph = namedNode(graphUri)

  // Use the identifier as the subject URI
  const subject = namedNode(`urn:ontobi:concept:${concept.identifier}`)

  const quads = [
    // rdf:type schema:DefinedTerm
    quad(subject, namedNode(RDF.type), namedNode(SCHEMA.DefinedTerm), graph),

    // skos:prefLabel
    quad(subject, namedNode(SKOS.prefLabel), literal(concept.prefLabel), graph),

    // skos:definition
    ...(concept.definition
      ? [quad(subject, namedNode(SKOS.definition), literal(concept.definition), graph)]
      : []),

    // schema:identifier
    quad(subject, namedNode(SCHEMA.identifier), literal(concept.identifier), graph),

    // schema:dateCreated
    ...(concept.dateCreated
      ? [quad(subject, namedNode(SCHEMA.dateCreated), literal(concept.dateCreated), graph)]
      : []),

    // skos:broader
    ...concept.broader.map((id) =>
      quad(subject, namedNode(SKOS.broader), namedNode(`urn:ontobi:concept:${id}`), graph),
    ),

    // skos:narrower
    ...concept.narrower.map((id) =>
      quad(subject, namedNode(SKOS.narrower), namedNode(`urn:ontobi:concept:${id}`), graph),
    ),

    // skos:related
    ...concept.related.map((id) =>
      quad(subject, namedNode(SKOS.related), namedNode(`urn:ontobi:concept:${id}`), graph),
    ),
  ]

  // N3.js Writer in synchronous mode (no stream — collect to string)
  let output = ''
  const writer = new Writer({ format: 'N-Quads' })
  writer.addQuads(quads)
  writer.end((_error: Error | null, result: string) => {
    output = result
  })
  return output
}
