# Ontobi MVP — Smoke Test

Validates the full pipeline on the live vault:
`.md files → ontobi-core (SPARQL) → @ontobi/mcp (MCP tools)`

**Vault:** `C:\Users\Tim\Documents\academic`  
**Endpoint:** `http://127.0.0.1:14321/sparql`

---

## Prerequisites

- MSYS2 installed at `C:\msys64`
- Node.js ≥ 20 and pnpm installed
- WSL2 with mirrored networking (see note below)

> **WSL networking:** The server binds to `127.0.0.1`. For WSL2 to reach it,
> `networkingMode=mirrored` must be set in `C:\Users\Tim\.wslconfig`.
> After setting it, run `wsl --shutdown` in PowerShell once, then reopen WSL.
> `127.0.0.1` then refers to the same loopback as Windows.

---

## 1. Build the binary

**Git Bash:**

```bash
cd C:/Users/Tim/Documents/academic/projects/ontobi
PATH="/c/msys64/mingw64/bin:/c/Users/Tim/.cargo/bin:$PATH" cargo build --release
```

**PowerShell:**

```powershell
cd C:\Users\Tim\Documents\academic\projects\ontobi
$env:PATH = "C:\msys64\mingw64\bin;" + $env:PATH
cargo build --release
```

Cargo compiles all crates in the workspace. First run takes ~60–90 s (downloading
and compiling dependencies). Subsequent runs are incremental and take a few seconds.

The binary lands at:

```
target\release\ontobi.exe
```

---

## 2. Start the server

Open a dedicated terminal — this command blocks. Keep it running for all steps below.

**Git Bash:**

```bash
./target/release/ontobi serve \
  --vault "C:/Users/Tim/Documents/academic" \
  --index
```

**PowerShell:**

```powershell
.\target\release\ontobi.exe serve `
  --vault "C:\Users\Tim\Documents\academic" `
  --index
```

`--index` tells the server to read every `.md` file in the vault on startup,
extract SKOS frontmatter, and load the resulting RDF triples into the in-memory
store. Files without `skos:prefLabel` are silently skipped.

**Expected log output:**

```
INFO ontobi_core::watcher: vault indexed files=91
INFO ontobi_core::watcher: ontobi serving port=14321 vault=...
```

The server is ready once you see the second line.

> **Second run:** the store is persisted to `<vault>/.ontobi/store.nq` on
> shutdown. Omit `--index` to restore from that file instead of re-scanning.

---

## 3. SPARQL validation (WSL terminal)

Define a helper so you don't repeat the curl flags every time:

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

`-s` suppresses the progress bar. `-X POST` sends the SPARQL string as the
request body, avoiding URL encoding. `python3 -m json.tool` pretty-prints the
response.

---

### 3.1 Connectivity

```bash
curl -s http://127.0.0.1:14321/sparql
```

**Expected:** `Missing SPARQL query parameter`

A 400 response confirms the server is reachable. `Connection refused` means the
server is not running or WSL mirrored networking is not active.

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

`false` means `Centroid.md` was not indexed. Check that its frontmatter contains
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

Counts distinct subjects that have a `skos:prefLabel` triple. Only SKOS concept
files produce this triple, so non-concept `.md` files are excluded from the count.

**Expected:** `"value": "91"` (or the current file count in `_concepts/`)

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

The `;` is SPARQL shorthand for "same subject, next predicate". This returns the
label and definition stored as RDF literals.

**Expected:**

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

Values must match the `skos:prefLabel` and `skos:definition` fields in
`_concepts/Centroid.md`.

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
or `related` as a readable label.

**Expected rows** (from `Centroid.md` frontmatter):

| relation  | neighbourId                  | neighbourLabel       |
| --------- | ---------------------------- | -------------------- |
| `broader` | `concept-k-means-clustering` | `K-Means Clustering` |
| `related` | `concept-distance-metrics`   | `Distance Metrics`   |

Missing rows mean wikilink resolution failed: `[[K-Means Clustering]]` was not
converted to `concept-k-means-clustering` at index time.

---

## 4. MCP server

Build the TypeScript packages (skip if already built):

```bash
pnpm build
```

Start the MCP server in a second terminal:

```bash
ONTOBI_VAULT_PATH="C:/Users/Tim/Documents/academic" \
  node packages/mcp/dist/index.js
```

The server communicates over **stdio** — it is designed to be launched as a
subprocess by an MCP host (Claude Code, Claude Desktop). It cannot be curled
directly.

**Expected stderr on startup:**

```
[ontobi-mcp] Connecting to SPARQL endpoint: http://localhost:14321
[ontobi-mcp] Vault path: C:/Users/Tim/Documents/academic
[ontobi-mcp] Transport: stdio
```

Kill with `Ctrl+C`. If these three lines appear without an error, the MCP server
is functional.

> **Known issue:** `expand_concept_graph` with `depth` ≥ 2 (the default) sends
> a SPARQL property path using `{1,N}` repeat syntax that Oxigraph does not
> support. Use `depth=1` explicitly until this is fixed.

---

## 5. Persistence

Stop the server from step 2 with `Ctrl+C`.

**Expected shutdown log:**

```
INFO ontobi_core::watcher: shutting down…
INFO ontobi_core::watcher: store saved path=.../.ontobi/store.nq
```

Verify the file was written:

```bash
# WSL
ls -lh "/mnt/c/Users/Tim/Documents/academic/.ontobi/store.nq"
```

Restart without `--index` to confirm the store restores from disk:

```bash
./target/release/ontobi serve --vault "C:/Users/Tim/Documents/academic"
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

| Issue                            | Symptom                                                         | Status         |
| -------------------------------- | --------------------------------------------------------------- | -------------- |
| `expand_concept_graph` depth ≥ 2 | SPARQL 400 — `{1,N}` not supported by Oxigraph                  | Fix pending    |
| `QUERIES.md` missing             | Issue #10 references 17 benchmark queries that do not exist yet | Needs creation |
