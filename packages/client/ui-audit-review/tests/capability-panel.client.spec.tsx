// @vitest-environment jsdom
/** Shared capability controls cover business actions in every presentation. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuditState } from '@deepseek-ai/dsh-audit-review/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CapabilityPanel, printableAuditHtml } from '../src/client/views/CapabilityPanel.tsx'
import type { ViewProps } from '../src/client/views/types.ts'
import { en } from '../src/client/locales.ts'

const t: TranslateNS<'audit'> = (key, replacements) => {
  let value = en[key as keyof typeof en] ?? key
  for (const [name, replacement] of Object.entries(replacements ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}
const state: AuditState = {
  round: 3,
  documentPath: 'contract.docx',
  findings: [{ id: 'f1', title: 'Payment term', anchor: { path: 'contract.docx', line: 1, quote: 'Net 30' }, issue: '[Medium] Review term', replacement: 'Net 15' }],
  decisions: {},
  presentationHints: { capabilities: {
    scoring: { enabled: true, target: 'finding', label: 'Risk score', range: [1, 5] },
    commenting: { enabled: true },
    tagging: { enabled: true, allowedTags: ['legal', 'finance'] },
    tracking: { enabled: true },
    exporting: { enabled: true, formats: ['json'] },
  } },
}

function props(overrides: Partial<ViewProps> = {}): ViewProps {
  return {
    state, t,
    onRate: vi.fn().mockResolvedValue(true), onComment: vi.fn().mockResolvedValue(true),
    onEditReplacement: vi.fn().mockResolvedValue(true),
    onTag: vi.fn().mockResolvedValue(true), onTrack: vi.fn().mockResolvedValue(true),
    onExportData: vi.fn().mockResolvedValue({ ok: true, data: '{}', filename: 'review.json', mimeType: 'application/json' }),
    ...overrides,
  } as ViewProps
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('exports reports from one compact toolbar', async () => {
  const callbacks = props()
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:review')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  render(<CapabilityPanel {...callbacks} />)
  fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }))

  expect(callbacks.onExportData).toHaveBeenCalledWith(3, 'html')
  expect(screen.queryByRole('button', { name: 'Export JSON' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Export MARKDOWN' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Export PDF' })).toBeTruthy()
  await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
})

it('builds a printable PDF report without executable finding markup', () => {
  const html = printableAuditHtml([{ id: 'f1', title: '<script>alert(1)</script>', anchor: { path: 'a.txt', line: 1, quote: 'x' }, issue: 'Review & approve' }])
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('Review &amp; approve')
  expect(html).not.toContain('<script>alert(1)</script>')
})

it('keeps comments, scoring and progress out of the shared toolbar', () => {
  render(<CapabilityPanel {...props({ state: { ...state, presentationHints: { capabilities: { commenting: { enabled: false } } } } })} />)
  expect(screen.getByRole('region', { name: 'Business actions' })).toBeTruthy()
  expect(screen.queryByText('More')).toBeNull()
  expect(screen.queryByLabelText('Add comment')).toBeNull()
  expect(screen.queryByLabelText('Status')).toBeNull()
  expect(screen.queryByLabelText('Risk score')).toBeNull()
  expect(screen.queryByLabelText('Assignee')).toBeNull()
  expect(screen.queryByLabelText('Due date')).toBeNull()
})

it('shows a visible failure outcome', async () => {
  render(<CapabilityPanel {...props({ onExportData: vi.fn().mockResolvedValue({ ok: false, error: { code: 'failed', message: 'Export failed' } }) })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }))
  const status = await screen.findByRole('status')
  expect(status.textContent).toBe('Export failed')
  expect(status.closest('section')).not.toBeNull()
})

it('clears transient operation feedback', async () => {
  vi.useFakeTimers()
  render(<CapabilityPanel {...props()} />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }))
    await Promise.resolve()
  })
  expect(screen.getByRole('status').textContent).toBe(en['operation.exported'])
  act(() => vi.advanceTimersByTime(2_500))
  expect(screen.queryByRole('status')).toBeNull()
})
