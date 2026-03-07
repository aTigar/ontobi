//! Integration tests for `ontobi-core`.
//!
//! These tests exercise the full stack (store → endpoint) using a real temp
//! vault on disk and axum's in-process test helpers. No network I/O required.

use axum::{Router, body::Body, http::Request, routing::any};
use ontobi_core::{
    endpoint::sparql_handler,
    store::OntobiStore,
};
use serde_json::Value;
use std::{fs, path::Path};
use tempfile::TempDir;
use tower::ServiceExt;

// ── Vault helpers ─────────────────────────────────────────────────────────────

/// Write a minimal SKOS concept `.md` file into `<vault>/_concepts/<name>.md`.
fn write_concept(vault: &Path, name: &str, id: &str) {
    let dir = vault.join("_concepts");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join(format!("{name}.md")),
        format!(
            "---\nskos:prefLabel: {name}\nskos:definition: Integration test concept.\n\
             \"@type\": DefinedTerm\nidentifier: {id}\n\
             dateCreated: \"[[01.03.2026]]\"\naliases: []\ntags: []\n---\n# {name}\n"
        ),
    )
    .unwrap();
}

/// Write a concept with a broader relation (wikilink format).
fn write_concept_with_broader(vault: &Path, name: &str, id: &str, broader_label: &str) {
    let dir = vault.join("_concepts");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join(format!("{name}.md")),
        format!(
            "---\nskos:prefLabel: {name}\nskos:definition: Integration test concept.\n\
             skos:broader: [\"[[{broader_label}]]\"]\n\
             \"@type\": DefinedTerm\nidentifier: {id}\n\
             dateCreated: \"[[01.03.2026]]\"\naliases: []\ntags: []\n---\n"
        ),
    )
    .unwrap();
}

/// Write a plain (non-SKOS) note file that must be silently skipped.
fn write_plain_note(vault: &Path, name: &str) {
    fs::write(
        vault.join(format!("{name}.md")),
        "# Just a note\nNo SKOS frontmatter here.\n",
    )
    .unwrap();
}

// ── App builder ───────────────────────────────────────────────────────────────

