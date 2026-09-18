/** Complete Word document rendered as HTML in a sandboxed iframe via mammoth. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { convertToHtml } from 'mammoth'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type {} from './locales.ts'
import css from '../html/HtmlBody.module.css'

/** Standard document inputs plus this renderer's dictionary. */
export type DocxBodyProps = DocumentPreviewProps & PropsLocale<'documentDocx'>

/** Wrap raw HTML in a minimal document so the iframe renders standalone. */
function wrapHtmlDocument(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,-apple-system,sans-serif;margin:1em;color:#1a1a1a;line-height:1.6}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}
img{max-width:100%}
</style></head><body>${body}</body></html>`
}

/**
 * Collapse the cover-page title some Word documents repeat as the first body
 * paragraph (textbox cover + body title linearize into adjacent equal blocks).
 */
function dropRepeatedLeadTitle(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const [lead, next] = [...parsed.body.children].filter(node => node.textContent?.trim() !== '')
  if (lead !== undefined && next !== undefined && lead.textContent?.trim() === next.textContent?.trim()) next.remove()
  return parsed.body.innerHTML
}

/**
 * Render a Word document by converting its bytes to HTML via mammoth and
 * displaying the result in a sandboxed iframe.
 * @param props - document bytes, resource identity, and locale.
 * @returns an isolated HTML preview, or a status message for non-byte delivery.
 */
export function DocxBody({ content, t }: DocxBodyProps): ReactNode {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const bytes = content.kind === 'bytes' ? content.data : undefined

  useEffect(() => {
    setUrl(undefined)
    setFailed(false)
    if (bytes === undefined) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    void (async () => {
      try {
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const result = await convertToHtml({ arrayBuffer })
        controller.signal.throwIfAborted()
        objectUrl = URL.createObjectURL(new Blob([wrapHtmlDocument(dropRepeatedLeadTitle(result.value))], { type: 'text/html' }))
        setUrl(objectUrl)
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      }
    })()
    return () => {
      controller.abort()
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [bytes])

  if (bytes === undefined) return null
  if (failed) return <p className={css.status} role="alert">{t('failed')}</p>
  if (url === undefined) return <LoadingIndicator className={css.status} label={t('loading')} />
  return <iframe className={css.frame} src={url} sandbox="allow-scripts" title={t('frame')} />
}
