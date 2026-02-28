import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Direct concept file reader.
 *
 * Reads .md files directly from disk — no Obsidian API, no HTTP round-trip.
 * The concept file path is resolved from the SPARQL named graph URI:
 *   'file:///_concepts/Centroid.md' → '<vaultPath>/_concepts/Centroid.md'
 */

/**
 * Resolve a named graph URI to an absolute file path and read it.
 *
 * @param vaultPath  Absolute path to vault root (from config)
 * @param graphUri   Named graph URI, e.g. 'file:///_concepts/Centroid.md'
 */
export async function readConceptByGraphUri(
  vaultPath: string,
  graphUri: string,
): Promise<string> {
  const relPath = graphUriToRelPath(graphUri)
  const absPath = join(vaultPath, relPath)
  return readFile(absPath, 'utf-8')
}

/**
 * Read a concept file by its relative path within the vault.
 *
 * @param vaultPath  Absolute path to vault root
 * @param relPath    Relative path, e.g. '_concepts/Centroid.md'
 */
export async function readConceptByPath(vaultPath: string, relPath: string): Promise<string> {
  return readFile(join(vaultPath, relPath), 'utf-8')
}

/**
 * Convert a named graph URI to a relative file path.
 * 'file:///_concepts/Centroid.md' → '_concepts/Centroid.md'
 */
export function graphUriToRelPath(graphUri: string): string {
  return graphUri.replace(/^file:\/\/\//, '')
}
