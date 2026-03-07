use anyhow::{Context, Result};
use oxigraph::sparql::{Query, QueryOptions, QueryResults, results::QueryResultsFormat};
use oxigraph::store::Store;
use oxigraph::io::{RdfFormat, RdfParser, RdfSerializer};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::parser::{parse_file, file_path_to_graph_uri, ParserConfig};
use crate::triples::generate_nquads;

// ── OntobiStore ───────────────────────────────────────────────────────────────

/// Wrapper around `oxigraph::store::Store`.
///
/// `Store` is internally `Arc`-backed: cloning gives a shared handle to the
/// same in-memory graph. The watcher and endpoint can each hold a clone and
/// see consistent data without an outer `Mutex`.
///
/// Persistence is N-Quads dump to `<vault>/.ontobi/store.nq` on shutdown and
/// load on startup.
#[derive(Clone)]
pub struct OntobiStore {
    inner:  Store,
    config: ParserConfig,
}

impl OntobiStore {
    /// Create a store with explicit parser configuration.
    ///
    /// Use this when the `--csl` flag is active or any other `ParserConfig`
    /// option is non-default. For simple cases, prefer [`OntobiStore::new`].
    pub fn with_config(config: ParserConfig) -> Result<Self> {
        Ok(Self {
            inner:  Store::new().context("failed to create Oxigraph store")?,
            config,
        })
    }

    /// Create a new, empty in-memory store with default parser configuration.
    ///
    /// Shorthand for `OntobiStore::with_config(ParserConfig::default())`.
    /// CSL indexing is disabled by default; pass an explicit config via
    /// [`OntobiStore::with_config`] to enable it.
    ///
    /// Reason: the production binary always uses `with_config` (config comes
    /// from the CLI), so `new()` is not reachable from `main()`. It is kept
    /// as a convenience for unit tests and library consumers.
    #[allow(dead_code)]
    pub fn new() -> Result<Self> {
        Self::with_config(ParserConfig::default())
    }

    /// Load N-Quads from `path` into the store (if the file exists).
    /// Called at startup to restore persisted state.
    pub fn load_from_file(&self, path: &Path) -> Result<()> {
        if !path.exists() {
            return Ok(());
        }
        let nquads = std::fs::read_to_string(path)
            .with_context(|| format!("reading persistence file {}", path.display()))?;
        if nquads.trim().is_empty() {
            return Ok(());
        }
        self.inner
            .load_from_reader(
                RdfParser::from_format(RdfFormat::NQuads),
                Cursor::new(nquads.as_bytes()),
            )
            .with_context(|| format!("loading N-Quads from {}", path.display()))?;
        Ok(())
    }

