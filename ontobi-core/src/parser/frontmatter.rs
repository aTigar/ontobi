use super::{
    wikilink::{identifier_to_item_iri, label_to_identifier, normalize_date, resolve_wikilink},
    ParsedItem, ParserConfig, RdfObject,
};
use crate::parser::csl::normalize_csl;

// ── Prefix registry ───────────────────────────────────────────────────────────

/// Built-in prefix → namespace mappings.
///
/// Any YAML key of the form `prefix:localname` where `prefix` appears in this
/// table is expanded to a full predicate IRI and included in the output triple
/// bag. Keys with unrecognised prefixes are silently ignored — this prevents
/// third-party tool metadata (e.g. `zotero:key`) from polluting the graph.
const KNOWN_PREFIXES: &[(&str, &str)] = &[
    ("skos", "http://www.w3.org/2004/02/skos/core#"),
    ("schema", "https://schema.org/"),
    ("dcterms", "http://purl.org/dc/terms/"),
    ("owl", "http://www.w3.org/2002/07/owl#"),
    ("rdfs", "http://www.w3.org/2000/01/rdf-schema#"),
    ("rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#"),
];

// ── YAML keys excluded from the triple bag ────────────────────────────────────

/// Keys consumed as file-level metadata; not emitted as RDF predicates.
///
/// `@type` is handled by the detection phase and controls `item_type`.
/// The others are Obsidian-specific organisational fields.
const SKIP_KEYS: &[&str] = &["@type", "aliases", "tags"];

// ── Public API ────────────────────────────────────────────────────────────────

