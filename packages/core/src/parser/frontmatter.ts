import matter from 'gray-matter'
import type { ConceptMetadata } from '../types.js'
import { resolveWikilink, normalizeDate, labelToIdentifier } from './wikilink.js'

/**
 * Parse Obsidian .md frontmatter into typed ConceptMetadata.
 *
 * Returns null for files that are not SKOS concept files:
 *   - No frontmatter at all
 *   - Legacy schema (hasTopic / isA / Created — no skos:prefLabel)
 *
 * Handles all edge cases observed in the live vault:
 *   - Optional skos:narrower (defaults to [])
 *   - Wikilinks in relational arrays: "[[Concept Name]]" → resolved identifier
 *   - Wikilinks in dateCreated: "[[17.01.2026]]" → '2026-01-17'
 *   - Mixed inline/block YAML array syntax (handled by gray-matter/js-yaml)
 *   - Quoted and unquoted scalars (handled by js-yaml)
 *   - Duplicate frontmatter blocks — gray-matter reads only the first
 */
export function parseFrontmatter(fileContent: string, filePath: string): ConceptMetadata | null {
  const { data } = matter(fileContent)

  // Must have skos:prefLabel to be treated as a SKOS concept
  const prefLabel = data['skos:prefLabel']
  if (typeof prefLabel !== 'string' || prefLabel.trim() === '') return null

  const definition = typeof data['skos:definition'] === 'string'
    ? data['skos:definition'].trim()
    : ''

  const broader = parseWikilinkArray(data['skos:broader'])
  const narrower = parseWikilinkArray(data['skos:narrower'])
  const related = parseWikilinkArray(data['skos:related'])

  const rawIdentifier = data['identifier']
  const identifier = typeof rawIdentifier === 'string' && rawIdentifier.trim() !== ''
    ? rawIdentifier.trim()
    : labelToIdentifier(prefLabel)

  const rawDate = data['dateCreated']
  const dateCreated = typeof rawDate === 'string'
    ? normalizeDate(rawDate)
    : ''

  const type = typeof data['@type'] === 'string' ? data['@type'] : 'DefinedTerm'

  const aliases = parseStringArray(data['aliases'])
  const tags = parseStringArray(data['tags'])

  return {
    prefLabel: prefLabel.trim(),
    definition,
    broader,
    narrower,
    related,
    type,
    identifier,
    dateCreated,
    aliases,
    tags,
    filePath,
  }
}

/**
 * Parse a frontmatter value that should be an array of wikilink strings.
 * Accepts: string[], null, undefined, or a single string.
 * Wikilinks are resolved to concept identifiers.
 */
function parseWikilinkArray(value: unknown): string[] {
  if (value === null || value === undefined) return []
  const raw = Array.isArray(value)
    ? (value as unknown[])
    : typeof value === 'string'
      ? [value]
      : []
  return raw
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => {
      const label = resolveWikilink(v)
      return labelToIdentifier(label)
    })
}

/**
 * Parse a frontmatter value that should be an array of plain strings.
 */
function parseStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return []
  const raw = Array.isArray(value)
    ? (value as unknown[])
    : typeof value === 'string'
      ? [value]
      : []
  return raw
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim())
}
