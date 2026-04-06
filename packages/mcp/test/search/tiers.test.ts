import { describe, it, expect } from 'vitest'
import type { ConceptCandidate } from '../../src/search/candidates.js'
import {
  tierExactLabel,
  tierExactAlias,
  tierPhraseSubstring,
  tierTokenMatch,
  tierFuzzyTrigram,
  runTiers,
} from '../../src/search/tiers.js'

// ── Test fixture: a small representative concept pool ────────────────────────

/** Helper: create a ConceptCandidate with sensible defaults for test fixtures. */
const cc = (
  identifier: string,
  label: string,
  definition: string,
  aliases: string[] = [],
  filePath = '',
  linkCount = 0,
): ConceptCandidate => ({ identifier, label, definition, aliases, filePath, linkCount })

const POOL: ConceptCandidate[] = [
  cc('concept-rbac', 'Role-Based Access Control',
    'An access control model in which permissions are associated with named roles.',
    ['RBAC']),
  cc('concept-gdpr', 'General Data Protection Regulation',
    'EU regulation on data protection and privacy.',
    ['GDPR', 'Regulation (EU) 2016/679']),
  cc('concept-sast', 'Static Application Security Testing',
    'Analyses source code without executing it.',
    ['SAST', 'Static Code Analysis']),
  cc('concept-dast', 'Dynamic Application Security Testing',
    'Tests a running application for security flaws.',
    ['DAST']),
  cc('concept-vulnerability', 'Vulnerability',
    'A weakness that can be exploited by a threat actor.'),
  cc('concept-authentication', 'Authentication',
    'The process of verifying identity.',
    ['AuthN']),
]

// ── Tier 1: EXACT_LABEL ───────────────────────────────────────────────────────

describe('tierExactLabel', () => {
  it('matches case-insensitive full-string equality', () => {
    const hits = tierExactLabel('Role-Based Access Control', POOL)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.candidate.identifier).toBe('concept-rbac')
    expect(hits[0]?.tier).toBe(1)
    expect(hits[0]?.score).toBe(1.0)
  })

  it('matches regardless of case', () => {
    expect(tierExactLabel('ROLE-BASED ACCESS CONTROL', POOL)).toHaveLength(1)
    expect(tierExactLabel('role-based access control', POOL)).toHaveLength(1)
  })

  it('does not match partial strings', () => {
    expect(tierExactLabel('Role-Based', POOL)).toHaveLength(0)
    expect(tierExactLabel('Role-Based Access Control extended', POOL)).toHaveLength(0)
  })

  it('returns empty for unknown label', () => {
    expect(tierExactLabel('Lambda Architecture', POOL)).toHaveLength(0)
  })
})

// ── Tier 2: EXACT_ALIAS ───────────────────────────────────────────────────────

describe('tierExactAlias', () => {
  it('matches case-insensitive full-string equality against any alias', () => {
    const hits = tierExactAlias('RBAC', POOL)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.candidate.identifier).toBe('concept-rbac')
    expect(hits[0]?.tier).toBe(2)
  })

  it('matches non-first aliases', () => {
    const hits = tierExactAlias('Static Code Analysis', POOL)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.candidate.identifier).toBe('concept-sast')
  })

  it('is case-insensitive', () => {
    expect(tierExactAlias('rbac', POOL)).toHaveLength(1)
    expect(tierExactAlias('gdpr', POOL)).toHaveLength(1)
  })

  it('does not match partial aliases', () => {
    expect(tierExactAlias('RBA', POOL)).toHaveLength(0)
  })

  it('returns empty when no alias matches', () => {
    expect(tierExactAlias('ZTA', POOL)).toHaveLength(0)
  })
})

// ── Tier 3: PHRASE_SUBSTRING ─────────────────────────────────────────────────

