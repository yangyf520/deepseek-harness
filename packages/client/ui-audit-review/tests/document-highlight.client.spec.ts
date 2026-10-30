// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { highlightQuote, unwrapHighlights } from '../src/client/views/documentHighlight.ts'

it('locates evidence across HTML runs when converted text omits surrounding words', () => {
  const container = document.createElement('div')
  container.innerHTML = '<p>服务性质：<strong>本产品提供拟人化互动服务</strong>，建立义务清单。</p>'

  const mark = highlightQuote(container, '前置标签 | 本产品提供拟人化互动服务，并逐条落实义务清单', 'high')

  expect(mark?.textContent).toContain('本产品提供拟人化互动服务')
  expect(container.querySelectorAll('mark[data-audit-highlight]').length).toBeGreaterThan(0)
  unwrapHighlights(container)
  expect(container.querySelector('mark')).toBeNull()
})
