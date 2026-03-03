pub mod wikilink;
mod frontmatter;

pub use frontmatter::parse_frontmatter;
pub use wikilink::{file_path_to_graph_uri, graph_uri_to_file_path, label_to_identifier};

/// Parsed representation of a SKOS concept from Obsidian frontmatter.
#[derive(Debug, Clone)]
pub struct ConceptMetadata {
    pub pref_label: String,
    pub definition: String,
    pub broader: Vec<String>,
    pub narrower: Vec<String>,
    pub related: Vec<String>,
    pub r#type: String,
    pub identifier: String,
    pub date_created: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    /// Relative path from vault root, e.g. `_concepts/Centroid.md`
    pub file_path: String,
}
