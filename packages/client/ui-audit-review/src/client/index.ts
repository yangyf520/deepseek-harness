/**
 * Client plugin: audit review cards and sidebar panel.
 * @module @deepseek-ai/dsh-client-ui-audit-review/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-audit-review/types'
import type { AuditDecision, AuditExportResult } from '@deepseek-ai/dsh-audit-review/types'
import auditReviewRemote from '@deepseek-ai/dsh-audit-review/remote'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import { AuditTurnTail } from './AuditCard.tsx'
import { ReviewPanel } from './ReviewPanel.tsx'
import { en, zh, type AuditKey } from './locales.ts'

export type { AuditKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Audit review card and panel copy. */
    audit: AuditKey
  }
}

/** Dictionary namespace. */
const NS = 'audit'

/** Sidebar tab ID. */
const AUDIT_REVIEW_ID = '@deepseek-ai/dsh-client-ui-audit-review'

/** Services required. The audit Remote is absent here: this plugin mounts its own contribution before registering. */
export const inject = ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

/**
 * Read one workspace file as bytes through the authenticated Remote. The review panel and the
 * overview card share it, so a download always serves the file's current content.
 * @param ctx - client root context carrying the Remote.
 * @param sessionId - session whose workspace holds the file.
 * @param path - workspace-relative or absolute file path.
 * @returns the file bytes.
 */
async function readWorkspaceBytes(ctx: ClientContext, sessionId: SessionId, path: string): Promise<Uint8Array<ArrayBuffer>> {
  const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {})
  if (!result.ok) throw new Error(result.error.message)
  return result.value.data
}

/**
 * Register the audit review cards and sidebar panel.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // This surface owns its Remote contribution: a deployment that installs the
  // plugin outside the shipped roster has no shipped row mounting it, and the
  // mount must precede the registrations below so `remote.auditReview` exists
  // when a card first calls it.
  await ctx.remote.$mount(auditReviewRemote)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-audit-review: dictionaries')
  const t = ctx.locale.bind(NS)

  // Register turn-tail card
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: AUDIT_REVIEW_ID,
    locale: NS,
    inject: (_sessionId: SessionId) => ({
      openSidebar: (address: string) => ctx.sidebarRight.openResource(address),
      readFileBytes: (sid: SessionId, path: string) => readWorkspaceBytes(ctx, sid, path),
      // Unwrap the Remote envelope so the card handles one result type: a transport failure maps
      // onto the same { ok: false, error } the export itself returns.
      exportDocument: async (sid: SessionId, round: number): Promise<AuditExportResult> => {
        const result = await ctx.remote.auditReview.exportDocument({ sessionId: sid, round })
        return result.ok ? result.value : { ok: false, error: result.error }
      },
    }),
  }, AuditTurnTail))

  // Register sidebar tab for audit review panel
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: AUDIT_REVIEW_ID,
    kind: 'audit-review',
    priority: 'extension',
    patterns: ['dsh-resource://audit/**'],
    title: () => t('tab.title'),
  }), 'ui-audit-review: sidebar tab type')

  // Register sidebar tab body
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: AUDIT_REVIEW_ID,
    locale: NS,
    inject: (sessionId: SessionId) => ({
      readFileBytes: (sid: SessionId, path: string) => readWorkspaceBytes(ctx, sid, path),
      onDecide: async (findingId: string, round: number, decision: AuditDecision) => {
        try {
          await ctx.remote.auditReview.decide({ sessionId, round, findingId, decision })
        } catch (err) {
          console.error('audit decide failed:', err)
        }
      },
      onApply: async (findingId: string, round: number) => {
        try {
          const result = await ctx.remote.auditReview.apply({ sessionId, round, findingId })
          if (!result.ok) console.error('audit apply failed:', result.error.message)
        } catch (err) {
          console.error('audit apply failed:', err)
        }
      },
    }),
  }, ReviewPanel))
}
