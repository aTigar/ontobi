/**
 * @ontobi/obsidian — Obsidian plugin (Phase 3, post-MVP)
 *
 * Thin Obsidian plugin. Communicates with `ontobi-core` (Rust binary)
 * via the SPARQL HTTP endpoint on localhost:14321 — no direct dependency
 * on the core package.
 *
 * Responsibilities:
 *   - Bridge Obsidian vault events → HTTP notify to ontobi-core
 *   - Render Cytoscape.js graph view inside an Obsidian leaf
 *   - Plugin settings: vault path, SPARQL port, index-on-load toggle
 *
 * See ARCHITECTURE.md for the full component spec.
 */

// TODO Phase 3: implement Obsidian plugin using the Plugin base class
export {}
