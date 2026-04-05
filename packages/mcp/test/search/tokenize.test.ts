import { describe, it, expect } from 'vitest'
import { tokenize, normalize, countTokenHits } from '../../src/search/tokenize.js'

describe('tokenize', () => {
  it('splits on whitespace and lowercases', () => {
    expect(tokenize('SAST DAST')).toEqual(['sast', 'dast'])
  })

  it('removes common English stopwords', () => {
    expect(tokenize('SAST vs DAST')).toEqual(['sast', 'dast'])
    expect(tokenize('what is the CAP theorem')).toEqual(['cap', 'theorem'])
    // "compare" is a stopword; "a"/"and"/"b" all dropped (stopwords or < 2 chars)
    expect(tokenize('compare A and B')).toEqual([])
    // Realistic: "x vs y" drops everything (single chars + stopword)
    expect(tokenize('x vs y')).toEqual([])
  })

  it('keeps hyphenated words intact', () => {
    expect(tokenize('Role-Based Access Control')).toEqual(['role-based', 'access', 'control'])
  })

  it('strips punctuation from word edges', () => {
    expect(tokenize('What is Zero Trust Architecture?')).toEqual([
      'zero',
      'trust',
      'architecture',
    ])
    expect(tokenize('"Data Lake" & "Data Warehouse"')).toEqual([
      'data',
      'lake',
      'warehouse',
    ])
  })

  it('drops tokens shorter than 2 characters', () => {
    // "a" and "i" filtered both by length and by stopwords
    expect(tokenize('a is x')).toEqual([])
  })

  it('deduplicates tokens preserving first-occurrence order', () => {
    expect(tokenize('Data Lake Data Warehouse Data')).toEqual(['data', 'lake', 'warehouse'])
  })

  it('returns empty array for whitespace-only input', () => {
    expect(tokenize('   ')).toEqual([])
    expect(tokenize('')).toEqual([])
  })

  it('handles numeric tokens', () => {
    expect(tokenize('ISO 27001 standard')).toEqual(['iso', '27001', 'standard'])
  })

  it('handles a realistic benchmark zero-hit query', () => {
    // Actual query from ontobi-bench zero-hit results
    expect(tokenize('Common Weakness Enumeration Common Vulnerabilities and Exposures')).toEqual([
      'common',
      'weakness',
      'enumeration',
      'vulnerabilities',
      'exposures',
    ])
  })

  it('strips leading and trailing hyphens from tokens', () => {
    expect(tokenize('--foo bar-- -baz-')).toEqual(['foo', 'bar', 'baz'])
  })
})

describe('normalize', () => {
  it('lowercases and trims', () => {
    expect(normalize('  Hello World  ')).toBe('hello world')
  })

  it('passes through already-normalised strings', () => {
    expect(normalize('k-means')).toBe('k-means')
  })
})

describe('countTokenHits', () => {
  it('counts whole-word hits in haystack', () => {
    // Hyphenated "role-based" is a single word containing both "role" and
    // "based" via the hyphen boundary — it counts as one hyphenated whole
    // word "role-based", not as two separate "role" + "based" tokens.
    expect(countTokenHits(['role-based'], 'Role-Based Access Control')).toBe(1)
    expect(countTokenHits(['role-based', 'access'], 'Role-Based Access Control')).toBe(2)
  })

  it('does NOT match tokens as internal substrings', () => {
    // "lake" must not match "lakehouse" — prevents bridging-concept false
    // positives. This is the intended semantic of whole-word matching.
    expect(countTokenHits(['lake'], 'Data Lakehouse')).toBe(0)
    // Similarly "auth" does not match "authentication".
    expect(countTokenHits(['auth'], 'Authentication')).toBe(0)
  })

  it('matches at word boundaries even with punctuation', () => {
    // Parenthesised acronyms count as whole-word hits.
    expect(countTokenHits(['sast'], 'Static Application Security Testing (SAST)')).toBe(1)
    // Quoted labels count.
    expect(countTokenHits(['security'], '"Security" and "privacy"')).toBe(1)
  })

  it('returns 0 when no tokens match', () => {
    expect(countTokenHits(['xyz', 'abc'], 'Hello World')).toBe(0)
  })

  it('returns 0 for empty tokens', () => {
    expect(countTokenHits([], 'Hello World')).toBe(0)
  })

  it('returns 0 for empty haystack', () => {
    expect(countTokenHits(['foo'], '')).toBe(0)
  })

  it('counts each token once even if it appears multiple times', () => {
    // `countTokenHits` tests token presence, not occurrence count
    expect(countTokenHits(['foo'], 'foo foo foo bar')).toBe(1)
  })

  it('is case-insensitive in both tokens and haystack', () => {
    expect(countTokenHits(['security'], 'Security is important')).toBe(1)
    expect(countTokenHits(['SECURITY'], 'security')).toBe(1)
    expect(countTokenHits(['Security'], 'SECURITY AUDIT')).toBe(1)
  })
})
