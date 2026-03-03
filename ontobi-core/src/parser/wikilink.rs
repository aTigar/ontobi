/// Extract the concept name from an Obsidian wikilink, or return the value as-is.
///
/// In Obsidian YAML frontmatter, wikilinks look like: `"[[Concept Name]]"`
/// The quotes are required because `[[` and `]]` are YAML flow-sequence chars.
///
/// # Examples
/// ```
/// assert_eq!(resolve_wikilink("[[K-Means Clustering]]"), "K-Means Clustering");
/// assert_eq!(resolve_wikilink("K-Means Clustering"),     "K-Means Clustering");
/// ```
pub fn resolve_wikilink(value: &str) -> &str {
    let trimmed = value.trim();
    if let (Some(start), Some(end)) = (trimmed.strip_prefix("[["), trimmed.strip_suffix("]]")) {
        start.strip_suffix("]]").unwrap_or(start)
            // `start` here is the content after stripping `[[`, before `]]`
            // Actually we need to be more careful:
            // strip_prefix gives us everything after `[[`
            // strip_suffix gives us everything before `]]`
            // but strip_prefix and strip_suffix don't compose directly here —
            // let's use the proper approach below.
            ;
        let _ = end; // suppress unused warning
        let inner = &trimmed[2..trimmed.len() - 2];
        return inner.trim();
    }
    trimmed
}

/// Convert a concept label to a stable `concept-<slug>` identifier.
///
/// Matches the `identifier` field convention in the vault.
///
/// # Examples
/// ```
/// assert_eq!(label_to_identifier("K-Means Clustering"), "concept-k-means-clustering");
/// assert_eq!(label_to_identifier("Bootstrap Aggregation (Bagging)"), "concept-bootstrap-aggregation-bagging");
/// ```
pub fn label_to_identifier(label: &str) -> String {
    let slug = label
        .to_lowercase()
        .replace(['(', ')'], "")   // strip parentheses
        .trim()
        .to_string();

    // replace runs of whitespace with a single hyphen
    let slug: String = slug
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");

    // keep only [a-z0-9-]
    let slug: String = slug
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();

    // collapse multiple hyphens
    let slug = collapse_hyphens(&slug);

    // trim leading/trailing hyphens
    let slug = slug.trim_matches('-').to_string();

    format!("concept-{slug}")
}

/// Build the named-graph URI for a vault file path.
///
/// # Examples
/// ```
/// assert_eq!(file_path_to_graph_uri("_concepts/Centroid.md"), "file:///_concepts/Centroid.md");
/// ```
pub fn file_path_to_graph_uri(rel_path: &str) -> String {
    let normalized = rel_path.replace('\\', "/");
    let stripped = normalized.trim_start_matches('/');
    format!("file:///{stripped}")
}

/// Resolve a named-graph URI back to a relative file path.
pub fn graph_uri_to_file_path(graph_uri: &str) -> &str {
    graph_uri.trim_start_matches("file:///")
}

/// Normalize a date field that may be a wikilink or a plain ISO string.
/// Returns `YYYY-MM-DD` or the original string if it cannot be parsed.
///
/// Handles:
/// - `"[[17.01.2026]]"` → `"2026-01-17"`
/// - `"[[24-12-2025]]"` → `"2025-12-24"`
/// - `"2026-02-10"` → `"2026-02-10"`
pub fn normalize_date(raw: &str) -> String {
    let inner = resolve_wikilink(raw);

    // DD.MM.YYYY
    if let Some(s) = parse_dmy_dot(inner) {
        return s;
    }
    // DD-MM-YYYY (note: must not collide with ISO YYYY-MM-DD)
    if let Some(s) = parse_dmy_dash(inner) {
        return s;
    }
    // Already ISO or unknown — return as-is
    inner.to_string()
}

// ── private helpers ──────────────────────────────────────────────────────────

fn parse_dmy_dot(s: &str) -> Option<String> {
    // DD.MM.YYYY  (10 chars exactly)
    if s.len() != 10 { return None; }
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 { return None; }
    let (dd, mm, yyyy) = (parts[0], parts[1], parts[2]);
    if dd.len() == 2 && mm.len() == 2 && yyyy.len() == 4
        && dd.chars().all(|c| c.is_ascii_digit())
        && mm.chars().all(|c| c.is_ascii_digit())
        && yyyy.chars().all(|c| c.is_ascii_digit())
    {
        return Some(format!("{yyyy}-{mm}-{dd}"));
    }
    None
}

fn parse_dmy_dash(s: &str) -> Option<String> {
    // DD-MM-YYYY  (10 chars exactly) — must NOT match YYYY-MM-DD
    if s.len() != 10 { return None; }
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 { return None; }
    let (a, b, c) = (parts[0], parts[1], parts[2]);
    // DD-MM-YYYY: a and b are 2-digit, c is 4-digit
    if a.len() == 2 && b.len() == 2 && c.len() == 4
        && a.chars().all(|c| c.is_ascii_digit())
        && b.chars().all(|c| c.is_ascii_digit())
        && c.chars().all(|c| c.is_ascii_digit())
    {
        return Some(format!("{c}-{b}-{a}"));
    }
    None
}

fn collapse_hyphens(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut prev_hyphen = false;
    for c in s.chars() {
        if c == '-' {
            if !prev_hyphen {
                result.push(c);
            }
            prev_hyphen = true;
        } else {
            result.push(c);
            prev_hyphen = false;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_plain() {
        assert_eq!(resolve_wikilink("K-Means Clustering"), "K-Means Clustering");
    }

    #[test]
    fn resolve_wikilink_brackets() {
        assert_eq!(resolve_wikilink("[[K-Means Clustering]]"), "K-Means Clustering");
    }

    #[test]
    fn label_to_identifier_basic() {
        assert_eq!(label_to_identifier("K-Means Clustering"), "concept-k-means-clustering");
    }

    #[test]
    fn label_to_identifier_parens() {
        assert_eq!(
            label_to_identifier("Bootstrap Aggregation (Bagging)"),
            "concept-bootstrap-aggregation-bagging"
        );
    }

    #[test]
    fn file_path_to_graph_uri_basic() {
        assert_eq!(
            file_path_to_graph_uri("_concepts/Centroid.md"),
            "file:///_concepts/Centroid.md"
        );
    }

    #[test]
    fn normalize_date_dot() {
        assert_eq!(normalize_date("[[17.01.2026]]"), "2026-01-17");
    }

    #[test]
    fn normalize_date_dash() {
        assert_eq!(normalize_date("[[24-12-2025]]"), "2025-12-24");
    }

    #[test]
    fn normalize_date_iso_passthrough() {
        assert_eq!(normalize_date("2026-02-10"), "2026-02-10");
    }
}