describe('tierPhraseSubstring', () => {
  it('matches full query as substring of label with highest score', () => {
    const hits = tierPhraseSubstring('Access Control', POOL)
    expect(hits.some((h) => h.candidate.identifier === 'concept-rbac')).toBe(true)
    const rbac = hits.find((h) => h.candidate.identifier === 'concept-rbac')!
    expect(rbac.score).toBe(3) // label match
    expect(rbac.tier).toBe(3)
  })

  it('matches substring in alias with score 2', () => {
    // "Static Code" appears in alias "Static Code Analysis" but not label
    const hits = tierPhraseSubstring('Static Code', POOL)
    const sast = hits.find((h) => h.candidate.identifier === 'concept-sast')
    expect(sast).toBeDefined()
    // "Static" is in the label too — actually label has "Static Application Security Testing"
    // which contains "Static" but not "Static Code". So label match fails, alias wins.
    expect(sast!.score).toBe(2)
  })

  it('matches substring in definition with score 1', () => {
    const hits = tierPhraseSubstring('exploited by a threat actor', POOL)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.candidate.identifier).toBe('concept-vulnerability')
    expect(hits[0]?.score).toBe(1)
  })

  it('returns empty for non-substring queries', () => {
    expect(tierPhraseSubstring('completely unrelated phrase xyz', POOL)).toHaveLength(0)
  })

  it('returns empty for empty query', () => {
    expect(tierPhraseSubstring('', POOL)).toHaveLength(0)
  })
})

// ── Tier 4: TOKEN_MATCH ───────────────────────────────────────────────────────

