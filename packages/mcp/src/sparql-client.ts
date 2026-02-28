/**
 * Minimal SPARQL HTTP client.
 *
 * Uses Node.js built-in fetch (available since Node 18, stable in Node 20).
 * No local graph — queries the ontobi-core SPARQL endpoint on demand.
 * Memory usage is proportional to the query neighbourhood, not the full corpus.
 */

export interface SparqlRow {
  [variable: string]: string
}

export class SparqlClient {
  private readonly endpoint: string

  constructor(endpoint: string) {
    this.endpoint = endpoint
  }

  /**
   * Execute a SPARQL SELECT query and return rows as plain objects.
   */
  async select(sparql: string): Promise<SparqlRow[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'application/sparql-results+json',
      },
      body: sparql,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`SPARQL endpoint error ${response.status}: ${text}`)
    }

    const json = (await response.json()) as {
      results: { bindings: Array<Record<string, { value: string }>> }
    }

    return json.results.bindings.map((binding) => {
      const row: SparqlRow = {}
      for (const [key, term] of Object.entries(binding)) {
        row[key] = term.value
      }
      return row
    })
  }

  /**
   * Execute a SPARQL ASK query and return the boolean result.
   */
  async ask(sparql: string): Promise<boolean> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'application/sparql-results+json',
      },
      body: sparql,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`SPARQL endpoint error ${response.status}: ${text}`)
    }

    const json = (await response.json()) as { boolean: boolean }
    return json.boolean
  }
}
