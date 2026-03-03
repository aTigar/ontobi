use axum::{
    Router,
    extract::{Query as AxumQuery, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde::Deserialize;
use std::net::SocketAddr;
use tokio::net::TcpListener;

use crate::store::OntobiStore;

// ── Public API ────────────────────────────────────────────────────────────────

/// Start the SPARQL HTTP endpoint and block until the server shuts down.
///
/// Listens on `127.0.0.1:<port>`. The endpoint is identical in wire protocol
/// to the TypeScript `SparqlEndpoint`:
///
/// - `GET  /sparql?query=<url-encoded-SPARQL>` → SPARQL JSON
/// - `POST /sparql` body=SPARQL, `Content-Type: application/sparql-query` → SPARQL JSON
/// - `OPTIONS /sparql` → 204 (CORS preflight)
///
/// Both SELECT and ASK results are returned as `application/sparql-results+json`.
/// The Oxigraph serialiser produces the standard format `@ontobi/mcp`'s
/// `SparqlClient` expects.
pub async fn serve(store: OntobiStore, port: u16) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/sparql", any(sparql_handler))
        .with_state(store);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr).await?;
    tracing::info!(port, "SPARQL endpoint listening");
    axum::serve(listener, app).await?;
    Ok(())
}

// ── Handler ───────────────────────────────────────────────────────────────────

/// Query parameters for GET requests.
#[derive(Deserialize)]
pub struct GetParams {
    query: Option<String>,
}

