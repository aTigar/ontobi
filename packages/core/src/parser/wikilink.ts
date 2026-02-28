/**
 * Wikilink utilities for Obsidian frontmatter.
 *
 * Obsidian wikilinks in YAML look like: "[[Concept Name]]"
 * The quotes are required in YAML because [[ and ]] are YAML flow sequence chars.
 */

const WIKILINK_RE = /^\[\[(.+?)\]\]$/

/**
 * Extract the concept name from a wikilink string, or return the value as-is.
 *
 * @example resolveWikilink('[[K-Means Clustering]]') → 'K-Means Clustering'
 * @example resolveWikilink('K-Means Clustering')     → 'K-Means Clustering'
 */
export function resolveWikilink(value: string): string {
  const match = WIKILINK_RE.exec(value.trim())
  return match?.[1]?.trim() ?? value.trim()
}

/**
 * Convert a concept label to a stable identifier slug.
 * Matches the 'identifier' field convention in the vault: 'concept-<slug>'
 *
 * @example labelToIdentifier('K-Means Clustering') → 'concept-k-means-clustering'
 * @example labelToIdentifier('Bootstrap Aggregation (Bagging)') → 'concept-bootstrap-aggregation-bagging'
 */
export function labelToIdentifier(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[()]/g, '')            // strip parentheses
    .trim()
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/[^a-z0-9-]/g, '')     // remove remaining non-slug chars
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-|-$/g, '')          // trim leading/trailing hyphens
  return `concept-${slug}`
}

/**
 * Build the named graph URI for a vault file path.
 * Used as the Oxigraph named graph key for incremental invalidation.
 *
 * @example filePathToGraphUri('_concepts/Centroid.md') → 'file:///_concepts/Centroid.md'
 */
export function filePathToGraphUri(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  return `file:///${normalized.replace(/^\/+/, '')}`
}

/**
 * Resolve a named graph URI back to a relative file path.
 *
 * @example graphUriToFilePath('file:///_concepts/Centroid.md') → '_concepts/Centroid.md'
 */
export function graphUriToFilePath(graphUri: string): string {
  return graphUri.replace(/^file:\/\/\//, '')
}

/**
 * Normalize a date field that may be a wikilink or plain ISO string.
 * Returns YYYY-MM-DD or the original string if it cannot be parsed.
 *
 * Handles:
 *   "[[17.01.2026]]"  → '2026-01-17'
 *   "[[24-12-2025]]"  → '2025-12-24'
 *   "2026-02-10"      → '2026-02-10'
 */
export function normalizeDate(raw: string): string {
  const inner = resolveWikilink(raw)

  // DD.MM.YYYY
  const dotMatch = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(inner)
  if (dotMatch) {
    // groups 1–3 are guaranteed to exist when the regex matches
    return `${dotMatch[3]!}-${dotMatch[2]!}-${dotMatch[1]!}`
  }

  // DD-MM-YYYY
  const dashMatch = /^(\d{2})-(\d{2})-(\d{4})$/.exec(inner)
  if (dashMatch) {
    return `${dashMatch[3]!}-${dashMatch[2]!}-${dashMatch[1]!}`
  }

  // Already ISO (YYYY-MM-DD) or unknown — return as-is
  return inner
}
