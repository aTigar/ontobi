use super::{ConceptMetadata, wikilink::{resolve_wikilink, label_to_identifier, normalize_date}};
use serde::Deserialize;

/// Raw YAML frontmatter shape — permissive (all fields optional).
#[derive(Debug, Deserialize, Default)]
struct RawFrontmatter {
    #[serde(rename = "skos:prefLabel")]
    pref_label: Option<String>,

    #[serde(rename = "skos:definition")]
    definition: Option<String>,

    #[serde(rename = "skos:broader", default)]
    broader: Option<YamlStringOrVec>,

    #[serde(rename = "skos:narrower", default)]
    narrower: Option<YamlStringOrVec>,

    #[serde(rename = "skos:related", default)]
    related: Option<YamlStringOrVec>,

    #[serde(rename = "@type")]
    r#type: Option<String>,

    identifier: Option<String>,

    #[serde(rename = "dateCreated")]
    date_created: Option<String>,

    #[serde(default)]
    aliases: Option<YamlStringOrVec>,

    #[serde(default)]
    tags: Option<YamlStringOrVec>,
}

/// Accepts either a YAML scalar string or a sequence of strings.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum YamlStringOrVec {
    Single(String),
    Vec(Vec<serde_yaml::Value>),
}

impl YamlStringOrVec {
    fn into_strings(self) -> Vec<String> {
        match self {
            YamlStringOrVec::Single(s) => {
                let s = s.trim().to_string();
                if s.is_empty() { vec![] } else { vec![s] }
            }
            YamlStringOrVec::Vec(vals) => vals
                .into_iter()
                .filter_map(|v| match v {
                    serde_yaml::Value::String(s) => {
                        let s = s.trim().to_string();
                        if s.is_empty() { None } else { Some(s) }
                    }
                    // handle null entries in YAML arrays gracefully
                    _ => None,
                })
                .collect(),
        }
    }
}

/// Parse Obsidian `.md` frontmatter into `ConceptMetadata`.
///
/// Returns `None` for files that are not SKOS concept files:
/// - No frontmatter at all  
/// - No `skos:prefLabel` field (legacy schema, plain notes, etc.)
///
/// `file_path` must be the path relative to the vault root (forward slashes),
/// e.g. `_concepts/Centroid.md`.
pub fn parse_frontmatter(content: &str, file_path: &str) -> Option<ConceptMetadata> {
    let yaml = extract_yaml_block(content)?;

    let raw: RawFrontmatter = serde_yaml::from_str(&yaml).ok()?;

    // Must have a non-empty skos:prefLabel
    let pref_label = raw.pref_label?.trim().to_string();
    if pref_label.is_empty() {
        return None;
    }

    let definition = raw.definition.unwrap_or_default().trim().to_string();

    let broader = parse_wikilink_array(raw.broader);
    let narrower = parse_wikilink_array(raw.narrower);
    let related = parse_wikilink_array(raw.related);

    let identifier = match raw.identifier {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => label_to_identifier(&pref_label),
    };

    let date_created = raw
        .date_created
        .map(|d| normalize_date(&d))
        .unwrap_or_default();

    let r#type = raw.r#type.unwrap_or_else(|| "DefinedTerm".to_string());

    let aliases = raw
        .aliases
        .map(|v| v.into_strings())
        .unwrap_or_default();

    let tags = raw
        .tags
        .map(|v| v.into_strings())
        .unwrap_or_default();

    Some(ConceptMetadata {
        pref_label,
        definition,
        broader,
        narrower,
        related,
        r#type,
        identifier,
        date_created,
        aliases,
        tags,
        file_path: file_path.to_string(),
    })
}

// ── private helpers ──────────────────────────────────────────────────────────

/// Extract the first YAML block delimited by `---` lines.
/// Returns `None` if the file has no frontmatter.
fn extract_yaml_block(content: &str) -> Option<String> {
    let content = content.trim_start();
    if !content.starts_with("---") {
        return None;
    }
    // skip the opening `---\n`
    let rest = content.trim_start_matches("---").trim_start_matches('\n');
    // find the closing `---`
    let end = rest.find("\n---")?;
    Some(rest[..end].to_string())
}

/// Convert an optional wikilink array field to resolved identifiers.
fn parse_wikilink_array(value: Option<YamlStringOrVec>) -> Vec<String> {
    value
        .map(|v| v.into_strings())
        .unwrap_or_default()
        .into_iter()
        .map(|s| {
            let resolved = resolve_wikilink(&s).to_string();
            label_to_identifier(&resolved)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CENTROID_MD: &str = r##"---
skos:prefLabel: Centroid
skos:definition: The center point of a cluster.
skos:broader: ["[[K-Means Clustering]]"]
skos:narrower: []
skos:related: []
"@type": DefinedTerm
identifier: concept-centroid
dateCreated: "[[17.01.2026]]"
aliases: []
tags: ["#concept"]
---
# Centroid

## Definition
The center point of a cluster.
"##;

    #[test]
    fn parses_centroid() {
        let meta = parse_frontmatter(CENTROID_MD, "_concepts/Centroid.md").unwrap();
        assert_eq!(meta.pref_label, "Centroid");
        assert_eq!(meta.definition, "The center point of a cluster.");
        assert_eq!(meta.identifier, "concept-centroid");
        assert_eq!(meta.date_created, "2026-01-17");
        assert_eq!(meta.broader, vec!["concept-k-means-clustering"]);
        assert!(meta.narrower.is_empty());
    }

    #[test]
    fn returns_none_for_missing_pref_label() {
        let content = "---\nfoo: bar\n---\n# Hello\n";
        assert!(parse_frontmatter(content, "notes/hello.md").is_none());
    }

    #[test]
    fn returns_none_for_no_frontmatter() {
        let content = "# Just a heading\nNo frontmatter here.\n";
        assert!(parse_frontmatter(content, "notes/plain.md").is_none());
    }

    #[test]
    fn identifier_derived_from_label_when_absent() {
        let content = "---\nskos:prefLabel: Random Forests\nskos:definition: An ensemble method.\n---\n";
        let meta = parse_frontmatter(content, "_concepts/RandomForests.md").unwrap();
        assert_eq!(meta.identifier, "concept-random-forests");
    }

    #[test]
    fn skips_plain_string_broader() {
        // broader as bare string (not array)
        let content = "---\nskos:prefLabel: Foo\nskos:broader: \"[[Bar]]\"\n---\n";
        let meta = parse_frontmatter(content, "_concepts/Foo.md").unwrap();
        assert_eq!(meta.broader, vec!["concept-bar"]);
    }
}