    /// Serialize the entire store to N-Quads and write to `path`.
    /// Called on graceful shutdown.
    pub fn dump_to_file(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating directory {}", parent.display()))?;
        }
        let mut buffer = Vec::new();
        self.inner
            .dump_to_writer(RdfSerializer::from_format(RdfFormat::NQuads), &mut buffer)
            .context("serializing store to N-Quads")?;
        std::fs::write(path, &buffer)
            .with_context(|| format!("writing persistence file {}", path.display()))?;
        Ok(())
    }

    /// Parse `file_path` and (re)load its item into the store.
    ///
    /// - Clears the existing named graph for this file first (incremental invalidation).
    /// - Silently skips non-indexable files (no recognised frontmatter signal).
    /// - `vault_path` is the vault root; `file_path` must be inside it.
    pub fn reindex_file(&self, vault_path: &Path, file_path: &Path) -> Result<()> {
        let content = std::fs::read_to_string(file_path)
            .with_context(|| format!("reading {}", file_path.display()))?;

        let rel_path = file_path
            .strip_prefix(vault_path)
            .with_context(|| {
                format!(
                    "{} is not inside vault {}",
                    file_path.display(),
                    vault_path.display()
                )
            })?
            .to_str()
            .context("non-UTF8 path")?
            .replace('\\', "/");

        let item = match parse_file(&content, &rel_path, &self.config) {
            Some(i) => i,
            None => return Ok(()), // not an indexable file — skip silently
        };

        // Reason: item.file_path == rel_path (parse_file stores it verbatim),
        // but using item.file_path here ensures the value is read and avoids
        // the dead_code lint on ParsedItem::file_path.
        let graph_uri = file_path_to_graph_uri(&item.file_path);

        // Drop previous version of this item's graph
        self.inner
            .update(&format!("DROP SILENT GRAPH <{graph_uri}>"))
            .with_context(|| format!("clearing graph <{graph_uri}>"))?;

        // Insert fresh N-Quads
        let nquads = generate_nquads(&item, &graph_uri);
        if !nquads.trim().is_empty() {
            self.inner
                .load_from_reader(
                    RdfParser::from_format(RdfFormat::NQuads),
                    Cursor::new(nquads.as_bytes()),
                )
                .with_context(|| format!("loading triples for {}", item.file_path))?;
        }

        tracing::debug!("indexed {} ({})", item.file_path, item.identifier);
        Ok(())
    }

    /// Remove an item from the store (called on file delete).
    pub fn remove_file(&self, vault_path: &Path, file_path: &Path) -> Result<()> {
        let rel_path = rel_path(vault_path, file_path)?;
        let graph_uri = file_path_to_graph_uri(&rel_path);
        self.inner
            .update(&format!("DROP SILENT GRAPH <{graph_uri}>"))
            .with_context(|| format!("clearing graph <{graph_uri}>"))?;
        tracing::debug!("removed {rel_path}");
        Ok(())
    }

    /// Recursively scan `vault_path` for `.md` files and index all indexable items.
    ///
    /// Returns the number of files processed (not the number of items indexed,
    /// since non-indexable files are skipped silently).
    pub fn index_vault(&self, vault_path: &Path) -> Result<usize> {
        let mut processed = 0usize;
        for entry in WalkDir::new(vault_path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        {
            self.reindex_file(vault_path, entry.path())
                .with_context(|| format!("indexing {}", entry.path().display()))?;
            processed += 1;
        }
        Ok(processed)
    }

    /// Execute a SPARQL SELECT or ASK query and return the result as SPARQL JSON bytes.
    ///
    /// Queries run over the **union of all named graphs** (one graph per vault
    /// file). Without this, plain `SELECT` queries return nothing because the
    /// default graph is always empty — all data lives in named graphs.
    pub fn query_json(&self, sparql: &str) -> Result<Vec<u8>> {
        let mut query = Query::parse(sparql, None).context("SPARQL parse")?;
        query.dataset_mut().set_default_graph_as_union();
        let results = self
            .inner
            .query_opt(query, QueryOptions::default())
            .context("SPARQL evaluation")?;
        let mut buffer = Vec::new();
        results
            .write(&mut buffer, QueryResultsFormat::Json)
            .context("SPARQL JSON serialization")?;
        Ok(buffer)
    }

    /// Execute a SPARQL ASK query and return the boolean result.
    pub fn query_bool(&self, sparql: &str) -> Result<bool> {
        let mut query = Query::parse(sparql, None).context("SPARQL parse")?;
        query.dataset_mut().set_default_graph_as_union();
        match self
            .inner
            .query_opt(query, QueryOptions::default())
            .context("SPARQL evaluation")?
        {
            QueryResults::Boolean(b) => Ok(b),
            _ => Err(anyhow::anyhow!("expected ASK query, got SELECT or CONSTRUCT")),
        }
    }

    /// Returns `true` if the query is a CONSTRUCT or DESCRIBE (not supported for JSON output).
    pub fn is_graph_query(sparql: &str) -> bool {
        let upper = sparql.trim_start().to_ascii_uppercase();
        upper.starts_with("CONSTRUCT") || upper.starts_with("DESCRIBE")
    }
}

// ── Standalone helpers ────────────────────────────────────────────────────────

/// Default persistence path inside the vault.
pub fn default_persistence_path(vault_path: &Path) -> PathBuf {
    vault_path.join(".ontobi").join("store.nq")
}

/// `ontobi index` command: index vault, dump, exit.
pub async fn index_vault_and_exit(vault: &str, config: ParserConfig) -> Result<()> {
    let vault_path = Path::new(vault);
    let store = OntobiStore::with_config(config)?;
    let persist_path = default_persistence_path(vault_path);

    store.load_from_file(&persist_path)?;
    let processed = store.index_vault(vault_path)?;
    store.dump_to_file(&persist_path)?;

    tracing::info!(
        processed,
        path = %persist_path.display(),
        "vault indexed and saved"
    );
    Ok(())
}