describe('tierTokenMatch', () => {
  it('matches when at least one token hits the label', () => {
    const hits = tierTokenMatch(['role-based'], POOL)
    expect(hits.some((h) => h.candidate.identifier === 'concept-rbac')).toBe(true)
    const rbac = hits.find((h) => h.candidate.identifier === 'concept-rbac')!
    expect(rbac.tier).toBe(4)
  })

  it('matches combined-concept queries (no single target has all tokens)', () => {
    // "SAST DAST" query: each concept has ONE of the two tokens. TOKEN_MATCH
    // returns both.
    const hits = tierTokenMatch(['sast', 'dast'], POOL)
    const ids = hits.map((h) => h.candidate.identifier).sort()
    expect(ids).toContain('concept-sast')
    expect(ids).toContain('concept-dast')
  })

  it('ranks concepts with more label-token matches highest', () => {
    // "application security testing" hits SAST and DAST labels (3 tokens each)
    // and nothing else has that many label hits.
    const hits = tierTokenMatch(['application', 'security', 'testing'], POOL)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const topTwo = hits.slice().sort((a, b) => b.score - a.score).slice(0, 2)
    const topTwoIds = topTwo.map((h) => h.candidate.identifier).sort()
    expect(topTwoIds).toEqual(['concept-dast', 'concept-sast'])
  })

  it('rejects "bridging" concepts that match only via definition', () => {
    // A concept whose label and aliases have none of the query tokens — it
    // only mentions them in its definition — is a weak bridging match and
    // must be excluded so the real target concepts surface.
    const bridgingPool: ConceptCandidate[] = [
      cc('concept-bridge', 'Some Bridge', 'Combines foo with bar for quux workloads.'),
      cc('concept-foo', 'Foo', 'The Foo concept.'),
    ]
    const hits = tierTokenMatch(['foo', 'bar', 'quux'], bridgingPool)
    expect(hits.find((h) => h.candidate.identifier === 'concept-bridge')).toBeUndefined()
    expect(hits.find((h) => h.candidate.identifier === 'concept-foo')).toBeDefined()
  })

  it('gives a bonus when ALL query tokens matched across fields', () => {
    // Compare two concepts where one matches all tokens (bonus) and the
    // other matches only some (no bonus).
    const pool: ConceptCandidate[] = [
      cc('concept-all', 'Foo Bar', 'Relates to Quux.'),
      cc('concept-some', 'Foo Bar', 'Just some words.'),
    ]
    // tokens include "quux" which only concept-all has (in definition)
    const hits = tierTokenMatch(['foo', 'bar', 'quux'], pool)
    const all = hits.find((h) => h.candidate.identifier === 'concept-all')!
    const some = hits.find((h) => h.candidate.identifier === 'concept-some')!
    expect(all.score).toBeGreaterThan(some.score)
  })

  it('label hits outweigh any number of definition hits', () => {
    // Deliberately constructed: one concept has 1 label hit,
    // another has 5 definition hits. Label must still win.
    const pool: ConceptCandidate[] = [
      cc('concept-label-only', 'Foo Banana', ''),
      cc('concept-def-heavy', 'Unrelated Thing', 'banana banana banana banana banana'),
    ]
    const hits = tierTokenMatch(['banana'], pool)
    const byScore = hits.slice().sort((a, b) => b.score - a.score)
    expect(byScore[0]?.candidate.identifier).toBe('concept-label-only')
  })

  it('returns empty for empty tokens', () => {
    expect(tierTokenMatch([], POOL)).toHaveLength(0)
  })

  it('returns empty when no token matches anywhere', () => {
    expect(tierTokenMatch(['quantum', 'cryptography'], POOL)).toHaveLength(0)
  })

  it('does not match internal substrings (whole-word only)', () => {
    // "lake" must NOT match a label containing "lakehouse" via TOKEN_MATCH,
    // because that would surface bridging concepts over real targets.
    const pool: ConceptCandidate[] = [
      cc('concept-lakehouse', 'Lakehouse', ''),
    ]
    expect(tierTokenMatch(['lake'], pool)).toHaveLength(0)
  })

  it('applies hub-node damping: high linkCount reduces score (#50)', () => {
    // Two concepts with identical label tokens but different link counts.
    // The hub (linkCount=13, like LLM Security) should score lower.
    const pool: ConceptCandidate[] = [
      cc('concept-leaf', 'Security Testing', '', [], '', 0),
      cc('concept-hub', 'Security Testing', '', [], '', 13),
    ]
    const hits = tierTokenMatch(['security', 'testing'], pool)
    const leaf = hits.find((h) => h.candidate.identifier === 'concept-leaf')!
    const hub = hits.find((h) => h.candidate.identifier === 'concept-hub')!
    expect(leaf.score).toBeGreaterThan(hub.score)
  })

  it('hub damping does not affect concepts with linkCount=0', () => {
    const pool: ConceptCandidate[] = [
      cc('concept-zero', 'Foo Bar', '', [], '', 0),
      cc('concept-linked', 'Foo Bar', '', [], '', 10),
    ]
    const hits = tierTokenMatch(['foo'], pool)
    const zero = hits.find((h) => h.candidate.identifier === 'concept-zero')!
    const linked = hits.find((h) => h.candidate.identifier === 'concept-linked')!
    // linkCount=0 → damping factor 1.0 → full score preserved
    // linkCount=10 → damping factor 0.5 → half score
    expect(zero.score).toBeGreaterThan(linked.score)
    expect(zero.score).toBe(linked.score * 2)
  })

  it('hub damping ranks specific concept above generic hub for same query', () => {
    // Simulates the real benchmark case: "injection attack controls"
    // LLM Security (hub, 13 links) has "security" in label → score 4 * 0.43 = 1.74
    // SQL Injection (leaf, 2 links) has "injection" in label → score 4 * 0.83 = 3.33
    const pool: ConceptCandidate[] = [
      cc('concept-llm-security', 'LLM Security',
        'attacks including prompt injection, data poisoning, model inversion',
        [], '', 13),
      cc('concept-sql-injection', 'SQL Injection',
        'A code injection technique that exploits a security vulnerability',
        [], '', 2),
    ]
    const hits = tierTokenMatch(['injection', 'security'], pool)
    const byScore = hits.slice().sort((a, b) => b.score - a.score)
    // SQL Injection should rank above LLM Security despite both matching
    expect(byScore[0]?.candidate.identifier).toBe('concept-sql-injection')
  })
})

// ── Tier 5: FUZZY_TRIGRAM ─────────────────────────────────────────────────────

describe('tierFuzzyTrigram', () => {
  it('matches typos against labels', () => {
    // "autehntication" is a typo of "Authentication"
    const hits = tierFuzzyTrigram('autehntication', POOL)
    expect(hits.some((h) => h.candidate.identifier === 'concept-authentication')).toBe(true)
  })

  it('matches singular/plural variants', () => {
    // "vulnerabilities" vs "Vulnerability" label
    const hits = tierFuzzyTrigram('vulnerabilities', POOL)
    expect(hits.some((h) => h.candidate.identifier === 'concept-vulnerability')).toBe(true)
  })

  it('returns empty for completely unrelated queries', () => {
    const hits = tierFuzzyTrigram('xyzzy wibble grombulator', POOL)
    expect(hits).toHaveLength(0)
  })

  it('tags hits with tier=5', () => {
    const hits = tierFuzzyTrigram('Authentication', POOL) // exact label also works here
    for (const h of hits) expect(h.tier).toBe(5)
  })

  it('respects a custom threshold', () => {
    // Very high threshold blocks even perfect matches below 1.0
    const hits = tierFuzzyTrigram('vulnerabilities', POOL, 0.99)
    expect(hits).toHaveLength(0)
  })
})

