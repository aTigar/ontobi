pub mod csl;
mod frontmatter;
pub mod wikilink;

pub use frontmatter::parse_file;
// Reason: these are public library API re-exports consumed by @ontobi/mcp and
// integration tests. The bin target ("ontobi") itself does not import them
// directly, which triggers unused-import warnings on that compilation unit.
// Suppressing here keeps the public surface clean without touching each
// definition site.
#[allow(unused_imports)]
pub use wikilink::{
    file_path_to_graph_uri, graph_uri_to_file_path, identifier_to_item_iri, label_to_identifier,
};

/// An RDF object — either a plain string literal or a full IRI.
///
/// Used in [`ParsedItem::triples`] to distinguish relation targets (IRIs built
/// from wikilinks) from descriptive values (plain literals).
#[derive(Debug, Clone, PartialEq)]
pub enum RdfObject {
    /// A plain string literal (e.g. a label, definition, or date string).
    Literal(String),
    /// A fully-qualified IRI (e.g. `urn:ontobi:item:concept-centroid`).
    Iri(String),
}

/// Type-agnostic parsed representation of any indexable vault file.
///
/// Replaces the old `ConceptMetadata` struct. Instead of named fields for each
/// SKOS/Schema.org property, this holds a generic triple bag so the triple
/// generator requires no changes when a new vocabulary term is introduced.
#[derive(Debug, Clone)]
pub struct ParsedItem {
    /// Subject IRI: `urn:ontobi:item:<identifier>`.
    pub subject_uri: String,
    /// The stable slug identifier (e.g. `concept-centroid`, `smith2024ml`).
    pub identifier: String,
    /// Full IRI of `rdf:type` (e.g. `https://schema.org/DefinedTerm`).
    pub item_type: String,
    /// Relative path from vault root, e.g. `_concepts/Centroid.md`.
    pub file_path: String,
    /// All predicate–object pairs extracted from the frontmatter.
    /// Predicate is always a full IRI; object is either a literal or an IRI.
    pub triples: Vec<(String, RdfObject)>,
}

/// Configures optional parser features at startup.
///
/// Passed to [`OntobiStore::with_config`] and threaded through to
/// [`parse_file`] on every file index operation.
#[derive(Debug, Clone, Default)]
pub struct ParserConfig {
    /// When `true`, files containing a `citation-key` field are parsed as CSL
    /// bibliography entries and enriched with Schema.org triples before the
    /// generic extraction loop runs.
    pub csl_enabled: bool,
}
