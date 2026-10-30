// @vitest-environment jsdom
/** Shared capability controls cover business actions in every presentation. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuditState } from '@deepseek-ai/dsh-audit-review/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CapabilityPanel } from '../src/client/views/CapabilityPanel.tsx'
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
  findings: [{ id: 'f1', title: 'Payment term', anchor: { path: 'contract.docx', line: 1, quote: 'Net 30' }, issue: '[Medium] Review term' }],
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
    onTag: vi.fn().mockResolvedValue(true), onTrack: vi.fn().mockResolvedValue(true),
    onExportData: vi.fn().mockResolvedValue({ ok: true, data: '{}', filename: 'review.json', mimeType: 'application/json' }),
    ...overrides,
  } as ViewProps
}

afterEach(cleanup)

it('runs score, comment, tag, tracking and export actions through one shared panel', async () => {
  const callbacks = props()
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:review')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  render(<CapabilityPanel {...callbacks} />)
  fireEvent.click(screen.getByText('More review actions'))

  fireEvent.change(screen.getByLabelText('Risk score'), { target: { value: '4' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save score' }))
  fireEvent.change(screen.getByLabelText('Add comment'), { target: { value: 'Needs owner review' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
  fireEvent.click(screen.getByLabelText('legal'))
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'in-progress' } })
  fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }))

  await waitFor(() => expect(callbacks.onRate).toHaveBeenCalledWith('f1', 3, 4))
  expect(callbacks.onComment).toHaveBeenCalledWith('f1', 3, 'Needs owner review')
  expect(callbacks.onTag).toHaveBeenCalledWith('f1', 3, ['legal'])
  expect(callbacks.onTrack).toHaveBeenCalledWith('f1', 3, expect.objectContaining({ status: 'in-progress' }))
  expect(callbacks.onExportData).toHaveBeenCalledWith(3, 'json')
  expect(createObjectURL).toHaveBeenCalled()
})

it('keeps baseline workflow actions open while hiding a disabled scenario action', () => {
  render(<CapabilityPanel {...props({ state: { ...state, presentationHints: { capabilities: { commenting: { enabled: false } } } } })} />)
  fireEvent.click(screen.getByText('More review actions'))
  expect(screen.getByRole('region', { name: 'Business actions' })).toBeTruthy()
  expect(screen.queryByLabelText('Add comment')).toBeNull()
  expect(screen.getByLabelText('Status')).toBeTruthy()
  expect(screen.queryByLabelText('Assignee')).toBeNull()
  expect(screen.queryByLabelText('Due date')).toBeNull()
})

it('shows a visible failure outcome', async () => {
  render(<CapabilityPanel {...props({ onRate: vi.fn().mockResolvedValue(false) })} />)
  fireEvent.click(screen.getByText('More review actions'))
  fireEvent.change(screen.getByLabelText('Risk score'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save score' }))
  const status = await screen.findByRole('status')
  expect(status.textContent).toBe(en['operation.failed'])
  expect(status.closest('summary')).not.toBeNull()
})
