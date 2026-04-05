/**
 * Query tokenisation for the tiered search engine.
 *
 * Splits a raw query string into lowercase tokens, strips punctuation, and
 * removes a small curated stopword list. The goal is to turn natural-language
 * queries ("SAST vs DAST", "what is Zero Trust Architecture") into the
 * content tokens an agent actually cared about.
 */

/**
 * English stopwords likely to appear in LLM-generated search queries.
 *
 * Intentionally small: these are connectives the LLM adds when forming
 * comparison questions ("X vs Y", "X and Y") or filler words ("what is X").
 * Extending this list is cheap — but every addition is a risk of dropping
 * a legitimate concept word, so we add only in response to benchmark
 * evidence.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'between',
  'by',
  'compare',
  'describe',
  'does',
  'explain',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'vs',
  'what',
  'when',
  'where',
  'which',
  'why',
  'with',
])

/** Minimum token length after cleanup. Drops "a", "i", "x" etc. */
const MIN_TOKEN_LENGTH = 2

/**
 * Tokenise a query string for tiered search.
 *
 * - Lowercases
 * - Splits on whitespace and punctuation (anything non-alphanumeric except `-`)
 * - Removes stopwords
 * - Drops tokens shorter than [`MIN_TOKEN_LENGTH`]
 *
 * Returns tokens in order of first occurrence, deduplicated.
 *
 * @example
 *   tokenize("SAST vs DAST")                   → ["sast", "dast"]
 *   tokenize("What is Zero Trust Architecture?") → ["zero", "trust", "architecture"]
 *   tokenize("Role-Based Access Control")      → ["role-based", "access", "control"]
 */
export function tokenize(query: string): string[] {
  // Split on whitespace and punctuation, but KEEP hyphens inside words
  // ("role-based" stays one token, not two).
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((t) => t.replace(/^-+|-+$/g, '')) // strip leading/trailing hyphens
    .filter((t) => t.length >= MIN_TOKEN_LENGTH)
    .filter((t) => !STOPWORDS.has(t))

  // Deduplicate preserving first-occurrence order
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/**
 * Normalize a single string (label, alias, definition) for matching.
 *
 * Lowercases and trims. Used when comparing candidate fields to query tokens
 * — we want case-insensitive equality but preserve the internal structure
 * (punctuation, multi-word-ness) of the original field.
 */
export function normalize(s: string): string {
  return s.toLowerCase().trim()
}

/**
 * Count how many of the query tokens appear as WHOLE WORDS in the haystack.
 *
 * Matches at word boundaries rather than naked substring: a token "lake"
 * would match "Data Lake" but NOT "Data Lakehouse". Hyphens are treated
 * as internal word characters so "role-based" matches "role-based access"
 * but NOT "role". Numerics and alphanumerics are internal word characters;
 * whitespace, punctuation, and symbols (including / and `"`) are boundaries.
 *
 * This is the workhorse for Tier 4 (TOKEN_AND) and Tier 5 (TOKEN_OR).
 *
 * Reason for whole-word matching: naked substring was too aggressive —
 * it produced false positives like "lake" → "lakehouse", which then
 * surfaced bridging concepts over the actual target concepts users asked
 * for. Whole-word matching preserves intent.
 */
export function countTokenHits(tokens: string[], haystack: string): number {
  if (tokens.length === 0 || haystack.length === 0) return 0
  const h = normalize(haystack)
  let hits = 0
  for (const t of tokens) {
    // Normalise token defensively; tokenize() always lowercases but direct
    // callers (tests, integrators) may not.
    const nt = normalize(t)
    if (nt.length > 0 && hasWholeWord(h, nt)) hits++
  }
  return hits
}

/**
 * Test whether `needle` appears as a whole word in `haystack`.
 *
 * A "word character" is `[a-z0-9-]`. Boundaries are any other character
 * or the start/end of the string.
 *
 * Both arguments must already be normalised (lowercased, trimmed).
 */
export function hasWholeWord(haystack: string, needle: string): boolean {
  if (needle.length === 0 || haystack.length === 0) return false
  let idx = 0
  while (true) {
    const found = haystack.indexOf(needle, idx)
    if (found === -1) return false
    const before = found === 0 ? '' : haystack[found - 1]
    const afterPos = found + needle.length
    const after = afterPos >= haystack.length ? '' : haystack[afterPos]
    if (!isWordChar(before) && !isWordChar(after)) return true
    idx = found + 1
  }
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === '') return false
  const c = ch.charCodeAt(0)
  // a-z
  if (c >= 97 && c <= 122) return true
  // 0-9
  if (c >= 48 && c <= 57) return true
  // hyphen
  if (c === 45) return true
  return false
}
