/**
 * Trigram similarity for fuzzy label matching (Tier 6).
 *
 * Trigrams are three-character sliding windows over a string. Two strings
 * are similar if they share many trigrams. We use Jaccard similarity:
 *
 *     similarity(a, b) = |trigrams(a) ∩ trigrams(b)| / |trigrams(a) ∪ trigrams(b)|
 *
 * This handles:
 * - Typos: "vulerability" ↔ "vulnerability" (share most trigrams)
 * - Singular/plural: "vulnerability" ↔ "vulnerabilities" (share the stem)
 * - Minor word-order variation when combined with tokenised matching
 *
 * Chosen over Levenshtein distance because trigram Jaccard:
 * - Is order-insensitive within a sliding window
 * - Scales to phrases better than pure edit distance
 * - Produces a normalised score in [0, 1], directly comparable across labels
 *
 * Padding is applied so that short words and word boundaries are represented:
 * "cat" → trigrams of "  cat  " → ["  c", " ca", "cat", "at ", "t  "]
 */

/** Pad character used around strings before trigram extraction. */
const PAD = ' '

/** Width of the padding on each side. Matches the trigram size minus 1. */
const PAD_WIDTH = 2

/**
 * Extract the set of trigrams from a string.
 *
 * - Lowercases and trims.
 * - Collapses internal whitespace to a single space.
 * - Pads both ends with spaces so word-start and word-end patterns count.
 * - Returns the deduplicated set of 3-char windows.
 *
 * Returns an empty set for empty / whitespace-only input.
 */
export function trigrams(s: string): Set<string> {
  const cleaned = s.toLowerCase().trim().replace(/\s+/g, ' ')
  if (cleaned.length === 0) return new Set()
  const padded = PAD.repeat(PAD_WIDTH) + cleaned + PAD.repeat(PAD_WIDTH)
  const out = new Set<string>()
  for (let i = 0; i <= padded.length - 3; i++) {
    out.add(padded.slice(i, i + 3))
  }
  return out
}

/**
 * Jaccard similarity between two strings computed on their trigram sets.
 *
 * Returns a value in `[0, 1]`:
 * - `1.0` iff the two strings are identical after normalisation
 * - `0.0` iff they share no trigrams (or either is empty)
 *
 * Worst-case O(m + n) in string length; set operations are O(k) in the
 * number of distinct trigrams.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = trigrams(a)
  const tb = trigrams(b)
  if (ta.size === 0 || tb.size === 0) return 0

  let intersection = 0
  // Iterate over the smaller set for a marginal constant-factor win
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  for (const t of small) {
    if (large.has(t)) intersection++
  }
  const union = ta.size + tb.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Default similarity threshold for Tier 6 fuzzy hits.
 *
 * Calibrated on common typo/plural pairs observed in LLM-generated queries:
 *
 * | pair                                      | jaccard |
 * |-------------------------------------------|---------|
 * | "vulnerability" ↔ "vulnerabilities"       | ~0.57   |
 * | "authetnication" ↔ "authentication"       | ~0.68   |
 * | "discretionary" ↔ "discretionary access"  | ~0.48   |
 * | "random forest" ↔ "random forests"        | ~0.82   |
 *
 * 0.45 catches typos and plurals without producing nonsense matches
 * ("apple" ↔ "orange" ≈ 0.0; "apple" ↔ "apples" ≈ 0.72).
 */
export const DEFAULT_FUZZY_THRESHOLD = 0.45

/**
 * Find the best fuzzy match from a list of candidate strings.
 *
 * Returns the `{ index, score }` of the highest-similarity candidate that
 * meets `threshold`, or `null` if no candidate crosses the threshold.
 */
export function bestFuzzyMatch(
  query: string,
  candidates: readonly string[],
  threshold: number = DEFAULT_FUZZY_THRESHOLD,
): { index: number; score: number } | null {
  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    if (c === undefined) continue
    const s = jaccardSimilarity(query, c)
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  if (bestIdx === -1 || bestScore < threshold) return null
  return { index: bestIdx, score: bestScore }
}
