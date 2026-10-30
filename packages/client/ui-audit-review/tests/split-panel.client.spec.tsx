// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditState } from '@deepseek-ai/dsh-audit-review/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '../src/client/locales.ts'
import { prepareDocumentHtml, SplitPanelView } from '../src/client/views/SplitPanelView.tsx'

afterEach(cleanup)

describe('split-panel document preview', () => {
  it('keeps converted document styles and active content out of the application page', () => {
    const html = prepareDocumentHtml(`<!doctype html><html><head>
      <style>body { margin: 2em } div { display: none }</style>
      <script>globalThis.compromised = true</script>
    </head><body onload="compromise()"><h1 onclick="compromise()">Review</h1><p>Evidence</p></body></html>`)

    expect(html).toContain('[data-audit-document] h1')
    expect(html).toContain('<h1>Review</h1>')
    expect(html).toContain('<p>Evidence</p>')
    expect(html).not.toContain('margin: 2em')
    expect(html).not.toContain('display: none')
    expect(html).not.toContain('compromise')
    expect(html).not.toContain('globalThis')
  })
})

it('filters findings by decision while retaining the original item number', async () => {
  const state: AuditState = {
    round: 1,
    documentPath: 'review.txt',
    findings: [
      { id: 'accepted', anchor: { path: 'review.txt', line: 1, quote: 'First' }, issue: '[High] First issue' },
      { id: 'pending', anchor: { path: 'review.txt', line: 2, quote: 'Second' }, issue: '[Low] Second issue' },
    ],
    decisions: { accepted: 'accept' },
  }
  const t: TranslateNS<'audit'> = key => en[key as keyof typeof en] ?? key
  const onFilterChange = vi.fn()
  render(<SplitPanelView
    state={state}
    sessionId={'session' as SessionId}
    readFileBytes={vi.fn().mockResolvedValue(new TextEncoder().encode('First\nSecond'))}
    t={t}
    onDecide={vi.fn()}
    onApply={vi.fn()}
    filter="pending"
    onFilterChange={onFilterChange}
  />)

  expect(screen.queryByText(/First issue/)).toBeNull()
  const pending = document.querySelector('[data-finding-id="pending"]')
  expect(pending?.textContent).toContain('Second issue')
  expect(pending?.textContent).toContain('2')
  fireEvent.click(screen.getByRole('button', { name: /All\s*2/ }))
  expect(onFilterChange).toHaveBeenCalledWith('all')
  const list = pending?.parentElement as (HTMLElement & { scrollTo: ReturnType<typeof vi.fn> }) | null
  const scrollTo = vi.fn()
  if (list !== null) list.scrollTo = scrollTo
  fireEvent.doubleClick(screen.getByText('Findings'))
  expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
})
