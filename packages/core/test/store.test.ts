import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OntobiStore } from '../src/rdf/store.js'
import { generateTriples } from '../src/rdf/triple-generator.js'
import type { ConceptMetadata } from '../src/types.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const centroid: ConceptMetadata = {
  prefLabel: 'Centroid',
  definition: 'The center point of a cluster.',
  broader: ['concept-k-means-clustering'],
  narrower: [],
  related: ['concept-distance-metrics'],
  type: 'DefinedTerm',
  identifier: 'concept-centroid',
  dateCreated: '2026-01-17',
  aliases: [],
  tags: ['#concept'],
  filePath: '_concepts/Centroid.md',
}

const kMeans: ConceptMetadata = {
  prefLabel: 'K-Means Clustering',
  definition: 'A centroid-based clustering algorithm.',
  broader: [],
  narrower: ['concept-centroid'],
  related: [],
  type: 'DefinedTerm',
  identifier: 'concept-k-means-clustering',
  dateCreated: '2026-01-18',
  aliases: [],
  tags: ['#concept'],
  filePath: '_concepts/KMeansClustering.md',
}

const GRAPH_CENTROID = 'file:///_concepts/Centroid.md'
const GRAPH_KMEANS = 'file:///_concepts/KMeansClustering.md'

function tmpPath(name: string): string {
  return join(tmpdir(), `ontobi-test-${name}-${Date.now()}.nq`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OntobiStore', () => {
  let store: OntobiStore
  let persistPath: string

  beforeEach(async () => {
    persistPath = tmpPath('store')
    store = new OntobiStore()
    await store.initialize(persistPath)
  })

  afterEach(async () => {
    if (existsSync(persistPath)) await rm(persistPath)
  })

  // ---- initialization -------------------------------------------------------

  it('initializes without error on a fresh (non-existent) persistence path', () => {
    // Reaching here without throw is sufficient
    expect(store).toBeDefined()
  })

  it('throws if used before initialize()', async () => {
    const raw = new OntobiStore()
    expect(() => raw.query('SELECT * WHERE {}')).toThrow('not initialized')
  })

  // ---- loadTriples / query --------------------------------------------------

  it('loads N-Quads and retrieves them via SELECT', async () => {
    const nquads = generateTriples(centroid, GRAPH_CENTROID)
    await store.loadTriples(nquads)

    const results = store.query(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?label WHERE {
        GRAPH <${GRAPH_CENTROID}> {
          <urn:ontobi:concept:concept-centroid> skos:prefLabel ?label .
        }
      }
    `)

    expect(results.length).toBe(1)
    expect(results[0].get('label')).toBe('Centroid')
  })

  it('skips empty N-Quads without error', async () => {
    await expect(store.loadTriples('')).resolves.toBeUndefined()
    await expect(store.loadTriples('   \n  ')).resolves.toBeUndefined()
  })

  it('handles multiple graphs loaded independently', async () => {
    await store.loadTriples(generateTriples(centroid, GRAPH_CENTROID))
    await store.loadTriples(generateTriples(kMeans, GRAPH_KMEANS))

    const results = store.query(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?label WHERE {
        GRAPH ?g { ?s skos:prefLabel ?label . }
      }
      ORDER BY ?label
    `)

    const labels = results.map((r) => r.get('label'))
    expect(labels).toContain('Centroid')
    expect(labels).toContain('K-Means Clustering')
  })

  // ---- clearGraph ----------------------------------------------------------

  it('clearGraph removes triples from a named graph', async () => {
    await store.loadTriples(generateTriples(centroid, GRAPH_CENTROID))
    await store.loadTriples(generateTriples(kMeans, GRAPH_KMEANS))

    // Verify both loaded
    let results = store.query(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?label WHERE { GRAPH ?g { ?s skos:prefLabel ?label . } }
    `)
    expect(results.length).toBeGreaterThanOrEqual(2)

    // Clear centroid graph
    await store.clearGraph(GRAPH_CENTROID)

    results = store.query(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?label WHERE { GRAPH ?g { ?s skos:prefLabel ?label . } }
    `)
    const labels = results.map((r) => r.get('label'))
    expect(labels).not.toContain('Centroid')
    expect(labels).toContain('K-Means Clustering')
  })

  it('clearGraph on a non-existent graph is silent (DROP SILENT)', async () => {
    await expect(
      store.clearGraph('file:///nonexistent.md')
    ).resolves.toBeUndefined()
  })

  // ---- ask -----------------------------------------------------------------

  it('ASK returns true for an existing triple', async () => {
    await store.loadTriples(generateTriples(centroid, GRAPH_CENTROID))

    const result = store.ask(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      ASK { GRAPH ?g { <urn:ontobi:concept:concept-centroid> skos:prefLabel ?l } }
    `)
    expect(result).toBe(true)
  })

  it('ASK returns false for a non-existent triple', async () => {
    const result = store.ask(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      ASK { <urn:ontobi:concept:does-not-exist> skos:prefLabel ?l }
    `)
    expect(result).toBe(false)
  })

  // ---- queryRaw ------------------------------------------------------------

  it('queryRaw returns valid SPARQL JSON string', async () => {
    await store.loadTriples(generateTriples(centroid, GRAPH_CENTROID))

    const raw = store.queryRaw(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?label WHERE {
        GRAPH <${GRAPH_CENTROID}> { <urn:ontobi:concept:concept-centroid> skos:prefLabel ?label . }
      }
    `)

    const parsed = JSON.parse(raw) as { results: { bindings: unknown[] } }
    expect(parsed.results.bindings.length).toBeGreaterThan(0)
  })

  // ---- dump / restore ------------------------------------------------------

  it('dump writes an N-Quads file to disk', async () => {
    await store.loadTriples(generateTriples(centroid, GRAPH_CENTROID))
    await store.dump(persistPath)

    expect(existsSync(persistPath)).toBe(true)
    const content = await readFile(persistPath, 'utf-8')
    expect(content.trim().length).toBeGreaterThan(0)
    expect(content).toContain('concept-centroid')
  })

  it('restores from a dumped file on initialize()', async () => {
    // Load data into first store instance and dump
    await store.loadTriples(generateTriples(centroid, GRAPH_CENTROID))
    await store.dump(persistPath)

    // Create a second store instance pointing to the same file
    const store2 = new OntobiStore()
    await store2.initialize(persistPath)

    const results = store2.query(`
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?label WHERE {
        GRAPH <${GRAPH_CENTROID}> { <urn:ontobi:concept:concept-centroid> skos:prefLabel ?label . }
      }
    `)
    expect(results.length).toBe(1)
    expect(results[0].get('label')).toBe('Centroid')
  })

  // ---- getNeighbourhood ----------------------------------------------------

  it('getNeighbourhood returns the concept itself as a node', async () => {
    await store.loadTriples(generateTriples(centroid, GRAPH_CENTROID))

    const graph = await store.getNeighbourhood('concept-centroid', 1)
    const ids = graph.nodes.map((n) => n.identifier)
    expect(ids).toContain('concept-centroid')
  })

  it('getNeighbourhood returns edges to neighbours when both graphs are loaded', async () => {
    await store.loadTriples(generateTriples(centroid, GRAPH_CENTROID))
    await store.loadTriples(generateTriples(kMeans, GRAPH_KMEANS))

    const graph = await store.getNeighbourhood('concept-centroid', 1)

    // centroid has skos:broader → k-means-clustering
    const edgeSources = graph.edges.map((e) => e.source)
    const edgeTargets = graph.edges.map((e) => e.target)
    expect(
      edgeSources.includes('concept-centroid') || edgeTargets.includes('concept-centroid')
    ).toBe(true)
  })

  it('getNeighbourhood returns empty graph for unknown concept', async () => {
    const graph = await store.getNeighbourhood('concept-does-not-exist', 1)
    expect(graph.nodes).toHaveLength(0)
    expect(graph.edges).toHaveLength(0)
  })
})
