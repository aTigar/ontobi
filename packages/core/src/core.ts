import type { OntobiConfig, GraphData, SparqlResult } from './types.js'
import { OntobiStore } from './rdf/store.js'
import { SparqlEndpoint } from './sparql/endpoint.js'
import { parseFrontmatter } from './parser/frontmatter.js'
import { generateTriples } from './rdf/triple-generator.js'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * OntobiCore — the primary engine.
 *
 * Lifecycle:
 *   const core = new OntobiCore(config)
 *   await core.start()          // init store + SPARQL endpoint
 *   await core.indexVault()     // optional: parse all .md files
 *   // ... use via SPARQL endpoint or programmatic API ...
 *   await core.stop()           // flush store + stop endpoint
 *
 * File watching is caller-owned:
 *   CLI:    chokidar → core.reindexFile() / core.removeFile()
 *   Plugin: Obsidian vault events → same
 */
export class OntobiCore {
  private readonly config: Required<OntobiConfig>
  private store: OntobiStore | null = null
  private endpoint: SparqlEndpoint | null = null

  constructor(config: OntobiConfig) {
    this.config = {
      vaultPath: config.vaultPath,
      sparqlPort: config.sparqlPort ?? 14321,
      persistencePath: config.persistencePath ?? join(config.vaultPath, '.ontobi', 'store.nq'),
    }
  }

  /**
   * Initialise the Oxigraph store and start the SPARQL HTTP endpoint.
   * Does NOT index the vault — call indexVault() explicitly.
   * Attempts to restore from persistencePath if the file exists.
   */
  async start(): Promise<void> {
    this.store = new OntobiStore()
    await this.store.initialize(this.config.persistencePath)

    this.endpoint = new SparqlEndpoint(this.store, this.config.sparqlPort)
    await this.endpoint.start()
  }

  /**
   * Stop the SPARQL endpoint and flush the store to disk.
   */
  async stop(): Promise<void> {
    await this.endpoint?.stop()
    await this.store?.dump(this.config.persistencePath)
    this.endpoint = null
    this.store = null
  }

  /**
   * Scan vaultPath for all .md files and index them.
   * Not called automatically by start(). Caller decides when to trigger.
   */
  async indexVault(): Promise<void> {
    this.assertStarted()
    // readdir with recursive:true is available in Node 18.17+ (Node 20 LTS)
    const entries = await readdir(this.config.vaultPath, { recursive: true })
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.endsWith('.md')) {
        await this.reindexFile(join(this.config.vaultPath, entry))
      }
    }
  }

  /**
   * Parse a single .md file and (re)load it into the store.
   * Called by CLI chokidar watcher or Obsidian vault.on('modify').
   */
  async reindexFile(filePath: string): Promise<void> {
    this.assertStarted()
    const content = await readFile(filePath, 'utf-8')
    const relPath = relative(this.config.vaultPath, filePath).replace(/\\/g, '/')
    const concept = parseFrontmatter(content, relPath)
    if (concept === null) return // not a SKOS concept file — skip

    const graphUri = `file:///${relPath}`
    await this.store!.clearGraph(graphUri)
    const nquads = generateTriples(concept, graphUri)
    await this.store!.loadTriples(nquads)
  }

  /**
   * Remove a concept file from the store.
   * Called on vault.on('delete') or chokidar 'unlink' event.
   */
  async removeFile(filePath: string): Promise<void> {
    this.assertStarted()
    const relPath = relative(this.config.vaultPath, filePath).replace(/\\/g, '/')
    await this.store!.clearGraph(`file:///${relPath}`)
  }

  /**
   * Execute a raw SPARQL SELECT query.
   * Used by ontobi-obsidian and test suites.
   */
  async query(sparql: string): Promise<SparqlResult> {
    this.assertStarted()
    return this.store!.query(sparql)
  }

  /**
   * Return the concept neighbourhood up to `depth` hops.
   * Used by ontobi-obsidian Cytoscape.js graph view.
   */
  async getNeighbourhood(conceptId: string, depth = 2): Promise<GraphData> {
    this.assertStarted()
    return this.store!.getNeighbourhood(conceptId, depth)
  }

  private assertStarted(): void {
    if (this.store === null || this.endpoint === null) {
      throw new Error('OntobiCore is not started. Call start() first.')
    }
  }
}
