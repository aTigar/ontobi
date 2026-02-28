#!/usr/bin/env node
/**
 * ontobi CLI
 *
 * Usage:
 *   ontobi serve --vault <path> [--port 14321] [--index]
 *   ontobi index --vault <path> [--port 14321]
 *
 * Commands:
 *   serve  Start the SPARQL endpoint (optionally reindex at startup)
 *   index  One-shot vault index then exit (for CI / cache rebuild)
 */

import { OntobiCore } from '../core.js'
import { watch } from 'chokidar'
import { resolve } from 'node:path'

const args = process.argv.slice(2)

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg?.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        result[key] = next
        i++
      } else {
        result[key] = true
      }
    } else if (!result['_command']) {
      result['_command'] = arg ?? ''
    }
  }
  return result
}

const opts = parseArgs(args)
const command = opts['_command'] as string | undefined

if (!command || command === 'help' || opts['help'] || opts['h']) {
  console.log(`
ontobi — ontology-guided SKOS knowledge graph engine

Commands:
  serve  Start SPARQL endpoint (default port 14321)
  index  One-shot index then exit

Options:
  --vault <path>   Required: absolute path to vault root
  --port  <n>      SPARQL endpoint port (default: 14321)
  --index          Re-index vault at startup (serve command only)
  --persist <path> N-Quads persistence file (default: <vault>/.ontobi/store.nq)
`.trim())
  process.exit(0)
}

const vaultPath = opts['vault']
if (typeof vaultPath !== 'string' || vaultPath.trim() === '') {
  console.error('Error: --vault <path> is required')
  process.exit(1)
}

const resolvedVault = resolve(vaultPath)
const sparqlPort = opts['port'] ? Number(opts['port']) : 14321
const persistencePath = typeof opts['persist'] === 'string' ? opts['persist'] : undefined
const shouldIndex = opts['index'] === true

const core = new OntobiCore({
  vaultPath: resolvedVault,
  sparqlPort,
  ...(persistencePath !== undefined ? { persistencePath } : {}),
})

async function run(): Promise<void> {
  await core.start()
  console.log(`[ontobi] SPARQL endpoint: http://localhost:${sparqlPort}`)
  console.log(`[ontobi] Vault: ${resolvedVault}`)

  if (command === 'index' || shouldIndex) {
    console.log('[ontobi] Indexing vault...')
    await core.indexVault()
    console.log('[ontobi] Index complete.')
  }

  if (command === 'index') {
    await core.stop()
    console.log('[ontobi] Store saved. Exiting.')
    process.exit(0)
  }

  // serve mode — watch for changes
  const watcher = watch(`${resolvedVault}/**/*.md`, {
    ignoreInitial: true,
    persistent: true,
  })

  watcher.on('change', (path) => {
    void core.reindexFile(path).then(() =>
      console.log(`[ontobi] Reindexed: ${path}`),
    )
  })

  watcher.on('unlink', (path) => {
    void core.removeFile(path).then(() =>
      console.log(`[ontobi] Removed: ${path}`),
    )
  })

  console.log('[ontobi] Watching for changes. Press Ctrl+C to stop.')

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[ontobi] Shutting down...')
    await watcher.close()
    await core.stop()
    console.log('[ontobi] Store saved. Goodbye.')
    process.exit(0)
  })
}

run().catch((err) => {
  console.error('[ontobi] Fatal error:', err)
  process.exit(1)
})
