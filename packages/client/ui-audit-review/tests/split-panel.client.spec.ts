// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { prepareDocumentHtml } from '../src/client/views/SplitPanelView.tsx'

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
