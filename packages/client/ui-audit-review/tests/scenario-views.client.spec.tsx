// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditState } from '@deepseek-ai/dsh-audit-review/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '../src/client/locales.ts'
import { ViewSwitcher } from '../src/client/views/ViewSwitcher.tsx'
import type { ViewProps } from '../src/client/views/types.ts'

const t: TranslateNS<'audit'> = (key, replacements) => {
  let value = en[key as keyof typeof en] ?? key
  for (const [name, replacement] of Object.entries(replacements ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}

function props(state: AuditState): ViewProps {
  return {
    state,
    t,
    onDecide: vi.fn(),
    onApply: vi.fn(),
    onEditReplacement: vi.fn(),
  } as unknown as ViewProps
}

afterEach(cleanup)

describe('configured review views', () => {
  it('shows one shared empty state before selecting a layout', () => {
    render(<ViewSwitcher {...props({ round: 1, documentPath: 'review.txt', findings: [], decisions: {}, presentationHints: { layout: 'matrix' } })} />)
    expect(screen.getByText('No audit data')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('preserves table semantics for matrix comparisons', () => {
    render(<ViewSwitcher {...props({
      round: 1,
      documentPath: 'review.txt',
      findings: [{ id: 'finding', anchor: { path: 'review.txt', line: 1, quote: 'quote' }, issue: '[High] Compare this' }],
      decisions: {},
      presentationHints: { layout: 'matrix', capabilities: { comparing: { enabled: true } } },
    })} />)
    expect(screen.getByRole('heading', { name: 'Comparison matrix' })).toBeTruthy()
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getAllByText(/Compare this/)).toHaveLength(2)
  })

  it('preserves event semantics for timeline tracking', () => {
    render(<ViewSwitcher {...props({
      round: 1,
      documentPath: 'review.txt',
      findings: [{ id: 'finding', anchor: { path: 'review.txt', line: 1, quote: 'quote' }, issue: '[Low] Track this' }],
      decisions: {},
      presentationHints: { layout: 'timeline', capabilities: { tracking: { enabled: true } } },
    })} />)
    expect(screen.getByRole('heading', { name: 'Timeline' })).toBeTruthy()
    expect(screen.getByText('Finding created')).toBeTruthy()
    expect(screen.getByText(/Track this/)).toBeTruthy()
  })
})
