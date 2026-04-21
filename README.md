# Ontobi

> **Work in Progress.** This software is under active development and is not ready for production use. APIs, interfaces, and behaviour will change without notice.

Ontology-guided retrieval for knowledge bases. SKOS concept graphs exposed to LLM agents via MCP, plus an optional CSL/Zotero bibliography mode.

[![CI](https://github.com/aTigar/ontobi/actions/workflows/ci.yml/badge.svg)](https://github.com/aTigar/ontobi/actions/workflows/ci.yml)

## Packages

| Package | Language | Status | Description |
|---|---|---|---|
| [`ontobi-core`](ontobi-core) | Rust | active | Native binary. SKOS + CSL parser, Oxigraph RDF store, SPARQL 1.1 endpoint, file watcher, CLI. |
| [`@ontobi/mcp`](packages/mcp) | TypeScript | active | MCP server. Three tools (`search_concepts`, `expand_concept_graph`, `get_concept_content`) that let LLM agents navigate the SKOS graph before loading document bodies. |
| [`@ontobi/obsidian`](packages/obsidian) | TypeScript | post-MVP | Obsidian plugin. Vault event bridge plus Cytoscape.js graph view. |

## How it works

1. **`ontobi-core`** walks the vault on startup. Every `.md` file with SKOS frontmatter becomes an RDF named graph in an in-memory [Oxigraph](https://github.com/oxigraph/oxigraph) triplestore. The graph is persisted to `.ontobi/store.nq` (N-Quads) on shutdown and restored on startup when `--no-index` is passed.
2. **SPARQL 1.1 endpoint** serves queries on `http://127.0.0.1:14321/sparql` (configurable with `--port`). `GET ?query=…` and `POST` with `Content-Type: application/sparql-query` are both supported. Responses are `application/sparql-results+json`.
3. **`@ontobi/mcp`** is a separate Node.js process. It exposes three MCP tools to any LLM agent. Tools issue SPARQL queries against the endpoint and, for content, read `.md` files directly from the vault.
4. **File watcher** (inside `ontobi-core`, debounced 500 ms) reindexes individual files as they change, so the agent always sees the current vault state.

The design principle is **metadata-first, content-on-demand**. The agent inspects concept labels, definitions, and neighbourhood edges before any full document body enters its context window.

## Quick Start

Requires Rust >= 1.75 (`rustup`) and Node.js >= 20.19 with pnpm >= 10.

```bash
# Build the Rust binary
cargo build --release -p ontobi-core

# Index vault and start the SPARQL endpoint (port 14321, indexes on startup)
./target/release/ontobi serve --vault /path/to/vault

# Fast restart (skip indexing, restore from persisted store.nq)
./target/release/ontobi serve --vault /path/to/vault --no-index

# Enable CSL/Zotero bibliography indexing alongside SKOS
./target/release/ontobi serve --vault /path/to/vault --csl

# Start the MCP server (separate terminal, stdio transport)
pnpm install && pnpm build
ONTOBI_VAULT_PATH=/path/to/vault pnpm --filter @ontobi/mcp exec ontobi-mcp
```

### CLI subcommands (`ontobi-core`)

| Command | Flags | Purpose |
|---|---|---|
| `ontobi serve` | `--vault <path>`, `--port <n>` (default 14321), `--no-index`, `--csl` | Index the vault (unless `--no-index`) and run the SPARQL endpoint until SIGINT. |
| `ontobi index` | `--vault <path>`, `--csl` | Index once, persist `store.nq`, and exit. Used by CI and cache rebuilds. |

`--vault` can be omitted if `ONTOBI_VAULT_PATH` is set.

### Environment variables

| Var | Consumer | Description |
|---|---|---|
| `ONTOBI_VAULT_PATH` | `ontobi-core`, `@ontobi/mcp` | Absolute path to the vault root. Required for the MCP server. Falls back from `--vault` for `ontobi-core`. |
| `ONTOBI_SPARQL_ENDPOINT` | `@ontobi/mcp` | SPARQL endpoint URL. Default `http://localhost:14321`. |

## MCP tools

All three tools return metadata only, except `get_concept_content` which loads a single full body by design. All responses include a vault-relative `file_path` so the agent can cite sources accurately.

### `search_concepts(query, limit?)`

Keyword search over the concept pool. Runs a five-tier fallback engine:

1. **EXACT_LABEL**. Case-insensitive equality with `skos:prefLabel`. Always contributes.
2. **EXACT_ALIAS**. Case-insensitive equality with any `skos:altLabel`. Always contributes. Useful for acronyms (e.g. "RBAC" matches "Role-Based Access Control").
3. **PHRASE_SUBSTRING**. The full query is a substring of a label, alias, or definition.
4. **TOKEN_MATCH**. At least one query token hits a label, alias, or definition as a whole word. Scored with heavy label weighting and hub-node damping so high-degree "bridging" concepts do not crowd out real targets. Tier 4b collects definition-only matches at a reduced score.
5. **FUZZY_TRIGRAM**. Last-resort trigram Jaccard match on labels and aliases. Fires only when tiers 3 and 4 are empty.

Returns an array of `{ identifier, label, definition, file_path, aliases, broader[], narrower[], related[] }`. The broader/narrower/related arrays are the 1-hop SKOS neighbourhood, fetched in one batched query so the agent can decide whether to expand further without another round-trip.

### `expand_concept_graph(concept_id, depth?)`

SPARQL property-path traversal of `skos:broader|skos:narrower|skos:related` up to `depth` hops (1 to 5, default 1). Returns `{ center, depth, nodes[], edges[] }` where each node carries `file_path`, `aliases`, and its definition. Oxigraph does not support `{n,m}` repetition, so the implementation builds explicit UNION chains.

### `get_concept_content(concept_id)`

Resolves the concept's named graph URI and reads the `.md` body from disk via `fs.readFile`. Returns `{ identifier, label, file_path, content }`. Intended as the last step, after metadata inspection.

## Frontmatter indexed

| YAML key | RDF predicate | Notes |
|---|---|---|
| `identifier` | `schema:identifier` | Stable concept ID. Feeds the URI `urn:ontobi:item:<id>`. |
| `aliases:` (list) | `skos:altLabel` | Searchable alternate names. One triple per entry. |
| `prefLabel`, `title`, or filename | `skos:prefLabel` | Human-readable label. |
| `definition` | `skos:definition` | One-sentence definition. |
| `broader:`, `narrower:`, `related:` (lists of `[[wikilinks]]`) | `skos:broader`, `skos:narrower`, `skos:related` | Wikilinks are resolved to concept IDs at index time. |

Every concept lives in its own named graph (`file:///<vault-relative-path>`), so single-file reindex and removal are trivial. The subject URI scheme is `urn:ontobi:item:<identifier>` (renamed from the earlier `urn:ontobi:concept:` prefix when the generic `ParsedItem` parser landed to share code with CSL/Zotero entries).

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

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design document covering component inventory, the SPARQL query traces behind each MCP tool, and the design-decision log.

See [`docs/SMOKE-TEST.md`](docs/SMOKE-TEST.md) for a step-by-step smoke test against a live vault.

## Research context

Ontobi was developed for a CIIT 2026 (IEEE) paper, *"Reducing LLM Context Noise with Ontology-Guided Retrieval in Educational Knowledge Bases"*. The paper compares eight retrieval configurations across three local LLMs and three vault tiers (51, 93, and 212 concepts):

- **Ontobi-mcp** (this repo). Ontology-guided, metadata-first.
- **Six Qdrant variants.** Three embedding models (`BAAI/bge-base-en-v1.5`, `bge-large`, `multilingual-e5-large`) times two granularities (whole-document, chunked).
- **Filesystem.** Unstructured keyword access as a floor baseline.

Headline findings: ontobi-mcp uses 3.90 to 4.06 times fewer context tokens than whole-document vector retrieval, holds context within +/-2.5% as the vault grows 4.2 times, and ties the strongest chunked vector variant on F1 (0.619 vs. 0.628, not statistically significant).

Benchmark harness and queries live in a separate repository (`ontobi-bench`, currently private).

## Cite this work

If you use ontobi in academic work, please cite the paper:

```bibtex
@inproceedings{ontobi2026,
  title     = {Reducing {LLM} Context Noise with Ontology-Guided Retrieval in Educational Knowledge Bases},
  author    = {Garbe, Tim and {collaborators}},
  booktitle = {Proceedings of CIIT 2026 (IEEE)},
  year      = {2026},
  note      = {Camera-ready pending. Repository: \url{https://github.com/aTigar/ontobi}}
}
```

A versioned release tag pinned to the camera-ready submission will follow once the paper is accepted.

## License

MIT
