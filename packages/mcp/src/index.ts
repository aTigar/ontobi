#!/usr/bin/env node
/**
 * @ontobi/mcp — MCP server for ontology-guided retrieval
 *
 * Exposes three MCP tools to LLM agents:
 *   search_concepts        — keyword/semantic search over concept labels + definitions
 *   expand_concept_graph   — SKOS hierarchy traversal via SPARQL property paths
 *   get_concept_content    — load full .md body for selected concepts
 *
 * Config (environment variables):
 *   ONTOBI_SPARQL_ENDPOINT  URL of ontobi-core SPARQL endpoint (default: http://localhost:14321)
 *   ONTOBI_VAULT_PATH       Absolute path to vault root (required)
 *
 * Requires ontobi-core to be running:
 *   ontobi serve --vault <path> [--index]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SparqlClient } from './sparql-client.js'
import { searchConceptsInput, searchConcepts } from './tools/search-concepts.js'
import { expandConceptGraphInput, expandConceptGraph } from './tools/expand-concept-graph.js'
import { getConceptContentInput, getConceptContent } from './tools/get-concept-content.js'

// ── Config ──────────────────────────────────────────────────────────────────

const sparqlEndpoint = process.env['ONTOBI_SPARQL_ENDPOINT'] ?? 'http://localhost:14321'
const vaultPath = process.env['ONTOBI_VAULT_PATH']

if (!vaultPath) {
  console.error('[ontobi-mcp] Error: ONTOBI_VAULT_PATH environment variable is required.')
  console.error('[ontobi-mcp] Example: ONTOBI_VAULT_PATH=/path/to/vault ontobi-mcp')
  process.exit(1)
}

const sparql = new SparqlClient(sparqlEndpoint)

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'ontobi-mcp',
  version: '0.1.0',
})

server.registerTool(
  'search_concepts',
  {
    title: 'Search Concepts',
    description:
      'Search for concepts in the knowledge base by keyword. ' +
      'Matches against concept labels, aliases, and definitions using a multi-tier engine. ' +
      'Each result includes 1-hop SKOS neighbors (broader, narrower, related concepts) ' +
      'so you can discover the local graph topology without a separate call. ' +
      'Inspect the `neighbors` field to find related concepts worth exploring. ' +
      'Returns concept metadata only — use get_concept_content to load full bodies.',
    inputSchema: searchConceptsInput,
  },
  async (input) => {
    const results = await searchConcepts(input, sparql)
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    }
  },
)

server.registerTool(
  'expand_concept_graph',
  {
    title: 'Expand Concept Graph',
    description:
      'Traverse the SKOS ontology from a concept outward up to N hops. ' +
      'Returns nodes and edges (broader/narrower/related) — no document bodies. ' +
      'search_concepts already includes 1-hop neighbors; use this tool for deeper ' +
      'traversal (depth 2+) or when you need the full edge structure.',
    inputSchema: expandConceptGraphInput,
  },
  async (input) => {
    const graph = await expandConceptGraph(input, sparql)
    return {
      content: [{ type: 'text', text: JSON.stringify(graph, null, 2) }],
    }
  },
)

server.registerTool(
  'get_concept_content',
  {
    title: 'Get Concept Content',
    description:
      'Load the full Markdown body of a concept from the knowledge base. ' +
      'Reads the .md file directly from disk. ' +
      'Call this only after inspecting metadata via search_concepts and expand_concept_graph ' +
      'to avoid loading irrelevant content into the context window.',
    inputSchema: getConceptContentInput,
  },
  async (input) => {
    const result = await getConceptContent(input, sparql, vaultPath!)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              identifier: result.identifier,
              label: result.label,
              file_path: result.filePath,
              content: result.content,
            },
            null,
            2,
          ),
        },
      ],
    }
  },
)

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()

console.error(`[ontobi-mcp] Connecting to SPARQL endpoint: ${sparqlEndpoint}`)
console.error(`[ontobi-mcp] Vault path: ${vaultPath}`)
console.error('[ontobi-mcp] Transport: stdio')

await server.connect(transport)
