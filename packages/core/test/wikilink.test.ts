import { describe, it, expect } from 'vitest'
import { resolveWikilink, labelToIdentifier, normalizeDate, filePathToGraphUri, graphUriToFilePath } from '../src/parser/wikilink.js'

describe('resolveWikilink', () => {
  it('strips [[ ]] from wikilinks', () => {
    expect(resolveWikilink('[[K-Means Clustering]]')).toBe('K-Means Clustering')
  })
  it('passes through plain strings unchanged', () => {
    expect(resolveWikilink('K-Means Clustering')).toBe('K-Means Clustering')
  })
  it('handles concept names with parentheses', () => {
    expect(resolveWikilink('[[Bootstrap Aggregation (Bagging)]]')).toBe('Bootstrap Aggregation (Bagging)')
  })
})

describe('labelToIdentifier', () => {
  it('converts label to slug', () => {
    expect(labelToIdentifier('Centroid')).toBe('concept-centroid')
    expect(labelToIdentifier('K-Means Clustering')).toBe('concept-k-means-clustering')
    expect(labelToIdentifier('Random Forests')).toBe('concept-random-forests')
  })
  it('handles parentheses in names', () => {
    expect(labelToIdentifier('Bootstrap Aggregation (Bagging)')).toBe('concept-bootstrap-aggregation-bagging')
  })
})

describe('normalizeDate', () => {
  it('normalizes DD.MM.YYYY wikilink', () => {
    expect(normalizeDate('[[17.01.2026]]')).toBe('2026-01-17')
    expect(normalizeDate('[[03.02.2026]]')).toBe('2026-02-03')
  })
  it('normalizes DD-MM-YYYY wikilink', () => {
    expect(normalizeDate('[[24-12-2025]]')).toBe('2025-12-24')
  })
  it('passes through ISO dates', () => {
    expect(normalizeDate('2026-02-10')).toBe('2026-02-10')
  })
  it('handles plain date string (no wikilink)', () => {
    expect(normalizeDate('17.01.2026')).toBe('2026-01-17')
  })
})

describe('filePathToGraphUri / graphUriToFilePath', () => {
  it('round-trips a relative path', () => {
    const path = '_concepts/Centroid.md'
    const uri = filePathToGraphUri(path)
    expect(uri).toBe('file:///_concepts/Centroid.md')
    expect(graphUriToFilePath(uri)).toBe(path)
  })
})
