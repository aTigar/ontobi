import type { GraphData, SparqlResult, SparqlBindings } from '../types.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * OntobiStore — Oxigraph wrapper with manual N-Quads persistence.
 *
 * Oxigraph WASM (npm) is in-memory only (no RocksDB in the JS build).
 * Persistence is achieved by:
 *   - restore(): load N-Quads from disk on startup
 *   - dump():    serialize to N-Quads on shutdown (called by OntobiCore.stop())
 *
 * Oxigraph is loaded lazily via dynamic import to avoid WASM init at module load time.
 */
export class OntobiStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store: any = null

  /**
   * Initialize the Oxigraph Store. Attempts to restore from persistencePath.
   */
  async initialize(persistencePath: string): Promise<void> {
    // Dynamic import — Oxigraph WASM must be initialized before use in Node.js
    const oxigraph = await import('oxigraph')
    this.store = new oxigraph.Store()

    if (existsSync(persistencePath)) {
      const nquads = await readFile(persistencePath, 'utf-8')
      if (nquads.trim().length > 0) {
        this.store.load(nquads, { format: 'application/n-quads' })
      }
    }
  }

  /**
   * Load N-Quads into the store. Called by OntobiCore.reindexFile().
   */
  async loadTriples(nquads: string): Promise<void> {
    this.assertInitialized()
    if (nquads.trim().length > 0) {
      this.store.load(nquads, { format: 'application/n-quads' })
    }
  }

  /**
   * Drop a named graph. Called before reindexing a file (incremental update).
   * SPARQL Update: DROP SILENT GRAPH <graphUri>
   */
  async clearGraph(graphUri: string): Promise<void> {
    this.assertInitialized()
    this.store.update(`DROP SILENT GRAPH <${graphUri}>`)
  }

  /**
   * Execute a SPARQL SELECT query. Returns an array of binding maps.
   */
  query(sparql: string): SparqlResult {
    this.assertInitialized()
    const raw = this.store.query(sparql) as Iterable<Map<string, { value: string }>>
    const results: SparqlResult = []
    for (const row of raw) {
      const bindings: SparqlBindings = new Map()
      for (const [key, term] of row.entries()) {
        bindings.set(key, term.value)
      }
      results.push(bindings)
    }
    return results
  }

  /**
   * Execute a SPARQL ASK query.
   */
  ask(sparql: string): boolean {
    this.assertInitialized()
    return this.store.query(sparql) as boolean
  }

  /**
   * Return the N-Quads string of the full store (for direct SPARQL endpoint use).
   */
  queryRaw(sparql: string, format = 'application/sparql-results+json'): string {
    this.assertInitialized()
    return this.store.query(sparql, { results_format: format }) as string
  }

  /**
   * Get the concept neighbourhood via SPARQL property paths.
   * Used by ontobi-obsidian Cytoscape.js view and indirectly by ontobi-mcp.
   */
  async getNeighbourhood(conceptId: string, depth = 2): Promise<GraphData> {
    this.assertInitialized()
    const subjectUri = `urn:ontobi:concept:${conceptId}`
    const depthClause = depth > 1 ? `{1,${depth}}` : ''

    const sparql = `
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      PREFIX schema: <https://schema.org/>

      SELECT DISTINCT ?node ?label ?identifier ?pred WHERE {
        {
          <${subjectUri}> (skos:broader|skos:narrower|skos:related)${depthClause} ?node .
          ?node skos:prefLabel ?label .
          ?node schema:identifier ?identifier .
          BIND("outgoing" AS ?pred)
        } UNION {
          ?node (skos:broader|skos:narrower|skos:related)${depthClause} <${subjectUri}> .
          ?node skos:prefLabel ?label .
          ?node schema:identifier ?identifier .
          BIND("incoming" AS ?pred)
        } UNION {
          BIND(<${subjectUri}> AS ?node)
          <${subjectUri}> skos:prefLabel ?label .
          <${subjectUri}> schema:identifier ?identifier .
          BIND("self" AS ?pred)
        }
      }
    `

    const edgeSparql = `
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

      SELECT DISTINCT ?source ?target ?relation WHERE {
        VALUES ?relation { skos:broader skos:narrower skos:related }
        ?source ?relation ?target .
        FILTER(?source = <${subjectUri}> || ?target = <${subjectUri}>)
      }
    `

    const nodeRows = this.query(sparql)
    const edgeRows = this.query(edgeSparql)

    const seenNodes = new Set<string>()
    const nodes: GraphData['nodes'] = []

    for (const row of nodeRows) {
      const uri = row.get('node') ?? ''
      if (seenNodes.has(uri)) continue
      seenNodes.add(uri)
      const id = row.get('identifier') ?? uri
      nodes.push({
        id,
        label: row.get('label') ?? id,
        identifier: id,
        filePath: '',  // resolved by ontobi-mcp get_concept_content if needed
      })
    }

    const edges: GraphData['edges'] = edgeRows
      .map((row) => {
        const sourceUri = row.get('source') ?? ''
        const targetUri = row.get('target') ?? ''
        const relUri = row.get('relation') ?? ''
        const rel = relUri.split('#')[1] as 'broader' | 'narrower' | 'related' | undefined
        if (!rel) return null
        return {
          source: sourceUri.replace('urn:ontobi:concept:', ''),
          target: targetUri.replace('urn:ontobi:concept:', ''),
          relation: rel,
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)

    return { nodes, edges }
  }

  /**
   * Serialize the full store to N-Quads and write to disk.
   * Called by OntobiCore.stop().
   */
  async dump(persistencePath: string): Promise<void> {
    this.assertInitialized()
    const nquads = this.store.dump({ format: 'application/n-quads' }) as string
    await mkdir(dirname(persistencePath), { recursive: true })
    await writeFile(persistencePath, nquads, 'utf-8')
  }

  private assertInitialized(): void {
    if (this.store === null) {
      throw new Error('OntobiStore is not initialized. Call initialize() first.')
    }
  }
}
