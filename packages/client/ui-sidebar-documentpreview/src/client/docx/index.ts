/** Builtin Word metadata and keyed body registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import { DocxBody } from './DocxBody.tsx'
import { en, zh } from './locales.ts'

/** Word implementation identity, shared by metadata and the keyed slot. */
const DOCX_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/docx'

/**
 * Register the Word dictionary, metadata and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('documentDocx', { zh, en }))
  const t = ctx.locale.bind('documentDocx')
  ctx.effect(() => ctx.documentPreviews.register({
    id: DOCX_BODY_ID,
    extensions: ['docx'],
    priority: 'builtin',
    title: () => t('title'),
    loading: 'bytes-complete',
    wrap: false,
  }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: DOCX_BODY_ID, locale: 'documentDocx' }, DocxBody,
  )))
}
