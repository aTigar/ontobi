# Ontobi

> **Work in Progress** — This software is under active development and is not ready for production use. APIs, interfaces, and behaviour will change without notice.

Ontology-guided retrieval for knowledge bases — SKOS concept graphs via MCP.

[![CI](https://github.com/aTigar/ontobi/actions/workflows/ci.yml/badge.svg)](https://github.com/aTigar/ontobi/actions/workflows/ci.yml)

## Packages

| Package | Language | Status | Description |
|---|---|---|---|
| [`ontobi-core`](ontobi-core) | Rust | 🚧 Phase 1 | Native binary: SKOS parser, Oxigraph RDF store, SPARQL 1.1 endpoint, file watcher, CLI |
| [`@ontobi/mcp`](packages/mcp) | TypeScript | 🔜 Phase 2 | MCP server: 3 tools for LLM agent retrieval scoped by SKOS ontology |
| [`@ontobi/obsidian`](packages/obsidian) | TypeScript | 🔜 Phase 3 | Obsidian plugin: vault event bridge + Cytoscape.js graph view |

## How it works

1. **`ontobi-core`** starts first — parses `.md` frontmatter into an Oxigraph RDF triplestore and exposes it as a SPARQL 1.1 endpoint on `localhost:14321`
2. **`@ontobi/mcp`** connects to that endpoint — 3 MCP tools let LLM agents navigate the SKOS ontology before loading document content
3. **`@ontobi/obsidian`** (optional) — thin Obsidian plugin that bridges vault change events to core and renders a Cytoscape.js graph view

The design principle is **metadata-first, content-on-demand**: the agent inspects concept labels and relationships before any full document body enters its context window.

## Quick Start

> Requires Rust ≥ 1.75 (`rustup`) and Node.js ≥ 20.19 with pnpm ≥ 10.

```bash
# Build the Rust binary
cargo build --release -p ontobi-core

# Index vault and start SPARQL endpoint (port 14321)
./target/release/ontobi serve --vault /path/to/vault --index

# Start MCP server (separate terminal)
pnpm install && pnpm build
ONTOBI_VAULT_PATH=/path/to/vault pnpm --filter @ontobi/mcp exec ontobi-mcp
```

## Development

```bash
# Rust (ontobi-core)
cargo build -p ontobi-core    # debug build
cargo test -p ontobi-core     # run unit tests

# TypeScript (mcp, obsidian)
pnpm install
pnpm build         # tsc --build (incremental)
pnpm test          # vitest for @ontobi/mcp
pnpm typecheck     # type-check without emitting
pnpm lint          # eslint all packages
pnpm format        # prettier all packages
```

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design document covering component inventory, MCP tool specifications, SPARQL query traces, and open engineering questions.

## Roadmap

See the [GitHub milestones](https://github.com/aTigar/ontobi/milestones) for the full plan.

| Milestone | Target | Scope |
|---|---|---|
| [v0.1.0 — MVP](https://github.com/aTigar/ontobi/milestone/1) | Mar 7 | `ontobi-core` + `@ontobi/mcp` functional, experiment-ready |
| [v0.2.0 — Plugin](https://github.com/aTigar/ontobi/milestone/2) | Mar 15 | `@ontobi/obsidian` Cytoscape.js view + vault event bridge |
| [v0.3.0 — Hardened](https://github.com/aTigar/ontobi/milestone/3) | Mar 25 | Error handling, logging, docs |

## Research Context

This software is being developed as part of a research paper for CIIT 2026 (IEEE). The experiment compares three retrieval strategies for LLM agents operating on educational knowledge bases:

- **Agent A** (treatment) — ontology-guided via ontobi-mcp
- **Agent B** (baseline) — vector RAG (flat cosine similarity)
- **Agent C** (floor) — unstructured filesystem access

## License

MIT
