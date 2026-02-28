/**
 * Fixed prefix-to-URI mapping for the SKOS + Schema.org vocabulary used in the vault.
 *
 * Replaces the jsonld npm package — the vault uses a small, fixed vocabulary
 * so a ~50-line custom mapper is simpler, faster, and dependency-free.
 */

export const SKOS_NS = 'http://www.w3.org/2004/02/skos/core#'
export const SCHEMA_NS = 'https://schema.org/'
export const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'

export const SKOS = {
  prefLabel: `${SKOS_NS}prefLabel`,
  definition: `${SKOS_NS}definition`,
  broader: `${SKOS_NS}broader`,
  narrower: `${SKOS_NS}narrower`,
  related: `${SKOS_NS}related`,
  Concept: `${SKOS_NS}Concept`,
} as const

export const SCHEMA = {
  DefinedTerm: `${SCHEMA_NS}DefinedTerm`,
  identifier: `${SCHEMA_NS}identifier`,
  dateCreated: `${SCHEMA_NS}dateCreated`,
  name: `${SCHEMA_NS}name`,
} as const

export const RDF = {
  type: `${RDF_NS}type`,
} as const

/**
 * Expand a YAML frontmatter property name to its full URI.
 *
 * @example expandPrefix('skos:prefLabel') → 'http://www.w3.org/2004/02/skos/core#prefLabel'
 * @throws  Error if the prefix is unknown
 */
export function expandPrefix(prefixed: string): string {
  const colonIdx = prefixed.indexOf(':')
  if (colonIdx === -1) throw new Error(`Not a prefixed name: "${prefixed}"`)
  const prefix = prefixed.slice(0, colonIdx)
  const local = prefixed.slice(colonIdx + 1)

  switch (prefix) {
    case 'skos':   return `${SKOS_NS}${local}`
    case 'schema': return `${SCHEMA_NS}${local}`
    case 'rdf':    return `${RDF_NS}${local}`
    default:       throw new Error(`Unknown prefix: "${prefix}"`)
  }
}
