// @vitest-environment jsdom
/** Shared review controls report failures and do not apply acknowledgments as deletions. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FindingCard } from '../src/client/views/FindingCard.tsx'
import { en } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import type { AuditFinding } from '@deepseek-ai/dsh-audit-review/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

const finding: AuditFinding = { id: 'f1', anchor: { path: 'a.txt', line: 1, quote: 'before' }, issue: 'Review this clause', replacement: 'after' }
const t: TranslateNS<'audit'> = key => en[key as keyof typeof en] ?? key

afterEach(cleanup)

it('does not apply a failed decision', async () => {
  const onDecide = vi.fn().mockResolvedValue(false)
  const onApply = vi.fn().mockResolvedValue(true)
  render(<FindingCard finding={finding} index={0} round={1} t={t} onDecide={onDecide} onApply={onApply} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['operation.decisionFailed'])
  expect(onApply).not.toHaveBeenCalled()
})

it('keeps a saved decision when its file application fails', async () => {
  const onDecide = vi.fn().mockResolvedValue(true)
  const onApply = vi.fn().mockResolvedValue(false)
  render(<FindingCard finding={finding} index={0} round={1} t={t} onDecide={onDecide} onApply={onApply} />)
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
  expect((await screen.findByRole('status')).textContent).toContain(en['operation.applySkipped'])
  expect(onApply).toHaveBeenCalledWith('f1', 1)
  expect(onDecide).toHaveBeenCalledTimes(1)
  expect(onDecide).toHaveBeenCalledWith('f1', 1, 'accept')
})

it('acknowledges evidence without changing the file', async () => {
  const onDecide = vi.fn().mockResolvedValue(true)
  const onApply = vi.fn().mockResolvedValue(true)
  const { replacement: _replacement, ...evidence } = finding
  render(<FindingCard finding={evidence} index={0} round={1} t={t} onDecide={onDecide} onApply={onApply} />)
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
  await waitFor(() => expect(onDecide).toHaveBeenCalledWith('f1', 1, 'accept'))
  expect(onApply).not.toHaveBeenCalled()
})

it('allows undo from the same shared card', async () => {
  const onDecide = vi.fn().mockResolvedValue(true)
  const onApply = vi.fn().mockResolvedValue(true)
  render(<FindingCard finding={finding} index={0} round={1} decided="accept" t={t} onDecide={onDecide} onApply={onApply} />)
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() => expect(onApply).toHaveBeenCalledWith('f1', 1))
  expect(onDecide).toHaveBeenCalledWith('f1', 1, 'undo')
})

it('keeps decided status and undo in the header action group', () => {
  render(<FindingCard finding={finding} index={0} round={1} decided="accept" t={t} onDecide={vi.fn()} onApply={vi.fn()} />)
  const status = screen.getByText('Accepted')
  expect(status.parentElement?.contains(screen.getByRole('button', { name: 'Undo' }))).toBe(true)
})
