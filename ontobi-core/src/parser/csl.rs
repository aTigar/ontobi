//! CSL bibliography normalizer.
//!
//! When `--csl` is active and a vault file contains a `citation-key` field,
//! this module pre-processes the raw YAML mapping and injects equivalent
//! RDF-prefixed keys so the generic [`parse_file`] path handles CSL entries
//! uniformly — no bespoke parser branch required for bibliography files.
//!
//! The injected keys follow the same `prefix:localname` convention as
//! hand-authored frontmatter, so they are expanded by the prefix registry in
//! `frontmatter.rs` without any additional special-casing.
//!
//! [`parse_file`]: super::frontmatter::parse_file

// ── CSL → Schema.org type mapping ────────────────────────────────────────────

/// Map a CSL `type` string to the corresponding Schema.org class IRI.
///
/// The full IRI (not the short name) is returned so it is used verbatim as
/// `item_type` without a second expansion step.
fn csl_type_to_schema(csl_type: &str) -> &'static str {
    match csl_type {
        "article-journal" | "article" | "article-magazine" | "article-newspaper"
        | "paper-conference" | "speech" => "https://schema.org/ScholarlyArticle",
        "book" | "reference-book" => "https://schema.org/Book",
        "chapter" | "entry-encyclopedia" => "https://schema.org/Chapter",
        "thesis" => "https://schema.org/Thesis",
        _ => "https://schema.org/CreativeWork",
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Normalize a CSL YAML mapping by injecting RDF-prefixed equivalents.
///
/// Returns `Some((schema_type_iri, enriched_mapping))` when a `citation-key`
/// field is present, or `None` if this is not a CSL entry (so the caller can
/// fall through to the standard detection logic).
///
/// The returned mapping is a clone of `raw` with additional keys injected;
/// the original CSL keys are left in place and will be skipped by the prefix
/// registry in `frontmatter.rs` because they have no recognised `prefix:`.
///
/// # Injected key table
///
/// | CSL field | Injected as |
/// |-----------|-------------|
/// | `citation-key` | `schema:identifier` |
/// | `type` | `@type` (via Schema.org mapping; result is full IRI) |
/// | `title` | `skos:prefLabel`, `schema:name` |
/// | `abstract` | `skos:definition`, `schema:abstract` |
/// | `author[]` (family + given) | `schema:author` (one `"Family, Given"` literal per entry) |
/// | `year` / `issued.date-parts[0][0]` | `schema:datePublished` |
/// | `DOI` | `schema:sameAs` |
/// | `url` / `URL` | `schema:url` |
pub fn normalize_csl(raw: &serde_yaml::Mapping) -> Option<(String, serde_yaml::Mapping)> {
    // Only process if citation-key is present.
    let citation_key = raw.get("citation-key")?.as_str()?.trim().to_string();
    if citation_key.is_empty() {
        return None;
    }

    let mut m = raw.clone();

    // citation-key → schema:identifier
    set_str(&mut m, "schema:identifier", &citation_key);

    // type → Schema.org IRI (stored as @type; full IRI so frontmatter.rs
    // detection returns it directly without a second expand_type_value call).
    let schema_type = if let Some(csl_type) = raw.get("type").and_then(|v| v.as_str()) {
        csl_type_to_schema(csl_type).to_string()
    } else {
        "https://schema.org/CreativeWork".to_string()
    };
    // Store the short-name so expand_type_value in frontmatter.rs produces the
    // correct full IRI. Actually, since we return schema_type as the override
    // and frontmatter.rs uses csl_type_override directly, we don't set @type
    // in the mapping here — that would cause double-expansion. The override is
    // returned as the second element of the tuple.

    // title → skos:prefLabel + schema:name
    if let Some(title) = raw.get("title").and_then(|v| v.as_str()) {
        let t = title.trim().to_string();
        if !t.is_empty() {
            set_str(&mut m, "skos:prefLabel", &t);
            set_str(&mut m, "schema:name", &t);
        }
    }

    // abstract → skos:definition + schema:abstract
    if let Some(abs) = raw.get("abstract").and_then(|v| v.as_str()) {
        let a = abs.trim().to_string();
        if !a.is_empty() {
            set_str(&mut m, "skos:definition", &a);
            set_str(&mut m, "schema:abstract", &a);
        }
    }

    // author[] → schema:author (one literal per author: "Family, Given")
    if let Some(authors) = raw.get("author").and_then(|v| v.as_sequence()) {
        let mut author_literals = serde_yaml::Sequence::new();
        for author in authors {
            if let Some(formatted) = format_author(author) {
                author_literals.push(serde_yaml::Value::String(formatted));
            }
        }
        if !author_literals.is_empty() {
            m.insert(
                serde_yaml::Value::String("schema:author".to_string()),
                serde_yaml::Value::Sequence(author_literals),
            );
        }
    }

    // year / issued.date-parts[0][0] → schema:datePublished
    let pub_year = raw
        .get("year")
        .and_then(|v| v.as_u64())
        .map(|y| y.to_string())
        .or_else(|| extract_issued_year(raw));
    if let Some(year) = pub_year {
        set_str(&mut m, "schema:datePublished", &year);
    }

    // DOI → schema:sameAs
    if let Some(doi) = raw.get("DOI").and_then(|v| v.as_str()) {
        let d = doi.trim();
        if !d.is_empty() {
            set_str(&mut m, "schema:sameAs", d);
        }
    }

    // url / URL → schema:url
    let url_val = raw
        .get("url")
        .or_else(|| raw.get("URL"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string());
    if let Some(url) = url_val {
        if !url.is_empty() {
            set_str(&mut m, "schema:url", &url);
        }
    }

    Some((schema_type, m))
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Insert (or overwrite) a string value in the mapping.
fn set_str(m: &mut serde_yaml::Mapping, key: &str, val: &str) {
    m.insert(
        serde_yaml::Value::String(key.to_string()),
        serde_yaml::Value::String(val.to_string()),
    );
}

/// Format a CSL author object as `"Family, Given"`.
/// Returns `None` if neither family nor given name is present.
fn format_author(author: &serde_yaml::Value) -> Option<String> {
    let map = author.as_mapping()?;
    let family = map.get("family").and_then(|v| v.as_str()).unwrap_or("");
    let given = map.get("given").and_then(|v| v.as_str()).unwrap_or("");
    match (family.trim(), given.trim()) {
        ("", "") => None,
        (f, "") => Some(f.to_string()),
        ("", g) => Some(g.to_string()),
        (f, g) => Some(format!("{f}, {g}")),
    }
}

/// Extract the publication year from `issued.date-parts[0][0]`.
fn extract_issued_year(raw: &serde_yaml::Mapping) -> Option<String> {
    let issued = raw.get("issued")?.as_mapping()?;
    let parts = issued.get("date-parts")?.as_sequence()?;
    let first = parts.first()?.as_sequence()?;
    let year = first.first()?;
    // Year may be stored as an integer or a string.
    if let Some(n) = year.as_u64() {
        return Some(n.to_string());
    }
    year.as_str().map(|s| s.to_string())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_yaml(s: &str) -> serde_yaml::Mapping {
        serde_yaml::from_str(s).unwrap()
    }

    #[test]
    fn returns_none_without_citation_key() {
        let m = parse_yaml("title: Foo\ntype: article-journal\n");
        assert!(normalize_csl(&m).is_none());
    }

    #[test]
    fn article_journal_maps_to_scholarly_article() {
        let m = parse_yaml("citation-key: foo2024\ntype: article-journal\ntitle: Foo\n");
        let (schema_type, _) = normalize_csl(&m).unwrap();
        assert_eq!(schema_type, "https://schema.org/ScholarlyArticle");
    }

    #[test]
    fn book_maps_to_book() {
        let m = parse_yaml("citation-key: bar2024\ntype: book\ntitle: Bar\n");
        let (schema_type, _) = normalize_csl(&m).unwrap();
        assert_eq!(schema_type, "https://schema.org/Book");
    }

    #[test]
    fn unknown_type_maps_to_creative_work() {
        let m = parse_yaml("citation-key: baz2024\ntype: dataset\ntitle: Baz\n");
        let (schema_type, _) = normalize_csl(&m).unwrap();
        assert_eq!(schema_type, "https://schema.org/CreativeWork");
    }

    #[test]
    fn title_injected_as_pref_label_and_name() {
        let m = parse_yaml("citation-key: foo2024\ntype: article-journal\ntitle: ML Survey\n");
        let (_, enriched) = normalize_csl(&m).unwrap();
        assert_eq!(
            enriched.get("skos:prefLabel").and_then(|v| v.as_str()),
            Some("ML Survey")
        );
        assert_eq!(
            enriched.get("schema:name").and_then(|v| v.as_str()),
            Some("ML Survey")
        );
    }

    #[test]
    fn abstract_injected_as_definition() {
        let m = parse_yaml(
            "citation-key: foo2024\ntype: article-journal\ntitle: T\nabstract: A survey.\n",
        );
        let (_, enriched) = normalize_csl(&m).unwrap();
        assert_eq!(
            enriched.get("skos:definition").and_then(|v| v.as_str()),
            Some("A survey.")
        );
    }

    #[test]
    fn authors_formatted_as_family_given() {
        let m = parse_yaml(
            "citation-key: foo2024\ntype: article-journal\ntitle: T\nauthor:\n  - family: Smith\n    given: Alice\n  - family: Jones\n    given: Bob\n",
        );
        let (_, enriched) = normalize_csl(&m).unwrap();
        let authors = enriched
            .get("schema:author")
            .and_then(|v| v.as_sequence())
            .unwrap();
        let strs: Vec<&str> = authors.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(strs, vec!["Smith, Alice", "Jones, Bob"]);
    }

    #[test]
    fn year_injected_as_date_published() {
        let m = parse_yaml("citation-key: foo2024\ntype: article-journal\ntitle: T\nyear: 2024\n");
        let (_, enriched) = normalize_csl(&m).unwrap();
        assert_eq!(
            enriched
                .get("schema:datePublished")
                .and_then(|v| v.as_str()),
            Some("2024")
        );
    }

    #[test]
    fn issued_date_parts_fallback() {
        let m = parse_yaml(
            "citation-key: foo2024\ntype: article-journal\ntitle: T\nissued:\n  date-parts:\n    - [2023]\n",
        );
        let (_, enriched) = normalize_csl(&m).unwrap();
        assert_eq!(
            enriched
                .get("schema:datePublished")
                .and_then(|v| v.as_str()),
            Some("2023")
        );
    }

    #[test]
    fn doi_injected_as_same_as() {
        let m = parse_yaml(
            "citation-key: foo2024\ntype: article-journal\ntitle: T\nDOI: 10.1000/xyz\n",
        );
        let (_, enriched) = normalize_csl(&m).unwrap();
        assert_eq!(
            enriched.get("schema:sameAs").and_then(|v| v.as_str()),
            Some("10.1000/xyz")
        );
    }

    #[test]
    fn citation_key_becomes_identifier() {
        let m = parse_yaml("citation-key: smith2024ml\ntype: article-journal\ntitle: T\n");
        let (_, enriched) = normalize_csl(&m).unwrap();
        assert_eq!(
            enriched.get("schema:identifier").and_then(|v| v.as_str()),
            Some("smith2024ml")
        );
    }
}
