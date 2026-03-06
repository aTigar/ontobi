# Ontobi MVP — Smoke Test

Validates the full pipeline on the live vault:
`.md files → ontobi-core (SPARQL) → @ontobi/mcp (MCP tools)`

**Endpoint:** `http://127.0.0.1:14321/sparql`

---

## Prerequisites

- MSYS2 installed at `C:\msys64`
- Node.js ≥ 20 and pnpm installed
- WSL2 with mirrored networking (see step 3)

---

## 1. Build the binary

> [!WARNING] Windows PATH requirement
> `cargo` on this project uses the MSYS2 GNU linker. Without it the build fails
> with `dlltool.exe: program not found`. Set the PATH before calling `cargo` —
> either per-command in Git Bash or once per session in PowerShell.

**Git Bash:**

```bash
PATH="/c/msys64/mingw64/bin:$HOME/.cargo/bin:$PATH" cargo build --release
```

**PowerShell:**

```powershell
$env:PATH = "C:\msys64\mingw64\bin;" + $env:PATH
cargo build --release
```

First run takes ~60–90 s (Cargo downloads and compiles all dependencies).
Subsequent runs are incremental and take a few seconds.

The binary lands at `target\release\ontobi.exe` (workspace root).

---

## 2. Start the server

Open a dedicated terminal — this command blocks. Keep it running for all steps below.

**Git Bash:**

```bash
./target/release/ontobi serve --vault "<vault>" --index
```

**PowerShell:**

```powershell
.\target\release\ontobi.exe serve --vault "<vault>" --index
```

Replace `<vault>` with the absolute path to your Obsidian vault root.

`--index` scans every `.md` file on startup, extracts SKOS frontmatter, and loads
the resulting RDF triples into the in-memory store. Files without `skos:prefLabel`
are silently skipped.

**Expected log output:**

```
INFO ontobi_core::watcher: vault indexed files=91
INFO ontobi_core::watcher: ontobi serving port=14321 vault=...
```

The server is ready once you see the second line.

> [!NOTE]
> On subsequent runs the store can be restored from `<vault>/.ontobi/store.nq`
> (written on shutdown). Omit `--index` to skip re-scanning the vault.

---

## 3. SPARQL validation (WSL terminal)

> [!NOTE] WSL2 networking
> The server binds to `127.0.0.1`. WSL2 can only reach it when mirrored
> networking is enabled. Add this to `%USERPROFILE%\.wslconfig`:
>
> ```ini
> [wsl2]
> networkingMode=mirrored
> ```
>
> Then run `wsl --shutdown` in PowerShell once and reopen WSL.
> Afterwards `127.0.0.1` in WSL refers to the same loopback as Windows.

Define a helper so you don't repeat the curl flags for every query:

```bash
sparql() {
  curl -s -X POST \
    -H "Content-Type: application/sparql-query" \
    -H "Accept: application/sparql-results+json" \
    --data-raw "$1" \
    http://127.0.0.1:14321/sparql \
  | python3 -m json.tool
}
```

`-s` suppresses the progress bar. `-X POST` sends the SPARQL string as the request
body, avoiding URL encoding. `python3 -m json.tool` pretty-prints the response.

---

### 3.1 Connectivity

```bash
curl -s http://127.0.0.1:14321/sparql
```

**Expected:** `Missing SPARQL query parameter`

A 400 response confirms the server is reachable. `Connection refused` means the
server is not running or mirrored networking is not active.

---

### 3.2 ASK — does concept-centroid exist?

```bash
sparql "ASK { <urn:ontobi:concept:concept-centroid> ?p ?o }"
```

`ASK` returns a boolean — the cheapest existence check. `?p ?o` matches any
predicate and object, so this passes as long as any triple for this subject exists.

**Expected:**

```json
{
  "boolean": true
}
```

`false` means `Centroid.md` was not indexed — check that its frontmatter contains
`identifier: concept-centroid`.

---

### 3.3 COUNT — how many concepts are indexed?

```bash
sparql "
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
  SELECT (COUNT(DISTINCT ?s) AS ?total)
  WHERE { ?s skos:prefLabel ?label . }
"
```

Counts distinct subjects with a `skos:prefLabel` triple. Non-concept `.md` files
are excluded because they produce no such triple.

**Expected:** an integer matching the number of SKOS files in the vault.

---

### 3.4 SELECT — fetch Centroid's metadata

```bash
sparql "
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
  SELECT ?label ?definition WHERE {
    <urn:ontobi:concept:concept-centroid>
        skos:prefLabel  ?label ;
        skos:definition ?definition .
  }
"
```

The `;` is SPARQL shorthand for "same subject, next predicate". Returns the label
and definition stored as RDF literals.

**Expected values must match `_concepts/Centroid.md` frontmatter:**

```json
{
  "results": {
    "bindings": [
      {
        "label": { "type": "literal", "value": "Centroid" },
        "definition": { "type": "literal", "value": "The center point of a cluster..." }
      }
    ]
  }
}
```

---

### 3.5 SKOS traversal — neighbours of concept-centroid

