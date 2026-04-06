/**
 * Five-tier search engine over a candidate concept pool.
 *
 * Background: the benchmark (ontobi-bench 20260404_225458, large vault,
 * 212 concepts, 195 × 3 queries) showed a 60% zero-hit rate for raw
 * SPARQL REGEX `search_concepts`. 79% of zero-hits were multi-word
 * queries that concatenate two or more concept names, e.g.:
 *   - "Data Lake Data Warehouse"
 *   - "CAP Theorem Defense in Depth NoSQL security"
 *   - "BSIMM OWASP SAMM"
 *
 * REGEX requires the full query string to appear verbatim in one field,
 * which never happens for concatenated concept names.
 *
 * This module fixes that by matching a query through progressive fallback
 * tiers and returning the first non-empty tier (with exact-match tiers
 * 1 and 2 always contributing):
 *
 * | #   | Name             | Semantics                                           |
 * |-----|------------------|-----------------------------------------------------|
 * | 1   | EXACT_LABEL      | case-insensitive equality with skos:prefLabel       |
 * | 2   | EXACT_ALIAS      | case-insensitive equality with any skos:altLabel    |
 * | 3   | PHRASE_SUBSTRING | full query string is substring of any field         |
 * | 4   | TOKEN_MATCH      | ≥1 whole-word token hit in label/alias; heavy       |
 * |     |                  | label weighting + all-tokens bonus                  |
 * | 4.5 | TOKEN_DEF_ONLY   | ≥1 whole-word token hit in definition ONLY (#49);   |
 * |     |                  | reduced scoring, ranked below Tier 4                |
 * | 5   | FUZZY_TRIGRAM    | trigram Jaccard ≥ threshold on labels + aliases     |
 *
 * Composition: Tiers 1 and 2 ALWAYS contribute; Tiers 3–5 use early-exit
 * (first non-empty wins). Tier 4b is bundled with Tier 4 — if either
 * has hits, both contribute and Tier 5 is skipped. A concept that
 * matches multiple tiers keeps the lowest (best) tier number.
 *
 * Tier 4 design: a single unified token tier replaces what was originally
 * TOKEN_AND + TOKEN_OR_RANKED. Benchmark evidence (query "Data Lake vs
 * Data Warehouse") showed that a strict TOKEN_AND gate can fire on a
 * "bridging" concept whose definition mentions all the user's targets
 * without being any of them. The merged tier scores all ≥1-token hits
 * with heavy label weighting (label×4 ≫ alias×2 ≫ def×1), with a small
 * +bonus for concepts that match every query token. Real target concepts
 * with strong label hits consistently outrank bridging concepts.
 */

import type { ConceptCandidate } from './candidates.js'
import { normalize, countTokenHits, hasWholeWord } from './tokenize.js'
import { jaccardSimilarity, DEFAULT_FUZZY_THRESHOLD } from './fuzzy.js'

/**
 * Numeric tier identifier for the response `match_tier` field.
 *
 * 4.5 = Tier 4b — definition-only token match (#49). Concepts that match
 * query tokens ONLY in their definition (zero label/alias hits). Scored
 * lower than Tier 4 to prevent bridging noise, but better than Tier 5
 * fuzzy which is a last resort.
 */
export type MatchTier = 1 | 2 | 3 | 4 | 4.5 | 5

/**
 * A single candidate scored against the query.
 *
 * `score` is a relative ranking within one tier — values are NOT comparable
 * across tiers. Use `tier` first, then `score` for ordering.
 */
export interface ScoredCandidate {
  candidate: ConceptCandidate
  tier: MatchTier
  score: number
}

// ── Tier implementations ──────────────────────────────────────────────────────

/**
 * Tier 1 — EXACT_LABEL.
 *
 * Returns candidates whose `skos:prefLabel`, normalised, equals the query
 * string, normalised. Case-insensitive. At most one hit per candidate.
 */
export function tierExactLabel(
  query: string,
  pool: readonly ConceptCandidate[],
): ScoredCandidate[] {
  const q = normalize(query)
  const out: ScoredCandidate[] = []
  for (const c of pool) {
    if (normalize(c.label) === q) {
      out.push({ candidate: c, tier: 1, score: 1.0 })
    }
  }
  return out
}

/**
 * Tier 2 — EXACT_ALIAS.
 *
 * Returns candidates with at least one `skos:altLabel` equal to the query
 * (case-insensitive). Useful for acronym searches — "RBAC" → Role-Based
 * Access Control.
 */
export function tierExactAlias(
  query: string,
  pool: readonly ConceptCandidate[],
): ScoredCandidate[] {
  const q = normalize(query)
  const out: ScoredCandidate[] = []
  for (const c of pool) {
    if (c.aliases.some((a) => normalize(a) === q)) {
      out.push({ candidate: c, tier: 2, score: 1.0 })
    }
  }
  return out
}

