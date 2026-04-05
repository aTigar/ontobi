import { describe, it, expect } from 'vitest'
import {
  trigrams,
  jaccardSimilarity,
  bestFuzzyMatch,
  DEFAULT_FUZZY_THRESHOLD,
} from '../../src/search/fuzzy.js'

describe('trigrams', () => {
  it('returns empty set for empty input', () => {
    expect(trigrams('').size).toBe(0)
    expect(trigrams('   ').size).toBe(0)
  })

  it('pads short strings with spaces on both sides', () => {
    // "cat" → "  cat  " → {"  c", " ca", "cat", "at ", "t  "}
    const t = trigrams('cat')
    expect(t.has('  c')).toBe(true)
    expect(t.has(' ca')).toBe(true)
    expect(t.has('cat')).toBe(true)
    expect(t.has('at ')).toBe(true)
    expect(t.has('t  ')).toBe(true)
    expect(t.size).toBe(5)
  })

  it('is case-insensitive', () => {
    expect(trigrams('CAT')).toEqual(trigrams('cat'))
  })

  it('collapses internal whitespace to a single space', () => {
    expect(trigrams('data  lake')).toEqual(trigrams('data lake'))
    expect(trigrams('data\tlake')).toEqual(trigrams('data lake'))
  })

  it('deduplicates repeated trigrams', () => {
    // "abab" has "bab" only once in the set even though it appears once naturally
    const t = trigrams('aaaa')
    // Padded: "  aaaa  "
    // trigrams: "  a", " aa", "aaa", "aaa", "aa ", "a  "
    // Dedup: {"  a", " aa", "aaa", "aa ", "a  "} = 5
    expect(t.size).toBe(5)
  })
})

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaccardSimilarity('vulnerability', 'vulnerability')).toBe(1.0)
  })

  it('is case-insensitive', () => {
    expect(jaccardSimilarity('VULNERABILITY', 'vulnerability')).toBe(1.0)
  })

  it('returns 0 when either string is empty', () => {
    expect(jaccardSimilarity('', 'foo')).toBe(0)
    expect(jaccardSimilarity('foo', '')).toBe(0)
  })

  it('is symmetric', () => {
    const a = jaccardSimilarity('apple', 'apples')
    const b = jaccardSimilarity('apples', 'apple')
    expect(a).toBe(b)
  })

  it('scores singular/plural pairs above the default threshold', () => {
    // Common case: "vulnerability" vs "vulnerabilities"
    const s = jaccardSimilarity('vulnerability', 'vulnerabilities')
    expect(s).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD)
  })

  it('scores common typos above the default threshold', () => {
    const s = jaccardSimilarity('authetnication', 'authentication')
    expect(s).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD)
  })

  it('scores unrelated words below the default threshold', () => {
    const s = jaccardSimilarity('apple', 'orange')
    expect(s).toBeLessThan(DEFAULT_FUZZY_THRESHOLD)
  })

  it('returns a value in [0, 1]', () => {
    const pairs = [
      ['', ''],
      ['a', 'b'],
      ['data lake', 'data warehouse'],
      ['role-based access control', 'role-based access'],
    ] as const
    for (const [a, b] of pairs) {
      const s = jaccardSimilarity(a, b)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

describe('bestFuzzyMatch', () => {
  it('returns the highest-scoring candidate above threshold', () => {
    const result = bestFuzzyMatch('vulnerability', [
      'apple',
      'vulnerabilities',
      'orange',
      'vulnerability',
    ])
    expect(result).not.toBeNull()
    expect(result!.index).toBe(3) // identical match wins
    expect(result!.score).toBe(1.0)
  })

  it('returns null when no candidate crosses the threshold', () => {
    const result = bestFuzzyMatch('apple', ['xylophone', 'banana', 'cherry'])
    expect(result).toBeNull()
  })

  it('returns null for empty candidate list', () => {
    expect(bestFuzzyMatch('anything', [])).toBeNull()
  })

  it('respects a custom threshold', () => {
    // Use a very high threshold to reject near-matches
    expect(bestFuzzyMatch('vulnerability', ['vulnerabilities'], 0.95)).toBeNull()
    // And a very low threshold to accept them
    expect(bestFuzzyMatch('vulnerability', ['vulnerabilities'], 0.1)).not.toBeNull()
  })
})
