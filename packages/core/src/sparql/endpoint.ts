import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { OntobiStore } from '../rdf/store.js'

/**
 * SPARQL 1.1 HTTP endpoint.
 *
 * Exposes the Oxigraph store as a SPARQL service on localhost:<port>.
 * Used by ontobi-mcp (separate process) to query the store on demand.
 *
 * Supported transports:
 *   GET  /sparql?query=<encoded>
 *   POST /sparql  (body: SPARQL string, Content-Type: application/sparql-query)
 *
 * Supported operations: SELECT, ASK (returns SPARQL JSON); CONSTRUCT (returns Turtle)
 */
export class SparqlEndpoint {
  private readonly store: OntobiStore
  private readonly port: number
  private server: Server | null = null

  constructor(store: OntobiStore, port: number) {
    this.store = store
    this.port = port
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => resolve())
      this.server!.once('error', reject)
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()))
    })
    this.server = null
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS — allow MCP server on same machine
    res.setHeader('Access-Control-Allow-Origin', '127.0.0.1')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    let sparql: string | null = null

    try {
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)
        sparql = url.searchParams.get('query')
      } else if (req.method === 'POST') {
        sparql = await readBody(req)
      }

      if (!sparql || sparql.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Missing SPARQL query')
        return
      }

      // Detect operation type for content negotiation
      const upper = sparql.trimStart().toUpperCase()
      const isAsk = upper.startsWith('ASK')

      const accept = req.headers['accept'] ?? ''
      const wantsTurtle = accept.includes('text/turtle') || accept.includes('application/turtle')

      let body: string
      let contentType: string

      if (isAsk) {
        const result = this.store.ask(sparql)
        body = JSON.stringify({ boolean: result })
        contentType = 'application/sparql-results+json'
      } else if (wantsTurtle) {
        body = this.store.queryRaw(sparql, 'text/turtle')
        contentType = 'text/turtle'
      } else {
        body = this.store.queryRaw(sparql, 'application/sparql-results+json')
        contentType = 'application/sparql-results+json'
      }

      res.writeHead(200, { 'Content-Type': contentType })
      res.end(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end(`SPARQL error: ${message}`)
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