// ── Orchestrator: runTiers ────────────────────────────────────────────────────

describe('runTiers composition', () => {
  it('returns exact-label match with match_tier=1', () => {
    const results = runTiers('Role-Based Access Control', [], POOL, 10)
    expect(results[0]?.tier).toBe(1)
    expect(results[0]?.candidate.identifier).toBe('concept-rbac')
  })

  it('returns exact-alias match with match_tier=2', () => {
    const results = runTiers('RBAC', ['rbac'], POOL, 10)
    expect(results[0]?.tier).toBe(2)
    expect(results[0]?.candidate.identifier).toBe('concept-rbac')
  })

  it('prefers tier 1 over tier 2 for same concept', () => {
    // Exact label wins even if alias also matches
    const results = runTiers('Role-Based Access Control', ['role-based', 'access', 'control'], POOL, 10)
    const rbac = results.find((r) => r.candidate.identifier === 'concept-rbac')
    expect(rbac?.tier).toBe(1)
  })

  it('early-exits at Tier 3 when it has hits', () => {
    // "access control" is a substring of the RBAC label (Tier 3).
    // Should NOT continue to Tier 4 which would produce more hits.
    const results = runTiers('access control', ['access', 'control'], POOL, 10)
    const fallbackTiers = results.filter((r) => r.tier >= 3).map((r) => r.tier)
    expect(fallbackTiers.every((t) => t === 3)).toBe(true)
  })

  it('falls through to Tier 4 when Tier 3 is empty', () => {
    // "SAST DAST" phrase is not in any field (Tier 3 empty).
    // Tier 4 TOKEN_MATCH returns both concepts.
    const results = runTiers('SAST DAST', ['sast', 'dast'], POOL, 10)
    const tier4Ids = results.filter((r) => r.tier === 4).map((r) => r.candidate.identifier).sort()
    expect(tier4Ids).toContain('concept-sast')
    expect(tier4Ids).toContain('concept-dast')
  })

  it('tiers 1+2 always contribute even when tier 3+ has other hits', () => {
    // "RBAC" is an exact alias (Tier 2). "RBAC" is ALSO substring of the
    // RBAC label's definition... actually no, definition doesn't contain "RBAC".
    // But it IS the alias. Let's craft: query "Authentication" matches
    // label exactly (Tier 1) AND appears in other concepts' definitions (Tier 3)
    const results = runTiers('Authentication', ['authentication'], POOL, 10)
    // Tier 1 hit must be present
    expect(results.some((r) => r.tier === 1 && r.candidate.identifier === 'concept-authentication')).toBe(true)
  })

  it('deduplicates concepts that match multiple tiers, keeping lowest tier', () => {
    // Query "Vulnerability": exact label (Tier 1) AND substring match (Tier 3)
    const results = runTiers('Vulnerability', ['vulnerability'], POOL, 10)
    const vuln = results.filter((r) => r.candidate.identifier === 'concept-vulnerability')
    expect(vuln).toHaveLength(1) // no duplicate
    expect(vuln[0]?.tier).toBe(1) // kept the lowest tier
  })

  it('sorts by tier ascending then score descending', () => {
    const results = runTiers('access control', ['access', 'control'], POOL, 10)
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!
      const cur = results[i]!
      expect(prev.tier).toBeLessThanOrEqual(cur.tier)
      if (prev.tier === cur.tier) {
        expect(prev.score).toBeGreaterThanOrEqual(cur.score)
      }
    }
  })

  it('respects the limit parameter', () => {
    const results = runTiers('security', ['security'], POOL, 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('returns empty array when no tier matches', () => {
    const results = runTiers('qqqqqqqqqqqqqqq', ['qqqqqqqqqqqqqqq'], POOL, 10)
    expect(results).toEqual([])
  })
})