/**
 * Tier 3 — PHRASE_SUBSTRING.
 *
 * The full query string, normalised, is a substring of the label, any
 * alias, or the definition. This preserves the pre-tiered-engine
 * behaviour (SPARQL REGEX was a verbatim substring match) so no
 * previously-passing query regresses.
 *
 * Ranked: label match (score 3) > alias match (score 2) > definition
 * match (score 1). A concept matching in multiple fields keeps the
 * highest score.
 */
export function tierPhraseSubstring(
  query: string,
  pool: readonly ConceptCandidate[],
): ScoredCandidate[] {
  const q = normalize(query)
  if (q.length === 0) return []
  const out: ScoredCandidate[] = []
  for (const c of pool) {
    let score = 0
    if (normalize(c.label).includes(q)) score = Math.max(score, 3)
    if (c.aliases.some((a) => normalize(a).includes(q))) score = Math.max(score, 2)
    if (c.definition.length > 0 && normalize(c.definition).includes(q)) {
      score = Math.max(score, 1)
    }
    if (score > 0) out.push({ candidate: c, tier: 3, score })
  }
  return out
}

/**
 * Tier 4 — TOKEN_MATCH.
 *
 * Unified token-match tier (merges the earlier design's TOKEN_AND + TOKEN_OR).
 * Matches any concept where at least one query token hits the label, an
 * alias, or the definition (as a whole word). Ranked by a label-heavy
 * weighted score so real target concepts outrank "bridging" concepts
 * whose definitions happen to mention multiple user-named targets.
 *
 * Scoring:
 *
 *     base = labelHits × LABEL_WEIGHT
 *          + aliasHits × ALIAS_WEIGHT
 *          + min(defHits, DEF_CAP) × DEF_WEIGHT
 *
 *     bonus = (all query tokens matched across fields) ? TOKEN_COUNT × ALL_BONUS : 0
 *
 *     dampingFactor = 1 / (1 + DAMPING_K × linkCount)   [hub-node damping #50]
 *
 *     score = (base + bonus) × dampingFactor
 *
 * - LABEL_WEIGHT=4 is deliberately larger than DEF_CAP×DEF_WEIGHT=2, so
 *   a single label hit dominates any number of definition hits. This is
 *   what prevents the "Data Lakehouse bridging" failure (see module doc).
 * - The all-tokens bonus is a tie-breaker, not a gate: concepts whose
 *   definitions coincidentally mention every token but whose labels
 *   match only a subset of tokens still fall below real targets.
 *
 * Rejects concepts whose ONLY matches are in the definition. A concept
 * with zero label-or-alias hits is a weak bridging match and would
 * crowd out the real targets users are looking for.
 */

/** Weight applied to a single label token hit. Dominates everything else. */
const LABEL_WEIGHT = 4
/** Weight applied to a single alias token hit. */
const ALIAS_WEIGHT = 2
/** Weight applied to a single definition token hit. */
const DEF_WEIGHT = 1
/** Maximum number of definition hits counted toward the score. */
const DEF_CAP = 2
/** Per-token bonus when all tokens matched across any field. */
const ALL_TOKENS_BONUS = 0.5
/** Maximum definition hits counted for Tier 4b (definition-only matches, #49). */
const DEF_CAP_4B = 3
/** Weight per definition hit for Tier 4b. Lower than DEF_WEIGHT to rank below Tier 4. */
const DEF_WEIGHT_4B = 0.5
/**
 * Hub-node damping coefficient (#50). Controls how strongly high-linkCount
 * concepts are penalised.
 *
 *   dampingFactor = 1 / (1 + DAMPING_K × linkCount)
 *
 * With K=0.1: linkCount 0 → 1.0, 5 → 0.67, 13 → 0.43, 17 → 0.37.
 * A concept with 13 links (e.g. LLM Security) needs ~2.3× the raw token
 * score to rank equally with an unlinked concept.
 */
const DAMPING_K = 0.1

/**
 * Result of `tierTokenMatch` containing both Tier 4 (label/alias hits)
 * and Tier 4b (definition-only hits, #49).
 */
export interface TokenMatchResult {
  tier4: ScoredCandidate[]
  tier4b: ScoredCandidate[]
}

