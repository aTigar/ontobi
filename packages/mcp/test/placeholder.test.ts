import { describe, it, expect } from 'vitest'
import { graphUriToRelPath } from '../src/file-reader.js'

describe('file-reader utilities', () => {
  it('strips file:/// prefix from graph URIs', () => {
    expect(graphUriToRelPath('file:///_concepts/Centroid.md')).toBe('_concepts/Centroid.md')
  })
})
