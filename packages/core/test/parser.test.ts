import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../src/parser/frontmatter.js'

const fixtures = join(import.meta.dirname, 'fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf-8')
}

describe('parseFrontmatter', () => {
  it('parses a complete SKOS concept (Centroid)', () => {
    const result = parseFrontmatter(readFixture('Centroid.md'), '_concepts/Centroid.md')
    expect(result).not.toBeNull()
    expect(result!.prefLabel).toBe('Centroid')
    expect(result!.definition).toContain('center point')
    expect(result!.identifier).toBe('concept-centroid')
    expect(result!.broader).toHaveLength(1)
    expect(result!.broader[0]).toContain('k-means')
    expect(result!.related).toHaveLength(1)
    expect(result!.filePath).toBe('_concepts/Centroid.md')
  })

  it('handles missing skos:narrower gracefully (CNNs)', () => {
    const result = parseFrontmatter(
      readFixture('ConvolutionalNeuralNetworks.md'),
      '_concepts/ConvolutionalNeuralNetworks.md',
    )
    expect(result).not.toBeNull()
    expect(result!.narrower).toEqual([])
    expect(result!.broader.length).toBeGreaterThanOrEqual(1)
  })

  it('reads only the first frontmatter block (Random Forests duplicate blocks)', () => {
    const result = parseFrontmatter(readFixture('RandomForests.md'), '_concepts/RandomForests.md')
    expect(result).not.toBeNull()
    expect(result!.prefLabel).toBe('Random Forests')
    // gray-matter reads only the first block — should have 1 related entry
    expect(Array.isArray(result!.related)).toBe(true)
  })

  it('returns null for legacy non-SKOS files', () => {
    const result = parseFrontmatter(readFixture('LegacyConcept.md'), '_concepts/LegacyConcept.md')
    expect(result).toBeNull()
  })

  it('returns null for a file with no frontmatter', () => {
    const result = parseFrontmatter('# Just a heading\n\nSome content.', 'notes/bare.md')
    expect(result).toBeNull()
  })
})

describe('normalizeDate (via parseFrontmatter)', () => {
  it('normalizes wikilinked DD.MM.YYYY date', () => {
    const md = `---
skos:prefLabel: Test
skos:definition: A test concept.
skos:broader: []
skos:related: []
"@type": DefinedTerm
identifier: concept-test
dateCreated: "[[17.01.2026]]"
aliases: []
tags: ["#concept"]
---
`
    const result = parseFrontmatter(md, '_concepts/Test.md')
    expect(result!.dateCreated).toBe('2026-01-17')
  })

  it('passes through ISO date unchanged', () => {
    const md = `---
skos:prefLabel: Test
skos:definition: A test concept.
skos:broader: []
skos:related: []
"@type": DefinedTerm
identifier: concept-test
dateCreated: "2026-02-10"
aliases: []
tags: []
---
`
    const result = parseFrontmatter(md, '_concepts/Test.md')
    expect(result!.dateCreated).toBe('2026-02-10')
  })
})
