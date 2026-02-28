import { describe, it, expect } from 'vitest'
import { generateTriples } from '../src/rdf/triple-generator.js'
import type { ConceptMetadata } from '../src/types.js'

const centroid: ConceptMetadata = {
  prefLabel: 'Centroid',
  definition: 'The center point of a cluster computed as the mean of all points.',
  broader: ['concept-k-means-clustering'],
  narrower: [],
  related: ['concept-distance-metrics'],
  type: 'DefinedTerm',
  identifier: 'concept-centroid',
  dateCreated: '2026-02-10',
  aliases: ['Cluster Center'],
  tags: ['#concept'],
  filePath: '_concepts/Centroid.md',
}

const GRAPH_URI = 'file:///_concepts/Centroid.md'

describe('generateTriples', () => {
  it('returns a non-empty N-Quads string', () => {
    const nquads = generateTriples(centroid, GRAPH_URI)
    expect(typeof nquads).toBe('string')
    expect(nquads.trim().length).toBeGreaterThan(0)
  })

  it('includes the concept subject URI', () => {
    const nquads = generateTriples(centroid, GRAPH_URI)
    expect(nquads).toContain('urn:ontobi:concept:concept-centroid')
  })

  it('includes rdf:type triple', () => {
    const nquads = generateTriples(centroid, GRAPH_URI)
    expect(nquads).toContain('22-rdf-syntax-ns#type')
    expect(nquads).toContain('schema.org/DefinedTerm')
  })

  it('includes skos:prefLabel triple', () => {
    const nquads = generateTriples(centroid, GRAPH_URI)
    expect(nquads).toContain('skos/core#prefLabel')
    expect(nquads).toContain('"Centroid"')
  })

  it('includes skos:definition triple', () => {
    const nquads = generateTriples(centroid, GRAPH_URI)
    expect(nquads).toContain('skos/core#definition')
    expect(nquads).toContain('center point')
  })

  it('includes skos:broader triple', () => {
    const nquads = generateTriples(centroid, GRAPH_URI)
    expect(nquads).toContain('skos/core#broader')
    expect(nquads).toContain('concept-k-means-clustering')
  })

  it('includes skos:related triple', () => {
    const nquads = generateTriples(centroid, GRAPH_URI)
    expect(nquads).toContain('skos/core#related')
    expect(nquads).toContain('concept-distance-metrics')
  })

  it('places all triples in the named graph', () => {
    const nquads = generateTriples(centroid, GRAPH_URI)
    // Every N-Quad line ends with <graphUri> .
    const lines = nquads.trim().split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toContain(GRAPH_URI)
    }
  })

  it('produces one triple per broader/related entry', () => {
    const concept: ConceptMetadata = {
      ...centroid,
      broader: ['concept-a', 'concept-b'],
      related: ['concept-c', 'concept-d', 'concept-e'],
      narrower: ['concept-f'],
    }
    const nquads = generateTriples(concept, GRAPH_URI)
    const broaderCount = (nquads.match(/skos\/core#broader/g) ?? []).length
    const relatedCount = (nquads.match(/skos\/core#related/g) ?? []).length
    const narrowerCount = (nquads.match(/skos\/core#narrower/g) ?? []).length
    expect(broaderCount).toBe(2)
    expect(relatedCount).toBe(3)
    expect(narrowerCount).toBe(1)
  })

  it('handles concept with no relations', () => {
    const isolated: ConceptMetadata = { ...centroid, broader: [], narrower: [], related: [] }
    const nquads = generateTriples(isolated, GRAPH_URI)
    expect(nquads).not.toContain('skos/core#broader')
    expect(nquads).not.toContain('skos/core#narrower')
    expect(nquads).not.toContain('skos/core#related')
  })
})
