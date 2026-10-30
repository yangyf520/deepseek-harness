import { describe, expect, it } from 'vitest'
import type { AuditState, PresentationHints } from '@deepseek-ai/dsh-audit-review/types'
import { chooseViewMode } from '../src/client/views/ViewSwitcher.tsx'

function state(presentationHints?: PresentationHints, paths: readonly string[] = ['review.txt']): AuditState {
  return {
    round: 1,
    documentPath: paths[0] ?? 'review.txt',
    decisions: {},
    findings: paths.map((path, index) => ({
      id: `finding-${index}`,
      title: index % 2 === 0 ? 'Generated: title' : 'Different: title',
      anchor: { path, line: index + 1, quote: `quote-${index}` },
      issue: '[Medium] Review this',
    })),
    ...(presentationHints === undefined ? {} : { presentationHints }),
  }
}

describe('chooseViewMode', () => {
  it('keeps one document in the stable split-panel layout despite generated title patterns', () => {
    expect(chooseViewMode(state(undefined, ['review.txt', 'review.txt', 'review.txt', 'review.txt']))).toBe('split-panel')
  })

  it('uses diff view for multiple source documents', () => {
    expect(chooseViewMode(state(undefined, ['first.txt', 'second.txt']))).toBe('diff-view')
  })

  it('requires the capability used by a specialized layout', () => {
    expect(chooseViewMode(state({ layout: 'grouped-list' }))).toBe('split-panel')
    expect(chooseViewMode(state({ layout: 'matrix' }))).toBe('split-panel')
    expect(chooseViewMode(state({ layout: 'timeline' }))).toBe('split-panel')
  })

  it('keeps configured specialized layouts', () => {
    expect(chooseViewMode(state({
      layout: 'grouped-list',
      capabilities: { grouping: { enabled: true, groupBy: 'section' } },
    }))).toBe('grouped-list')
    expect(chooseViewMode(state({
      layout: 'matrix',
      capabilities: { comparing: { enabled: true } },
    }))).toBe('matrix')
    expect(chooseViewMode(state({
      layout: 'timeline',
      capabilities: { tracking: { enabled: true } },
    }))).toBe('timeline')
  })

  it('maps custom presentation requests to a maintained standard layout', () => {
    expect(chooseViewMode(state({ layout: 'custom' }))).toBe('split-panel')
  })
})