fn app(store: OntobiStore) -> Router {
    Router::new()
        .route("/sparql", any(sparql_handler))
        .with_state(store)
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async fn post_sparql(app: &Router, sparql: &str) -> (axum::http::StatusCode, Value) {
    let req = Request::builder()
        .method("POST")
        .uri("/sparql")
        .header("Content-Type", "application/sparql-query")
        .header("Accept", "application/sparql-results+json")
        .body(Body::from(sparql.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

fn bindings_labels(json: &Value) -> Vec<&str> {
    json["results"]["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|b| b["label"]["value"].as_str())
        .collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Indexing a vault with two SKOS concepts and one plain note: the endpoint
/// returns exactly the two concept labels — plain notes are silently skipped.
#[tokio::test]
async fn index_vault_and_query_via_endpoint() {
    let vault = TempDir::new().unwrap();
    write_concept(vault.path(), "Alpha", "concept-alpha");
    write_concept(vault.path(), "Beta", "concept-beta");
    write_plain_note(vault.path(), "readme");

    let store = OntobiStore::new().unwrap();
    store.index_vault(vault.path()).unwrap();

    let app = app(store);
    let sparql = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?label WHERE { ?s skos:prefLabel ?label . } ORDER BY ?label";
    let (status, json) = post_sparql(&app, sparql).await;

    assert_eq!(status, axum::http::StatusCode::OK);
    let labels = bindings_labels(&json);
    assert_eq!(labels, vec!["Alpha", "Beta"], "plain note must not appear");
}

/// Reindexing a file replaces the old concept data — no stale triples remain.
#[tokio::test]
async fn reindex_file_updates_concept_in_endpoint() {
    let vault = TempDir::new().unwrap();
    let path = vault.path().join("_concepts").join("Thing.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        "---\nskos:prefLabel: OldLabel\nskos:definition: First version.\n\
         \"@type\": DefinedTerm\nidentifier: concept-thing\n\
         dateCreated: \"[[01.03.2026]]\"\naliases: []\ntags: []\n---\n",
    )
    .unwrap();

    let store = OntobiStore::new().unwrap();
    store.reindex_file(vault.path(), &path).unwrap();

    // Now overwrite with a new label
    fs::write(
        &path,
        "---\nskos:prefLabel: NewLabel\nskos:definition: Updated.\n\
         \"@type\": DefinedTerm\nidentifier: concept-thing\n\
         dateCreated: \"[[01.03.2026]]\"\naliases: []\ntags: []\n---\n",
    )
    .unwrap();
    store.reindex_file(vault.path(), &path).unwrap();

    let app = app(store);
    let sparql = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?label WHERE { ?s skos:prefLabel ?label . }";
    let (_, json) = post_sparql(&app, sparql).await;
    let labels = bindings_labels(&json);
    assert_eq!(labels, vec!["NewLabel"], "stale OldLabel must not appear");
}

/// Removing a file wipes its concept from the endpoint response.
#[tokio::test]
async fn remove_file_clears_concept_from_endpoint() {
    let vault = TempDir::new().unwrap();
    write_concept(vault.path(), "Gamma", "concept-gamma");

    let store = OntobiStore::new().unwrap();
    let path = vault.path().join("_concepts").join("Gamma.md");
    store.reindex_file(vault.path(), &path).unwrap();
    store.remove_file(vault.path(), &path).unwrap();

    let app = app(store);
    let sparql = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?label WHERE { ?s skos:prefLabel ?label . }";
    let (status, json) = post_sparql(&app, sparql).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(
        json["results"]["bindings"].as_array().unwrap().len(),
        0,
        "removed concept must not appear"
    );
}

/// N-Quads round-trip: dump to disk → load into a fresh store → query via endpoint.
#[tokio::test]
async fn persistence_round_trip_via_endpoint() {
    let vault = TempDir::new().unwrap();
    write_concept(vault.path(), "Delta", "concept-delta");

    let persist_path = vault.path().join(".ontobi").join("store.nq");

    let store1 = OntobiStore::new().unwrap();
    store1.index_vault(vault.path()).unwrap();
    store1.dump_to_file(&persist_path).unwrap();

    // Fresh store, loaded from disk
    let store2 = OntobiStore::new().unwrap();
    store2.load_from_file(&persist_path).unwrap();

    let app = app(store2);
    let sparql = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?label WHERE { ?s skos:prefLabel ?label . }";
    let (status, json) = post_sparql(&app, sparql).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let labels = bindings_labels(&json);
    assert!(labels.contains(&"Delta"), "persisted concept must survive round-trip");
}

/// SPARQL graph traversal across a broader/narrower relation: the endpoint
/// returns the parent label when querying 1-hop neighbours of the child.
#[tokio::test]
async fn sparql_broader_relation_traversal_via_endpoint() {
    let vault = TempDir::new().unwrap();
    write_concept(vault.path(), "Parent", "concept-parent");
    write_concept_with_broader(vault.path(), "Child", "concept-child", "Parent");

    let store = OntobiStore::new().unwrap();
    store.index_vault(vault.path()).unwrap();

    let app = app(store);
    let sparql = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?label WHERE {
            <urn:ontobi:item:concept-child> skos:broader ?n .
            ?n skos:prefLabel ?label .
        }";
    let (status, json) = post_sparql(&app, sparql).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let labels = bindings_labels(&json);
    assert!(
        labels.contains(&"Parent"),
        "broader relation must be traversable via endpoint; got {labels:?}"
    );
}

/// ASK query via the endpoint returns `{"boolean": true}` for existing concepts
/// and `{"boolean": false}` for absent ones.
#[tokio::test]
async fn ask_query_via_endpoint() {
    let vault = TempDir::new().unwrap();
    write_concept(vault.path(), "Epsilon", "concept-epsilon");

    let store = OntobiStore::new().unwrap();
    store.index_vault(vault.path()).unwrap();

    let app = app(store);

    let (s1, j1) = post_sparql(
        &app,
        "ASK { <urn:ontobi:item:concept-epsilon> ?p ?o }",
    )
    .await;
    assert_eq!(s1, axum::http::StatusCode::OK);
    assert_eq!(j1["boolean"].as_bool().unwrap(), true);

    let (s2, j2) = post_sparql(&app, "ASK { <urn:ontobi:item:no-such> ?p ?o }").await;
    assert_eq!(s2, axum::http::StatusCode::OK);
    assert_eq!(j2["boolean"].as_bool().unwrap(), false);
}

/// Malformed SPARQL returns 400 with an error message.
#[tokio::test]
async fn invalid_sparql_returns_400() {
    let store = OntobiStore::new().unwrap();
    let app = app(store);
    let (status, _) = post_sparql(&app, "NOT VALID SPARQL AT ALL").await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
}

/// Regression: concept files whose names contain spaces must be indexed and
/// queryable. This exercises the IRI percent-encoding fix in `file_path_to_graph_uri`.
#[tokio::test]
async fn concept_with_space_in_filename_is_indexed() {
    let vault = TempDir::new().unwrap();

    // File name contains a space — was broken before IRI encoding fix
    let dir = vault.path().join("_concepts");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("Activation Functions.md"),
        "---\nskos:prefLabel: Activation Functions\n\
         skos:definition: Functions applied to neural network outputs.\n\
         \"@type\": DefinedTerm\nidentifier: concept-activation-functions\n\
         dateCreated: \"[[01.03.2026]]\"\naliases: []\ntags: []\n---\n",
    )
    .unwrap();

    let store = OntobiStore::new().unwrap();
    store.index_vault(vault.path()).unwrap();

    let app = app(store);
    let sparql = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?label WHERE { ?s skos:prefLabel ?label . }";
    let (status, json) = post_sparql(&app, sparql).await;

    assert_eq!(status, axum::http::StatusCode::OK);
    let labels = bindings_labels(&json);
    assert!(
        labels.contains(&"Activation Functions"),
        "concept with space in filename must be indexed; got {labels:?}"
    );
}
