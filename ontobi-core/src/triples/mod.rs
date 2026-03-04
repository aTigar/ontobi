use crate::parser::ConceptMetadata;

// ── RDF prefix constants ─────────────────────────────────────────────────────

const RDF_TYPE: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const SKOS_PREF_LABEL: &str = "http://www.w3.org/2004/02/skos/core#prefLabel";
const SKOS_DEFINITION: &str = "http://www.w3.org/2004/02/skos/core#definition";
const SKOS_BROADER: &str = "http://www.w3.org/2004/02/skos/core#broader";
const SKOS_NARROWER: &str = "http://www.w3.org/2004/02/skos/core#narrower";
const SKOS_RELATED: &str = "http://www.w3.org/2004/02/skos/core#related";

const SCHEMA_DEFINED_TERM: &str = "https://schema.org/DefinedTerm";
const SCHEMA_IDENTIFIER: &str = "https://schema.org/identifier";
const SCHEMA_DATE_CREATED: &str = "https://schema.org/dateCreated";

// ── Public API ────────────────────────────────────────────────────────────────

/// Generate an N-Quads string for a concept, placed in a named graph.
///
/// The named graph URI is used as the Oxigraph key for incremental invalidation:
/// `DROP SILENT GRAPH <graphUri>` → `store.load_dataset(...)` with these N-Quads.
///
/// This is the direct Rust equivalent of the TypeScript `generateTriples` function
/// (packages/core/src/rdf/triple-generator.ts), replacing the n3.js dependency.
pub fn generate_nquads(concept: &ConceptMetadata, graph_uri: &str) -> String {
    let s = format!("urn:ontobi:concept:{}", concept.identifier);
    let g = graph_uri;

    let mut out = String::new();

    // rdf:type schema:DefinedTerm
    out.push_str(&iri_iri(&s, RDF_TYPE, SCHEMA_DEFINED_TERM, g));

    // skos:prefLabel
    out.push_str(&iri_lit(&s, SKOS_PREF_LABEL, &concept.pref_label, g));

    // skos:definition (skip if empty)
    if !concept.definition.is_empty() {
        out.push_str(&iri_lit(&s, SKOS_DEFINITION, &concept.definition, g));
    }

    // schema:identifier
    out.push_str(&iri_lit(&s, SCHEMA_IDENTIFIER, &concept.identifier, g));

    // schema:dateCreated (skip if empty)
    if !concept.date_created.is_empty() {
        out.push_str(&iri_lit(&s, SCHEMA_DATE_CREATED, &concept.date_created, g));
    }

    // skos:broader — object is a named node, not a literal
    for id in &concept.broader {
        out.push_str(&iri_iri(&s, SKOS_BROADER, &format!("urn:ontobi:concept:{id}"), g));
    }

    // skos:narrower
    for id in &concept.narrower {
        out.push_str(&iri_iri(&s, SKOS_NARROWER, &format!("urn:ontobi:concept:{id}"), g));
    }

    // skos:related
    for id in &concept.related {
        out.push_str(&iri_iri(&s, SKOS_RELATED, &format!("urn:ontobi:concept:{id}"), g));
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
    format!("<{s_uri}> <{p_uri}> \"{}\" <{g_uri}> .\n", escape_literal(o_lit))
}

/// Escape a string value for use inside N-Quads double-quoted literals.
/// Handles: `\`, `"`, newline, carriage return, tab.
fn escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"'  => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c    => out.push(c),
        }
    }
    out
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::ConceptMetadata;

    fn centroid() -> ConceptMetadata {
        ConceptMetadata {
            pref_label: "Centroid".to_string(),
            definition: "The center point of a cluster.".to_string(),
            broader: vec!["concept-k-means-clustering".to_string()],
            narrower: vec![],
            related: vec![],
            r#type: "DefinedTerm".to_string(),
            identifier: "concept-centroid".to_string(),
            date_created: "2026-01-17".to_string(),
            aliases: vec![],
            tags: vec!["#concept".to_string()],
            file_path: "_concepts/Centroid.md".to_string(),
        }
    }

    const GRAPH: &str = "file:///_concepts/Centroid.md";

    #[test]
    fn contains_rdf_type_triple() {
        let nq = generate_nquads(&centroid(), GRAPH);
        assert!(nq.contains("<urn:ontobi:concept:concept-centroid> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/DefinedTerm>"),
            "missing rdf:type triple in:\n{nq}");
    }

    #[test]
    fn contains_pref_label() {
        let nq = generate_nquads(&centroid(), GRAPH);
        assert!(nq.contains("\"Centroid\""), "missing prefLabel literal in:\n{nq}");
    }

    #[test]
    fn contains_definition() {
        let nq = generate_nquads(&centroid(), GRAPH);
        assert!(nq.contains("\"The center point of a cluster.\""),
            "missing definition literal in:\n{nq}");
    }

    #[test]
    fn broader_is_named_node_not_literal() {
        let nq = generate_nquads(&centroid(), GRAPH);
        // broader must be <urn:ontobi:concept:...>, not "concept-..."
        assert!(nq.contains("<urn:ontobi:concept:concept-k-means-clustering>"),
            "broader should be IRI, got:\n{nq}");
        assert!(!nq.contains("\"concept-k-means-clustering\""),
            "broader must not be a literal in:\n{nq}");
    }

    #[test]
    fn empty_definition_omitted() {
        let mut c = centroid();
        c.definition = String::new();
        let nq = generate_nquads(&c, GRAPH);
        assert!(!nq.contains(SKOS_DEFINITION), "empty definition should be omitted");
    }

    #[test]
    fn empty_date_created_omitted() {
        let mut c = centroid();
        c.date_created = String::new();
        let nq = generate_nquads(&c, GRAPH);
        assert!(!nq.contains(SCHEMA_DATE_CREATED), "empty dateCreated should be omitted");
    }

    #[test]
    fn literal_escaping() {
        let mut c = centroid();
        c.definition = "He said \"hello\".\nNew line.".to_string();
        let nq = generate_nquads(&c, GRAPH);
        assert!(nq.contains(r#"\"hello\""#), "quotes must be escaped");
        assert!(nq.contains(r#"\n"#), "newlines must be escaped");
    }

    #[test]
    fn named_graph_uri_in_every_quad() {
        let nq = generate_nquads(&centroid(), GRAPH);
        for line in nq.lines() {
            if line.trim().is_empty() { continue; }
            assert!(line.contains(&format!("<{GRAPH}>")),
                "every quad must be in named graph; bad line: {line}");
        }
    }
}