// ── Private helpers ───────────────────────────────────────────────────────────

fn rel_path(vault_path: &Path, file_path: &Path) -> Result<String> {
    Ok(file_path
        .strip_prefix(vault_path)
        .with_context(|| format!(
            "{} is not inside vault {}",
            file_path.display(),
            vault_path.display()
        ))?
        .to_str()
        .context("non-UTF8 path")?
        .replace('\\', "/"))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── helpers ──────────────────────────────────────────────────────────────

    fn temp_vault() -> TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    /// Write a minimal SKOS concept file into `<vault>/_concepts/<name>.md`
    fn write_concept(vault: &Path, name: &str, id: &str) -> PathBuf {
        let dir = vault.join("_concepts");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.md"));
        fs::write(
            &path,
            format!(
                "---\nskos:prefLabel: {name}\nskos:definition: Test.\n\"@type\": DefinedTerm\nidentifier: {id}\ndateCreated: \"[[28.02.2026]]\"\naliases: []\ntags: []\n---\n# {name}\n"
            ),
        )
        .unwrap();
        path
    }

    /// Write a concept with a broader relation (wikilink format).
    fn write_concept_with_broader(
        vault: &Path,
        name: &str,
        id: &str,
        broader_label: &str,
    ) -> PathBuf {
        let dir = vault.join("_concepts");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.md"));
        fs::write(
            &path,
            format!(
                "---\nskos:prefLabel: {name}\nskos:definition: Test.\nskos:broader: [\"[[{broader_label}]]\"]\n\"@type\": DefinedTerm\nidentifier: {id}\ndateCreated: \"[[28.02.2026]]\"\naliases: []\ntags: []\n---\n"
            ),
        )
        .unwrap();
        path
    }

    fn write_plain(vault: &Path, name: &str) -> PathBuf {
        let path = vault.join(format!("{name}.md"));
        fs::write(&path, "# Just a note\nNo frontmatter.\n").unwrap();
        path
    }

    const SELECT_LABELS: &str = "
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?label WHERE { ?s skos:prefLabel ?label . }
        ORDER BY ?label
    ";

    // ── tests ─────────────────────────────────────────────────────────────────

    #[test]
    fn new_store_is_empty() {
        let store = OntobiStore::new().unwrap();
        let results = store.query_json(SELECT_LABELS).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&results).unwrap();
        assert_eq!(json["results"]["bindings"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn reindex_file_adds_concept() {
        let vault = temp_vault();
        let store = OntobiStore::new().unwrap();
        let path = write_concept(vault.path(), "Alpha", "concept-alpha");

        store.reindex_file(vault.path(), &path).unwrap();

        let results = store.query_json(SELECT_LABELS).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&results).unwrap();
        let labels: Vec<&str> = json["results"]["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["label"]["value"].as_str().unwrap())
            .collect();
        assert!(labels.contains(&"Alpha"), "expected Alpha in {labels:?}");
    }

    #[test]
    fn reindex_file_updates_existing_concept() {
        let vault = temp_vault();
        let store = OntobiStore::new().unwrap();
        let path = write_concept(vault.path(), "Beta", "concept-beta");
        store.reindex_file(vault.path(), &path).unwrap();

        // Overwrite with a new label
        fs::write(
            &path,
            "---\nskos:prefLabel: Beta Updated\nskos:definition: Changed.\n\"@type\": DefinedTerm\nidentifier: concept-beta\ndateCreated: \"[[28.02.2026]]\"\naliases: []\ntags: []\n---\n",
        ).unwrap();
        store.reindex_file(vault.path(), &path).unwrap();

        let results = store.query_json(SELECT_LABELS).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&results).unwrap();
        let labels: Vec<&str> = json["results"]["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["label"]["value"].as_str().unwrap())
            .collect();
        assert!(
            labels.contains(&"Beta Updated"),
            "expected Beta Updated in {labels:?}"
        );
        assert!(
            !labels.contains(&"Beta"),
            "old label Beta must be gone in {labels:?}"
        );
    }

    #[test]
    fn reindex_file_skips_non_indexable_silently() {
        let vault = temp_vault();
        let store = OntobiStore::new().unwrap();
        let path = write_plain(vault.path(), "readme");
        store.reindex_file(vault.path(), &path).unwrap(); // must not panic or error

        let results = store.query_json(SELECT_LABELS).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&results).unwrap();
        assert_eq!(json["results"]["bindings"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn remove_file_clears_concept() {
        let vault = temp_vault();
        let store = OntobiStore::new().unwrap();
        let path = write_concept(vault.path(), "Gamma", "concept-gamma");
        store.reindex_file(vault.path(), &path).unwrap();
        store.remove_file(vault.path(), &path).unwrap();

        let results = store.query_json(SELECT_LABELS).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&results).unwrap();
        assert_eq!(json["results"]["bindings"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn index_vault_ingests_all_indexable_files() {
        let vault = temp_vault();
        let store = OntobiStore::new().unwrap();
        write_concept(vault.path(), "Alpha", "concept-alpha");
        write_concept(vault.path(), "Beta", "concept-beta");
        write_plain(vault.path(), "readme"); // must be skipped

        store.index_vault(vault.path()).unwrap();

        let results = store.query_json(SELECT_LABELS).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&results).unwrap();
        let labels: Vec<&str> = json["results"]["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["label"]["value"].as_str().unwrap())
            .collect();
        assert!(labels.contains(&"Alpha"));
        assert!(labels.contains(&"Beta"));
        assert_eq!(labels.len(), 2, "readme must not be indexed");
    }

    #[test]
    fn dump_and_load_round_trip() {
        let vault = temp_vault();
        let persist_path = vault.path().join(".ontobi").join("store.nq");
        let store = OntobiStore::new().unwrap();
        write_concept(vault.path(), "Delta", "concept-delta");
        store.index_vault(vault.path()).unwrap();
        store.dump_to_file(&persist_path).unwrap();

        assert!(persist_path.exists(), "persistence file must exist after dump");

        let store2 = OntobiStore::new().unwrap();
        store2.load_from_file(&persist_path).unwrap();

        let results = store2.query_json(SELECT_LABELS).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&results).unwrap();
        let labels: Vec<&str> = json["results"]["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["label"]["value"].as_str().unwrap())
            .collect();
        assert!(labels.contains(&"Delta"), "round-trip must preserve concept");
    }

    #[test]
    fn ask_query_returns_bool() {
        let vault = temp_vault();
        let store = OntobiStore::new().unwrap();
        let path = write_concept(vault.path(), "Epsilon", "concept-epsilon");
        store.reindex_file(vault.path(), &path).unwrap();

        let is_true = store
            .query_bool("ASK { <urn:ontobi:item:concept-epsilon> ?p ?o }")
            .unwrap();
        assert!(is_true);

        let is_false = store
            .query_bool("ASK { <urn:ontobi:item:no-such> ?p ?o }")
            .unwrap();
        assert!(!is_false);
    }

    #[test]
    fn sparql_property_path_finds_neighbour() {
        let vault = temp_vault();
        let store = OntobiStore::new().unwrap();
        write_concept(vault.path(), "Parent", "concept-parent");
        let child =
            write_concept_with_broader(vault.path(), "Child", "concept-child", "Parent");
        store.index_vault(vault.path()).unwrap();
        let _ = child;

        // SPARQL 1.1 does not support `{n,m}` repetition in property paths.
        // Use a UNION of 1-hop and 2-hop patterns instead.
        let sparql = "
            PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
            SELECT DISTINCT ?label WHERE {
                {
                    <urn:ontobi:item:concept-child>
                        (skos:broader|skos:narrower|skos:related) ?n .
                }
                UNION
                {
                    <urn:ontobi:item:concept-child>
                        (skos:broader|skos:narrower|skos:related)/
                        (skos:broader|skos:narrower|skos:related) ?n .
                }
                ?n skos:prefLabel ?label .
            }
        ";
        let results = store.query_json(sparql).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&results).unwrap();
        let labels: Vec<&str> = json["results"]["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["label"]["value"].as_str().unwrap())
            .collect();
        assert!(
            labels.contains(&"Parent"),
            "property path must reach Parent from Child"
        );
    }
}