```bash
sparql "
  PREFIX skos:   <http://www.w3.org/2004/02/skos/core#>
  PREFIX schema: <https://schema.org/>
  SELECT ?relation ?neighbourId ?neighbourLabel WHERE {
    <urn:ontobi:concept:concept-centroid> ?pred ?neighbour .
    VALUES ?pred { skos:broader skos:narrower skos:related }
    ?neighbour schema:identifier ?neighbourId ;
               skos:prefLabel    ?neighbourLabel .
    BIND(REPLACE(STR(?pred), \".*#\", \"\") AS ?relation)
  }
"
```

`VALUES` restricts `?pred` to the three SKOS relation types. `BIND + REPLACE`
strips the namespace from the predicate URI, leaving just `broader`, `narrower`,
or `related`.

**Expected rows** (from `Centroid.md` frontmatter):

| relation  | neighbourId                  | neighbourLabel       |
| --------- | ---------------------------- | -------------------- |
| `broader` | `concept-k-means-clustering` | `K-Means Clustering` |
| `related` | `concept-distance-metrics`   | `Distance Metrics`   |

Missing rows mean wikilink resolution failed: `[[K-Means Clustering]]` was not
converted to `concept-k-means-clustering` at index time.

---

## 4. MCP server

> [!NOTE] `node` not recognised in PowerShell?
> Node.js is installed but PowerShell caches the PATH from when it opened.
> **Close and reopen PowerShell** — Node will be found in the new session.
> If it still fails, run `$env:PATH += ";C:\Program Files\nodejs"` to add it manually.

### 4.1 Build the TypeScript packages

Skip if you have already run this in the current session.

**Git Bash / WSL:**

```bash
pnpm build
```

**PowerShell:**

```powershell
pnpm build
```

`pnpm build` compiles all TypeScript source under `packages/` to JavaScript in
their respective `dist/` folders. The MCP server entry point ends up at
`packages/mcp/dist/index.js`.

### 4.2 Start the MCP server

The MCP server communicates over **stdio** — it is designed to be launched as a
subprocess by an MCP host (Claude Code, Claude Desktop) which pipes JSON-RPC
messages to its stdin and reads responses from stdout. It **cannot be curled**
directly. This step only verifies that it starts cleanly and connects to the
SPARQL endpoint.

Open a new terminal (keep the `ontobi serve` terminal from step 2 running).

**Git Bash / WSL:**

```bash
ONTOBI_VAULT_PATH="<vault>" node packages/mcp/dist/index.js
```

**PowerShell:**

```powershell
$env:ONTOBI_VAULT_PATH = "<vault>"
node packages/mcp/dist/index.js
```

**Expected output on stderr:**

```
[ontobi-mcp] Connecting to SPARQL endpoint: http://localhost:14321
[ontobi-mcp] Vault path: <vault>
[ontobi-mcp] Transport: stdio
```

The server then blocks, waiting for JSON-RPC input on stdin. Kill with `Ctrl+C`.

Three lines printed without an error means:

- The process started correctly
- `ONTOBI_VAULT_PATH` was read from the environment
- The stdio transport initialised (it does **not** verify the SPARQL connection at startup — that happens on the first tool call)

### 4.3 Verify tool calls via Claude Code

Wire the MCP server to Claude Code by adding it to your MCP config, then prompt:

| Tool                   | Example prompt                                                | What to check                                                      |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `search_concepts`      | "Use search_concepts to find concepts about clustering"       | Returns labels + definitions only — no `.md` body text             |
| `expand_concept_graph` | "Use expand_concept_graph with concept_id='concept-centroid'" | Returns nodes + edges; default depth=1 (immediate neighbours only) |
| `get_concept_content`  | "Use get_concept_content with concept_id='concept-centroid'"  | Returns full `Centroid.md` body including math and code blocks     |

---

## 5. Persistence

Stop the server from step 2 with `Ctrl+C`.

**Expected shutdown log:**

```
INFO ontobi_core::watcher: shutting down…
INFO ontobi_core::watcher: store saved path=.../.ontobi/store.nq
```

Verify the file was written (WSL — Windows drives are mounted under `/mnt/`):

```bash
ls -lh /mnt/<drive>/<path-to-vault>/.ontobi/store.nq
```

Restart without `--index` to confirm the store restores from disk:

```bash
./target/release/ontobi serve --vault "<vault>"
```

Run the COUNT query from step 3.3 again — the result must match.

---

## Acceptance checklist

| #   | Check                     | Pass condition                                   |
| --- | ------------------------- | ------------------------------------------------ |
| 1   | Binary builds             | No compiler errors                               |
| 2   | Server starts             | Two INFO log lines appear                        |
| 3   | Connectivity              | `curl 127.0.0.1:14321/sparql` → 400, not refused |
| 4   | ASK concept-centroid      | `"boolean": true`                                |
| 5   | COUNT                     | Integer ≥ 1                                      |
| 6   | SELECT label + definition | Matches `Centroid.md` frontmatter                |
| 7   | SKOS traversal            | K-Means Clustering + Distance Metrics appear     |
| 8   | MCP server starts         | 3 stderr lines, no crash                         |
| 9   | Persistence written       | `.ontobi/store.nq` exists after shutdown         |
| 10  | Persistence restores      | COUNT matches after restart without `--index`    |

---

## Known issues

| Issue                                                                                  | Status         |
| -------------------------------------------------------------------------------------- | -------------- |
| `QUERIES.md` missing — issue #10 references 17 benchmark queries that do not exist yet | Needs creation |
