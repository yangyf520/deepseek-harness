import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  new URL('../src/client/views/ReviewPresentation.module.css', import.meta.url),
  'utf8',
)

describe('review presentation styles', () => {
  it('draws the conversation overview with one neutral hairline border', () => {
    const overviewCard = stylesheet.match(/\.overviewCard\s*\{(?<rules>[^}]*)\}/)?.groups?.rules

    expect(overviewCard).toContain('border: 0.5px solid var(--dsw-alias-border-l4)')
    expect(overviewCard).toContain('border-radius: var(--dsw-radius-sm)')
    expect(overviewCard).not.toContain('box-shadow')
  })
})
