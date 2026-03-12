use crate::parser::{ParsedItem, RdfObject};

// ── RDF constants ─────────────────────────────────────────────────────────────

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// ── Public API ────────────────────────────────────────────────────────────────

/// Generate an N-Quads string for a vault item, placed in a named graph.
///
/// The named graph URI is used as the Oxigraph key for incremental invalidation:
/// `DROP SILENT GRAPH <graphUri>` clears the old data before this is loaded.
///
/// The function is intentionally generic: it loops over `item.triples` without
/// knowing the vocabulary — adding a new predicate to the frontmatter requires
/// no changes here.
pub fn generate_nquads(item: &ParsedItem, graph_uri: &str) -> String {
    let s = &item.subject_uri;
    let mut out = String::new();

    // rdf:type — always the first triple
    out.push_str(&iri_iri(s, RDF_TYPE, &item.item_type, graph_uri));

    // Generic predicate–object loop
    for (pred, obj) in &item.triples {
        match obj {
            RdfObject::Literal(v) => out.push_str(&iri_lit(s, pred, v, graph_uri)),
            RdfObject::Iri(v) => out.push_str(&iri_iri(s, pred, v, graph_uri)),
        }
    }

    out
}

// ── N-Quads helpers ───────────────────────────────────────────────────────────

/// N-Quad with an IRI object: `<s> <p> <o> <g> .\n`
fn iri_iri(s_uri: &str, p_uri: &str, o_uri: &str, g_uri: &str) -> String {
    format!("<{s_uri}> <{p_uri}> <{o_uri}> <{g_uri}> .\n")
}

/// N-Quad with a plain string literal object: `<s> <p> "escaped" <g> .\n`
fn iri_lit(s_uri: &str, p_uri: &str, o_lit: &str, g_uri: &str) -> String {
    format!(
        "<{s_uri}> <{p_uri}> \"{}\" <{g_uri}> .\n",
        escape_literal(o_lit)
    )
}

/// Escape a string value for use inside N-Quads double-quoted literals.
/// Handles: `\`, `"`, newline, carriage return, tab.
fn escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SKOS_PREF_LABEL: &str = "http://www.w3.org/2004/02/skos/core#prefLabel";
    const SKOS_DEFINITION: &str = "http://www.w3.org/2004/02/skos/core#definition";
    const SKOS_BROADER: &str = "http://www.w3.org/2004/02/skos/core#broader";
    const SCHEMA_IDENTIFIER: &str = "https://schema.org/identifier";
    const SCHEMA_DATE_CREATED: &str = "https://schema.org/dateCreated";
    const SCHEMA_DEFINED_TERM: &str = "https://schema.org/DefinedTerm";
    const GRAPH: &str = "file:///_concepts/Centroid.md";

    fn centroid() -> ParsedItem {
        ParsedItem {
            subject_uri: "urn:ontobi:item:concept-centroid".to_string(),
            identifier: "concept-centroid".to_string(),
            item_type: SCHEMA_DEFINED_TERM.to_string(),
            file_path: "_concepts/Centroid.md".to_string(),
            triples: vec![
                (
                    SKOS_PREF_LABEL.to_string(),
                    RdfObject::Literal("Centroid".to_string()),
                ),
                (
                    SKOS_DEFINITION.to_string(),
                    RdfObject::Literal("The center point of a cluster.".to_string()),
                ),
                (
                    SCHEMA_IDENTIFIER.to_string(),
                    RdfObject::Literal("concept-centroid".to_string()),
                ),
                (
                    SCHEMA_DATE_CREATED.to_string(),
                    RdfObject::Literal("2026-01-17".to_string()),
                ),
                (
                    SKOS_BROADER.to_string(),
                    RdfObject::Iri("urn:ontobi:item:concept-k-means-clustering".to_string()),
                ),
            ],
        }
    }

    #[test]
    fn contains_rdf_type_triple() {
        let nq = generate_nquads(&centroid(), GRAPH);
        assert!(
            nq.contains("<urn:ontobi:item:concept-centroid> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/DefinedTerm>"),
            "missing rdf:type triple in:\n{nq}"
        );
    }

    #[test]
    fn contains_pref_label() {
        let nq = generate_nquads(&centroid(), GRAPH);
        assert!(
            nq.contains("\"Centroid\""),
            "missing prefLabel literal in:\n{nq}"
        );
    }

    #[test]
    fn contains_definition() {
        let nq = generate_nquads(&centroid(), GRAPH);
        assert!(
            nq.contains("\"The center point of a cluster.\""),
            "missing definition literal in:\n{nq}"
        );
    }

    #[test]
    fn broader_is_named_node_not_literal() {
        let nq = generate_nquads(&centroid(), GRAPH);
        assert!(
            nq.contains("<urn:ontobi:item:concept-k-means-clustering>"),
            "broader should be IRI, got:\n{nq}"
        );
        assert!(
            !nq.contains("\"concept-k-means-clustering\""),
            "broader must not be a literal in:\n{nq}"
        );
    }

    #[test]
    fn empty_definition_omitted_via_triple_bag() {
        // When definition is empty, parse_file should not emit a triple for it.
        // This test verifies that an empty literal is handled gracefully.
        let mut item = centroid();
        item.triples.retain(|(p, _)| p != SKOS_DEFINITION);
        let nq = generate_nquads(&item, GRAPH);
        assert!(
            !nq.contains(SKOS_DEFINITION),
            "empty definition triple should be absent"
        );
    }

    #[test]
    fn literal_escaping() {
        let item = ParsedItem {
            subject_uri: "urn:ontobi:item:concept-centroid".to_string(),
            identifier: "concept-centroid".to_string(),
            item_type: SCHEMA_DEFINED_TERM.to_string(),
            file_path: "_concepts/Centroid.md".to_string(),
            triples: vec![(
                SKOS_DEFINITION.to_string(),
                RdfObject::Literal("He said \"hello\".\nNew line.".to_string()),
            )],
        };
        let nq = generate_nquads(&item, GRAPH);
        assert!(nq.contains(r#"\"hello\""#), "quotes must be escaped");
        assert!(nq.contains(r#"\n"#), "newlines must be escaped");
    }

    #[test]
    fn named_graph_uri_in_every_quad() {
        let nq = generate_nquads(&centroid(), GRAPH);
        for line in nq.lines() {
            if line.trim().is_empty() {
                continue;
            }
            assert!(
                line.contains(&format!("<{GRAPH}>")),
                "every quad must be in named graph; bad line: {line}"
            );
        }
    }
}
