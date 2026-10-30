/** Shared business-operation panel for every audit presentation. */
import { useEffect, useState } from 'react'
import type { AuditExportDataResult, AuditFinding } from '@deepseek-ai/dsh-audit-review/types'
import type { ViewProps } from './types.ts'
import { scenarioMetadataOf } from './CapabilityBadges.tsx'
import css from './CapabilityPanel.module.css'

type Outcome = { tone: 'success' | 'error'; text: string } | null
type VisibleExportFormat = 'csv' | 'html' | 'pdf'

function download(result: Extract<AuditExportDataResult, { ok: true }>): void {
  const url = URL.createObjectURL(new Blob([result.data], { type: result.mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = result.filename
  link.click()
  URL.revokeObjectURL(url)
}

function escapePrintable(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Build the printable report used by the browser's Save as PDF flow. */
export function printableAuditHtml(findings: readonly AuditFinding[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Audit review</title><style>
    @page { size: A4; margin: 18mm; }
    body { color: #172033; font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1 { margin: 0 0 18px; font-size: 22px; }
    article { break-inside: avoid; margin: 0 0 12px; padding: 12px; border: 1px solid #d9e0ea; border-radius: 8px; }
    h2 { margin: 0 0 6px; font-size: 15px; }
    p { margin: 4px 0; }
    .replacement { color: #1769e0; }
  </style></head><body><h1>Audit review</h1>${findings.map((finding, index) => `<article><h2>${index + 1}. ${escapePrintable(finding.title ?? finding.id)}</h2><p>${escapePrintable(finding.issue)}</p>${finding.replacement === undefined ? '' : `<p class="replacement">Suggested replacement: ${escapePrintable(finding.replacement)}</p>`}</article>`).join('')}</body></html>`
}

function printPDF(findings: readonly AuditFinding[]): void {
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.setAttribute('aria-hidden', 'true')
  frame.onload = () => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    setTimeout(() => frame.remove(), 1_000)
  }
  frame.srcdoc = printableAuditHtml(findings)
  document.body.append(frame)
}

/** Render enabled scenario operations once, above the selected presentation. */
export function CapabilityPanel(props: ViewProps) {
  const { state, t } = props
  const [outcome, setOutcome] = useState<Outcome>(null)
  const formats: readonly VisibleExportFormat[] = state.presentationHints?.capabilities?.exporting?.enabled === false ? [] : ['csv', 'html', 'pdf']

  useEffect(() => {
    if (outcome === null) return
    const timer = window.setTimeout(() => setOutcome(null), 2_500)
    return () => window.clearTimeout(timer)
  }, [outcome])

  const exportData = async (format: VisibleExportFormat): Promise<void> => {
    try {
      if (format === 'pdf') {
        const replacements = scenarioMetadataOf(state).replacements ?? {}
        printPDF(state.findings.map((finding) => {
          const edited = replacements[finding.id]
          return edited === undefined ? finding : { ...finding, replacement: edited }
        }))
        return
      }
      const result = await props.onExportData(state.round, format)
      if (!result.ok) return setOutcome({ tone: 'error', text: result.error.message })
      download(result)
      setOutcome({ tone: 'success', text: t('operation.exported') })
    } catch {
      setOutcome({ tone: 'error', text: t('operation.failed') })
    }
  }

  return <section aria-label={t('capability.title')} className={css.panel}>
    <div className={css.toolbar}>
      {formats.length > 0 && <div className={css.toolbarExports}>
        {formats.map(format => <button key={format} type="button" className={css.exportButton} onClick={() => void exportData(format)}>{t('capability.export')} {format.toUpperCase()}</button>)}
      </div>}
      {outcome !== null && <span role="status" className={outcome.tone === 'error' ? css.error : css.success}>{outcome.text}</span>}
    </div>
  </section>
}