export function tierTokenMatch(
  tokens: readonly string[],
  pool: readonly ConceptCandidate[],
): TokenMatchResult {
  if (tokens.length === 0) return { tier4: [], tier4b: [] }
  const tier4: ScoredCandidate[] = []
  const tier4b: ScoredCandidate[] = []
  for (const c of pool) {
    const aliasJoined = c.aliases.map(normalize).join(' ')
    const labelHits = countTokenHits([...tokens], c.label)
    const aliasHits = countTokenHits([...tokens], aliasJoined)
    const defHitsRaw = countTokenHits([...tokens], c.definition)

    // At least one field hit required. Concepts matching nothing are skipped.
    if (labelHits + aliasHits + defHitsRaw === 0) continue

    // Hub-node damping (#50): reduce score for heavily-connected concepts
    // that match on generic tokens (e.g. "security", "attack"). Leaf
    // concepts with linkCount=0 are unaffected.
    const dampingFactor = 1 / (1 + DAMPING_K * c.linkCount)

    // Definition-only matches: Tier 4b (#49).
    // Previously rejected entirely ("bridging concept filter"). Now
    // collected at a lower tier so they can fill in when Tier 4 is empty
    // or sparse. Scored with reduced weight and cap.
    if (labelHits === 0 && aliasHits === 0) {
      const defHits4b = Math.min(defHitsRaw, DEF_CAP_4B)
      const score = defHits4b * DEF_WEIGHT_4B * dampingFactor
      tier4b.push({ candidate: c, tier: 4.5, score })
      continue
    }

    const defHits = Math.min(defHitsRaw, DEF_CAP)

    // Compute the "all tokens matched across any field" signal. The bonus
    // rewards complete coverage without being a hard gate.
    const label = normalize(c.label)
    const definition = normalize(c.definition)
    const allMatched = tokens.every(
      (t) =>
        hasWholeWord(label, t) ||
        hasWholeWord(aliasJoined, t) ||
        hasWholeWord(definition, t),
    )

    const base = labelHits * LABEL_WEIGHT + aliasHits * ALIAS_WEIGHT + defHits * DEF_WEIGHT
    const bonus = allMatched ? tokens.length * ALL_TOKENS_BONUS : 0
    const raw = base + bonus
    const score = raw * dampingFactor

    tier4.push({ candidate: c, tier: 4, score })
  }
  return { tier4, tier4b }
}

/**
 * Tier 5 — FUZZY_TRIGRAM.
 *
 * Last-resort fuzzy match. Only fires when Tiers 3 and 4 both came up
 * empty. Scored by trigram Jaccard similarity against the label and each
 * alias; the best of those is the candidate's score. Results with score
 * below `threshold` are dropped.
 *
 * Handles typos and plural/singular mismatches. Expensive — O(pool × trigrams)
 * — so it runs last and only when earlier tiers fail.
 */
export function tierFuzzyTrigram(
  query: string,
  pool: readonly ConceptCandidate[],
  threshold: number = DEFAULT_FUZZY_THRESHOLD,
): ScoredCandidate[] {
  const q = normalize(query)
  if (q.length === 0) return []
  const out: ScoredCandidate[] = []
  for (const c of pool) {
    let best = jaccardSimilarity(q, c.label)
    for (const a of c.aliases) {
      const s = jaccardSimilarity(q, a)
      if (s > best) best = s
    }
    if (best >= threshold) {
      out.push({ candidate: c, tier: 5, score: best })
    }
  }
  return out
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Run all five tiers and compose the final result set.
 *
 * Composition rules:
 * 1. Tiers 1 and 2 ALWAYS run and always contribute their hits.
 * 2. Tiers 3 → 4 → 5 use early-exit: the first tier with ≥1 hit is
 *    included; later tiers are skipped.
 * 3. A candidate matching multiple tiers is kept once, with the LOWEST
 *    (best) tier number. Score is the score from that best tier.
 * 4. Final ordering: `match_tier` ascending, then `match_score` descending.
 *
 * @param query Raw user query (not yet tokenised).
 * @param tokens Pre-tokenised version of the query (see `tokenize.ts`).
 * @param pool The full candidate pool to search over.
 * @param limit Maximum number of results to return.
 */
export function runTiers(
  query: string,
  tokens: readonly string[],
  pool: readonly ConceptCandidate[],
  limit: number,
): ScoredCandidate[] {
  // Always-run: Tiers 1 + 2.
  const alwaysHits: ScoredCandidate[] = [
    ...tierExactLabel(query, pool),
    ...tierExactAlias(query, pool),
  ]

  // Early-exit fallback chain: Tier 3 → 4 (+4b) → 5.
  //
  // Tier 4b (#49): definition-only matches are included BELOW Tier 4
  // results when Tier 4 has hits, or stand alone when Tier 4 is empty.
  // Either way, if Tier 4 or 4b produced anything, Tier 5 is skipped.
  let fallbackHits: ScoredCandidate[] = []
  fallbackHits = tierPhraseSubstring(query, pool)
  if (fallbackHits.length === 0) {
    const { tier4, tier4b } = tierTokenMatch(tokens, pool)
    fallbackHits = [...tier4, ...tier4b]
  }
  if (fallbackHits.length === 0) fallbackHits = tierFuzzyTrigram(query, pool)

  // Merge: dedup by identifier, keep LOWEST tier (best match quality).
  const byIdent = new Map<string, ScoredCandidate>()
  for (const hit of [...alwaysHits, ...fallbackHits]) {
    const id = hit.candidate.identifier
    const prev = byIdent.get(id)
    if (!prev || hit.tier < prev.tier) {
      byIdent.set(id, hit)
    }
  }

  // Sort: tier asc, score desc (label asc as tiebreaker for determinism).
  const sorted = [...byIdent.values()].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.score !== b.score) return b.score - a.score
    return a.candidate.label.localeCompare(b.candidate.label)
  })

  return sorted.slice(0, limit)
}