/// Axum handler for all HTTP methods on `/sparql`.
pub async fn sparql_handler(
    method: Method,
    headers: HeaderMap,
    State(store): State<OntobiStore>,
    AxumQuery(params): AxumQuery<GetParams>,
    body: axum::body::Bytes,
) -> Response {
    // CORS headers on every response
    let mut cors = HeaderMap::new();
    cors.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    cors.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    cors.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type, Accept"),
    );

    // Preflight
    if method == Method::OPTIONS {
        return (StatusCode::NO_CONTENT, cors).into_response();
    }

    // Extract SPARQL string
    let sparql = if method == Method::GET {
        match params.query {
            Some(q) if !q.trim().is_empty() => q,
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    cors,
                    "Missing SPARQL query parameter",
                )
                    .into_response()
            }
        }
    } else if method == Method::POST {
        let s = match std::str::from_utf8(&body) {
            Ok(s) => s.to_string(),
            Err(_) => {
                return (StatusCode::BAD_REQUEST, cors, "Request body is not valid UTF-8")
                    .into_response()
            }
        };
        if s.trim().is_empty() {
            return (StatusCode::BAD_REQUEST, cors, "Empty SPARQL query").into_response();
        }
        s
    } else {
        return (StatusCode::METHOD_NOT_ALLOWED, cors, "Use GET or POST").into_response();
    };

    // Check Accept header — client can opt into Turtle for CONSTRUCT
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let wants_turtle = accept.contains("text/turtle") || accept.contains("application/turtle");

    // Detect CONSTRUCT / DESCRIBE
    let upper = sparql.trim_start().to_ascii_uppercase();
    let is_graph_query = upper.starts_with("CONSTRUCT") || upper.starts_with("DESCRIBE");

    let result: anyhow::Result<(Vec<u8>, &'static str)> = (|| {
        if is_graph_query && wants_turtle {
            // Return Turtle — use a CONSTRUCT query via SPARQL JSON would be wrong;
            // serialize as N-Triples (simplest graph format Oxigraph supports without
            // RDF/XML or Turtle feature flags — caller can add Turtle later).
            // For now return a helpful error: the mcp client never issues CONSTRUCT.
            anyhow::bail!("CONSTRUCT/DESCRIBE not supported by this endpoint")
        }
        let bytes = store.query_json(&sparql)?;
        Ok((bytes, "application/sparql-results+json"))
    })();

    match result {
        Ok((bytes, content_type)) => {
            let mut resp_headers = cors;
            resp_headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type),
            );
            (StatusCode::OK, resp_headers, bytes).into_response()
        }
        Err(e) => {
            let msg = format!("SPARQL error: {e}");
            (StatusCode::BAD_REQUEST, cors, msg).into_response()
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use std::fs;
    use tempfile::TempDir;
    use tower::ServiceExt; // for `oneshot`

    fn temp_vault_with_concept() -> (TempDir, OntobiStore) {
        let vault = tempfile::tempdir().unwrap();
        let dir = vault.path().join("_concepts");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("Alpha.md"),
            "---\nskos:prefLabel: Alpha\nskos:definition: Test.\n\"@type\": DefinedTerm\nidentifier: concept-alpha\ndateCreated: \"[[01.01.2026]]\"\naliases: []\ntags: []\n---\n",
        )
        .unwrap();
        let store = OntobiStore::new().unwrap();
        store.index_vault(vault.path()).unwrap();
        (vault, store)
    }

    fn app(store: OntobiStore) -> Router {
        Router::new()
            .route("/sparql", any(sparql_handler))
            .with_state(store)
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    async fn post_sparql(app: &Router, sparql: &str) -> (StatusCode, serde_json::Value) {
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
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    async fn get_sparql(app: &Router, sparql: &str) -> (StatusCode, serde_json::Value) {
        let encoded = urlencoding::encode(sparql);
        let uri = format!("/sparql?query={encoded}");
        let req = Request::builder()
            .method("GET")
            .uri(&uri)
            .header("Accept", "application/sparql-results+json")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    // ── tests ─────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn post_select_returns_results() {
        let (_vault, store) = temp_vault_with_concept();
        let app = app(store);
        let sparql = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
            SELECT ?label WHERE { ?s skos:prefLabel ?label . }";
        let (status, json) = post_sparql(&app, sparql).await;
        assert_eq!(status, StatusCode::OK);
        let bindings = json["results"]["bindings"].as_array().unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0]["label"]["value"].as_str().unwrap(), "Alpha");
    }

    #[tokio::test]
    async fn get_select_returns_results() {
        let (_vault, store) = temp_vault_with_concept();
        let app = app(store);
        let sparql = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
            SELECT ?label WHERE { ?s skos:prefLabel ?label . }";
        let (status, json) = get_sparql(&app, sparql).await;
        assert_eq!(status, StatusCode::OK);
        let bindings = json["results"]["bindings"].as_array().unwrap();
        assert_eq!(bindings.len(), 1);
    }

    #[tokio::test]
    async fn post_ask_returns_boolean_json() {
        let (_vault, store) = temp_vault_with_concept();
        let app = app(store);

        let (status, json) = post_sparql(
            &app,
            "ASK { <urn:ontobi:concept:concept-alpha> ?p ?o }",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["boolean"].as_bool().unwrap(), true);

        let (status2, json2) = post_sparql(
            &app,
            "ASK { <urn:ontobi:concept:no-such> ?p ?o }",
        )
        .await;
        assert_eq!(status2, StatusCode::OK);
        assert_eq!(json2["boolean"].as_bool().unwrap(), false);
    }

    #[tokio::test]
    async fn empty_query_returns_400() {
        let store = OntobiStore::new().unwrap();
        let app = app(store);
        let req = Request::builder()
            .method("POST")
            .uri("/sparql")
            .header("Content-Type", "application/sparql-query")
            .body(Body::from("   "))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn invalid_sparql_returns_400() {
        let store = OntobiStore::new().unwrap();
        let app = app(store);
        let (status, _) = post_sparql(&app, "NOT VALID SPARQL").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn options_preflight_returns_204() {
        let store = OntobiStore::new().unwrap();
        let app = app(store);
        let req = Request::builder()
            .method("OPTIONS")
            .uri("/sparql")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn cors_header_present_on_success() {
        let (_vault, store) = temp_vault_with_concept();
        let app = app(store);
        let sparql = "SELECT ?s WHERE { ?s ?p ?o } LIMIT 1";
        let req = Request::builder()
            .method("POST")
            .uri("/sparql")
            .header("Content-Type", "application/sparql-query")
            .body(Body::from(sparql))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert!(resp.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }
}