/// Parse Obsidian `.md` frontmatter into a [`ParsedItem`].
///
/// Returns `None` for files that carry no indexable signal:
/// - No YAML frontmatter block at all
/// - Frontmatter present but none of `skos:prefLabel`, `@type`, or
///   (when `config.csl_enabled`) `citation-key` is found
///
/// Detection priority (evaluated in order):
/// 1. `skos:prefLabel` present → `rdf:type https://schema.org/DefinedTerm`
/// 2. `@type` present → value expanded to full IRI
/// 3. `citation-key` present **and** `config.csl_enabled` → CSL path
///
/// `rel_path` must be forward-slash relative to the vault root,
/// e.g. `_concepts/Centroid.md`.
pub fn parse_file(content: &str, rel_path: &str, config: &ParserConfig) -> Option<ParsedItem> {
    let yaml_str = extract_yaml_block(content)?;
    let raw: serde_yaml::Mapping = serde_yaml::from_str(&yaml_str).ok()?;

    // ── CSL pre-processing ────────────────────────────────────────────────────
    // Reason: CSL fields use non-RDF keys (title, abstract, citation-key).
    // The normalizer injects equivalent prefixed keys so the generic path below
    // handles CSL entries identically to hand-authored frontmatter.
    let (mapping, csl_type_override) = if config.csl_enabled {
        match normalize_csl(&raw) {
            Some((schema_type, enriched)) => (enriched, Some(schema_type)),
            None => (raw, None),
        }
    } else {
        (raw, None)
    };

    // ── Detection: determine item_type ────────────────────────────────────────

    let item_type: String = if let Some(override_type) = csl_type_override {
        // CSL path: type is determined from the CSL `type` field by the normalizer.
        // Reason: the CSL normalizer injects `skos:prefLabel` from `title` so
        // that the generic extraction loop emits the label triple. If we checked
        // `skos:prefLabel` first, every CSL article with a title would be
        // misclassified as `schema:DefinedTerm`. The CSL override must take
        // precedence over all other detection signals.
        override_type
    } else if has_key(&mapping, "skos:prefLabel") {
        // Priority 1: SKOS concept — backward-compatible with all existing vault files.
        "https://schema.org/DefinedTerm".to_string()
    } else if let Some(type_val) = mapping.get("@type") {
        // Priority 2: explicit @type field.
        expand_type_value(yaml_value_to_str(type_val))
    } else {
        return None; // No indexable signal — skip this file.
    };

    // ── Identifier ────────────────────────────────────────────────────────────

    let identifier = derive_identifier(&mapping, rel_path);
    let subject_uri = identifier_to_item_iri(&identifier);

    // ── Generic triple extraction ─────────────────────────────────────────────

    let mut triples: Vec<(String, RdfObject)> = Vec::new();

    for (key, value) in &mapping {
        let key_str = match key {
            serde_yaml::Value::String(s) => s.as_str(),
            _ => continue,
        };

        // Skip metadata keys that are not RDF predicates.
        if SKIP_KEYS.contains(&key_str) {
            continue;
        }

        // Expand `prefix:localname` to a full IRI; skip unrecognised prefixes.
        let Some(predicate) = expand_prefix(key_str) else {
            continue;
        };

        // Emit one triple per value element (sequences) or one triple (scalars).
        extract_objects(value, &mut |obj| {
            triples.push((predicate.clone(), obj));
        });
    }

    Some(ParsedItem {
        subject_uri,
        identifier,
        item_type,
        file_path: rel_path.to_string(),
        triples,
    })
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Extract the first YAML block delimited by `---` lines.
/// Returns `None` if the file has no frontmatter.
fn extract_yaml_block(content: &str) -> Option<String> {
    let content = content.trim_start();
    if !content.starts_with("---") {
        return None;
    }
    let rest = content.trim_start_matches("---").trim_start_matches('\n');
    let end = rest.find("\n---")?;
    Some(rest[..end].to_string())
}

/// Expand a `prefix:localname` YAML key to a full predicate IRI.
///
/// Returns `None` for:
/// - Keys with no `:` separator (plain keys like `identifier`, `dateCreated`)
/// - Keys whose prefix is not in [`KNOWN_PREFIXES`]
/// - The special `@type` key (handled by the detection phase, not here)
fn expand_prefix(key: &str) -> Option<String> {
    if key == "@type" {
        return None;
    }
    // Special: bare `identifier` and `dateCreated` map to schema.org.
    // Reason: the vault convention uses bare keys for these two fields;
    // rather than silently ignoring them, we promote them to schema predicates
    // so they survive in the triple bag alongside explicitly prefixed keys.
    match key {
        "identifier" => return Some("https://schema.org/identifier".to_string()),
        "dateCreated" => return Some("https://schema.org/dateCreated".to_string()),
        _ => {}
    }

    let colon = key.find(':')?;
    let prefix = &key[..colon];
    let local = &key[colon + 1..];
    if local.is_empty() {
        return None;
    }
    KNOWN_PREFIXES
        .iter()
        .find(|(p, _)| *p == prefix)
        .map(|(_, ns)| format!("{ns}{local}"))
}

/// Expand an `@type` value to a full IRI.
///
/// - If the value already contains `:`, attempt prefix expansion; if that
///   fails (unrecognised prefix), return as-is (may be a bare URL).
/// - Bare names (no `:`) are assumed to be Schema.org short names.
fn expand_type_value(val: &str) -> String {
    if val.contains(':') {
        // Try prefix expansion first; fall back to the raw value.
        expand_prefix(&format!("schema:{val}"))
            .or_else(|| {
                // Already looks like a full IRI (http/https/urn).
                if val.starts_with("http") || val.starts_with("urn") {
                    Some(val.to_string())
                } else {
                    expand_prefix(val)
                }
            })
            .unwrap_or_else(|| val.to_string())
    } else {
        // Bare name → https://schema.org/<Name>
        format!("https://schema.org/{val}")
    }
}

/// Derive the item identifier from the mapping, with a four-level fallback.
///
/// 1. `schema:identifier` or bare `identifier` field
/// 2. `label_to_identifier(skos:prefLabel)`
/// 3. `label_to_identifier(schema:name)`
/// 4. Slugify the file stem from `rel_path`
fn derive_identifier(mapping: &serde_yaml::Mapping, rel_path: &str) -> String {
    // 1. Explicit identifier field (prefixed or bare)
    for key in &["schema:identifier", "identifier"] {
        if let Some(val) = mapping.get(*key) {
            let s = yaml_value_to_str(val).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    // 2. Derive from skos:prefLabel
    if let Some(val) = mapping.get("skos:prefLabel") {
        let s = yaml_value_to_str(val).trim().to_string();
        if !s.is_empty() {
            return label_to_identifier(&s);
        }
    }
    // 3. Derive from schema:name
    if let Some(val) = mapping.get("schema:name") {
        let s = yaml_value_to_str(val).trim().to_string();
        if !s.is_empty() {
            return label_to_identifier(&s);
        }
    }
    // 4. Fall back to the file stem (filename without .md), slugified.
    let stem = rel_path
        .rsplit('/')
        .next()
        .unwrap_or(rel_path)
        .trim_end_matches(".md");
    label_to_identifier(stem)
}

/// Check whether a mapping contains a key (as a string key lookup).
fn has_key(mapping: &serde_yaml::Mapping, key: &str) -> bool {
    mapping.contains_key(key)
}

/// Extract a string representation from a scalar `serde_yaml::Value`.
/// Returns an empty string for non-string scalars.
fn yaml_value_to_str(val: &serde_yaml::Value) -> &str {
    match val {
        serde_yaml::Value::String(s) => s.as_str(),
        _ => "",
    }
}

/// Walk a YAML value (scalar or sequence) and call `emit` for each
/// `RdfObject` extracted.
///
/// - Sequence: one call per element (multi-valued predicate).
/// - Scalar string: one call — wikilink → `RdfObject::Iri`, plain → `RdfObject::Literal`.
/// - Number / bool: stringified → `RdfObject::Literal`.
/// - Null / mapping: ignored.
fn extract_objects(value: &serde_yaml::Value, emit: &mut impl FnMut(RdfObject)) {
    match value {
        serde_yaml::Value::Sequence(seq) => {
            for item in seq {
                extract_scalar(item, emit);
            }
        }
        other => extract_scalar(other, emit),
    }
}

/// Convert a single scalar YAML value to an `RdfObject` and call `emit`.
fn extract_scalar(value: &serde_yaml::Value, emit: &mut impl FnMut(RdfObject)) {
    match value {
        serde_yaml::Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                return;
            }
            if s.starts_with("[[") && s.ends_with("]]") {
                // Distinguish date wikilinks (Obsidian day notes, e.g. [[17.01.2026]])
                // from concept wikilinks (e.g. [[K-Means Clustering]]).
                //
                // Reason: `normalize_date` already knows how to detect DD.MM.YYYY and
                // DD-MM-YYYY patterns inside wikilinks. If it returns a different string
                // (an ISO date), the input was a date note link and must become a literal.
                // Otherwise it's a concept wikilink and must become an IRI.
                let inner = resolve_wikilink(s);
                let normalized = normalize_date(s);
                if normalized != inner {
                    // Date wikilink → ISO date literal
                    emit(RdfObject::Literal(normalized));
                } else {
                    // Concept wikilink → item IRI
                    let id = label_to_identifier(inner);
                    emit(RdfObject::Iri(identifier_to_item_iri(&id)));
                }
            } else {
                // Plain string — emit as literal (no date normalisation needed for
                // non-wikilink values; if the user writes a plain ISO date it passes
                // through unchanged).
                emit(RdfObject::Literal(s.to_string()));
            }
        }
        serde_yaml::Value::Number(n) => {
            emit(RdfObject::Literal(n.to_string()));
        }
        serde_yaml::Value::Bool(b) => {
            emit(RdfObject::Literal(b.to_string()));
        }
        // Null and Mapping values produce no triple.
        _ => {}
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn default_config() -> ParserConfig {
        ParserConfig { csl_enabled: false }
    }

    fn csl_config() -> ParserConfig {
        ParserConfig { csl_enabled: true }
    }

    // ── SKOS backward-compat ──────────────────────────────────────────────────

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
        let item = parse_file(CENTROID_MD, "_concepts/Centroid.md", &default_config()).unwrap();
        assert_eq!(item.identifier, "concept-centroid");
        assert_eq!(item.item_type, "https://schema.org/DefinedTerm");
        assert_eq!(item.subject_uri, "urn:ontobi:item:concept-centroid");

        // skos:prefLabel literal
        let label = item.triples.iter().find(|(p, _)| p.ends_with("#prefLabel"));
        assert!(label.is_some(), "missing skos:prefLabel triple");
        assert_eq!(label.unwrap().1, RdfObject::Literal("Centroid".to_string()));

        // skos:definition literal
        let def = item
            .triples
            .iter()
            .find(|(p, _)| p.ends_with("#definition"));
        assert!(def.is_some(), "missing skos:definition triple");

        // skos:broader → IRI
        let broader = item.triples.iter().find(|(p, _)| p.ends_with("#broader"));
        assert!(broader.is_some(), "missing skos:broader triple");
        assert_eq!(
            broader.unwrap().1,
            RdfObject::Iri("urn:ontobi:item:concept-k-means-clustering".to_string())
        );

        // dateCreated normalised
        let date = item
            .triples
            .iter()
            .find(|(p, _)| p.ends_with("dateCreated"));
        assert!(date.is_some(), "missing dateCreated triple");
        assert_eq!(
            date.unwrap().1,
            RdfObject::Literal("2026-01-17".to_string())
        );
    }

    #[test]
    fn returns_none_for_missing_pref_label_and_no_type() {
        let content = "---\nfoo: bar\n---\n# Hello\n";
        assert!(parse_file(content, "notes/hello.md", &default_config()).is_none());
    }

    #[test]
    fn returns_none_for_no_frontmatter() {
        let content = "# Just a heading\nNo frontmatter here.\n";
        assert!(parse_file(content, "notes/plain.md", &default_config()).is_none());
    }

    #[test]
    fn identifier_derived_from_label_when_absent() {
        let content =
            "---\nskos:prefLabel: Random Forests\nskos:definition: An ensemble method.\n---\n";
        let item = parse_file(content, "_concepts/RandomForests.md", &default_config()).unwrap();
        assert_eq!(item.identifier, "concept-random-forests");
    }

    #[test]
    fn skos_broader_as_plain_string() {
        let content = "---\nskos:prefLabel: Foo\nskos:broader: \"[[Bar]]\"\n---\n";
        let item = parse_file(content, "_concepts/Foo.md", &default_config()).unwrap();
        let broader = item.triples.iter().find(|(p, _)| p.ends_with("#broader"));
        assert!(broader.is_some());
        assert_eq!(
            broader.unwrap().1,
            RdfObject::Iri("urn:ontobi:item:concept-bar".to_string())
        );
    }

    // ── Generic @type indexing ────────────────────────────────────────────────

    #[test]
    fn indexes_file_with_type_and_schema_name_only() {
        let content =
            "---\n\"@type\": Course\nschema:name: Introduction to ML\nschema:identifier: course-intro-ml\n---\n";
        let item = parse_file(content, "education/intro-ml.md", &default_config()).unwrap();
        assert_eq!(item.item_type, "https://schema.org/Course");
        assert_eq!(item.identifier, "course-intro-ml");
        assert_eq!(item.subject_uri, "urn:ontobi:item:course-intro-ml");
    }

    #[test]
    fn returns_none_for_unrecognised_frontmatter() {
        // Has frontmatter but no indexable signal (no skos:prefLabel, no @type, no citation-key)
        let content = "---\nzotero:key: abc\ntitle: My Paper\n---\n";
        assert!(parse_file(content, "notes/paper.md", &default_config()).is_none());
    }

    #[test]
    fn unrecognised_prefix_produces_no_triple() {
        let content = "---\n\"@type\": Thing\nzotero:key: abc\nschema:name: Valid\n---\n";
        let item = parse_file(content, "notes/thing.md", &default_config()).unwrap();
        // zotero:key must not appear in triples
        let zotero = item.triples.iter().find(|(p, _)| p.contains("zotero"));
        assert!(
            zotero.is_none(),
            "unrecognised prefix must produce no triple"
        );
        // schema:name must be present
        let name = item
            .triples
            .iter()
            .find(|(p, _)| p.ends_with("schema.org/name"));
        assert!(name.is_some(), "schema:name triple must be present");
    }

    #[test]
    fn identifier_falls_back_to_path_stem() {
        // @type present, no identifier/prefLabel/name
        let content = "---\n\"@type\": Thing\n---\n";
        let item = parse_file(content, "notes/My Note.md", &default_config()).unwrap();
        // label_to_identifier("My Note") → "concept-my-note"
        assert_eq!(item.identifier, "concept-my-note");
    }

    // ── CSL opt-in ────────────────────────────────────────────────────────────

    const CSL_ARTICLE: &str = r#"---
citation-key: smith2024ml
type: article-journal
title: "Machine Learning Overview"
abstract: "A survey of ML methods."
author:
  - family: Smith
    given: Alice
year: 2024
DOI: "10.1000/xyz"
---"#;

    #[test]
    fn csl_disabled_returns_none() {
        assert!(parse_file(CSL_ARTICLE, "literature/smith2024ml.md", &default_config()).is_none());
    }

    #[test]
    fn csl_enabled_indexes_article() {
        let item = parse_file(CSL_ARTICLE, "literature/smith2024ml.md", &csl_config()).unwrap();
        assert_eq!(item.item_type, "https://schema.org/ScholarlyArticle");
        assert_eq!(item.identifier, "smith2024ml");

        // schema:name (from title)
        let name = item
            .triples
            .iter()
            .find(|(p, _)| p.ends_with("schema.org/name"));
        assert!(name.is_some(), "schema:name missing");

        // skos:definition (from abstract)
        let def = item
            .triples
            .iter()
            .find(|(p, _)| p.ends_with("#definition"));
        assert!(def.is_some(), "skos:definition missing");
    }

    #[test]
    fn csl_related_wikilink_becomes_iri() {
        let content = "---\ncitation-key: foo2024\ntype: article-journal\ntitle: Foo\nskos:related:\n  - \"[[K-Nearest Neighbors]]\"\n---\n";
        let item = parse_file(content, "literature/foo2024.md", &csl_config()).unwrap();
        let related = item.triples.iter().find(|(p, _)| p.ends_with("#related"));
        assert!(related.is_some(), "skos:related triple must be present");
        assert_eq!(
            related.unwrap().1,
            RdfObject::Iri("urn:ontobi:item:concept-k-nearest-neighbors".to_string()),
            "wikilink must resolve to IRI, not literal"
        );
    }
}
