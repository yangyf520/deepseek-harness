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
import type {} from '@deepseek-ai/dsh-audit-review/remote'
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

/** Services required. */
export const inject = ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']

/**
 * Register the audit review cards and sidebar panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-audit-review: dictionaries')

  // Register turn-tail card
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: AUDIT_REVIEW_ID,
    locale: NS,
    inject: (_sessionId: SessionId) => ({
      openSidebar: (address: string) => {
        ctx.sidebarRight?.openResource?.(address)
      },
    }),
  }, AuditTurnTail))

  // Register sidebar tab for audit review panel
  ctx.effect(() => ctx.sidebarRightTabs?.register({
    id: AUDIT_REVIEW_ID,
    kind: 'audit-review',
    priority: 'extension',
    patterns: ['dsh-resource://audit/**'],
    title: () => '审计审查',
  }), 'ui-audit-review: sidebar tab type')

  // Register sidebar tab body
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: AUDIT_REVIEW_ID,
    locale: NS,
    inject: (sessionId: SessionId) => ({
      readFileBytes: async (sid: SessionId, path: string) => {
        const result = await ctx.remote.workspaceFiles.readAll(sid, path)
        if (!result.ok) throw new Error(result.error)
        const binary = atob(result.value.data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return bytes
      },
      onDecide: async (findingId: string, round: number, decision: 'accept' | 'reject') => {
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
