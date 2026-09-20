/**
 * Audit-review plugin: projection, remote service, and tool for the
 * document audit workflow. The agent calls `audit_write` to record findings;
 * the user decides accept/reject via the remote; the projection folds events.
 * @module @deepseek-ai/dsh-audit-review
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  AuditState,
  AuditDecideRequest,
  AuditDecideResult,
  AuditApplyRequest,
  AuditApplyResult,
} from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'audit-review'

const emptyState: AuditState = { round: 0, documentPath: '', findings: [], decisions: {} }

const auditStateSchema = z.object({
  round: z.number().int().nonnegative(),
  documentPath: z.string(),
  findings: z.array(z.object({
    id: z.string(),
    anchor: z.object({ path: z.string(), line: z.number().int(), quote: z.string() }),
    issue: z.string(),
    replacement: z.string(),
  })),
  decisions: z.record(z.string(), z.enum(['accept', 'reject'])),
})

/** Pure fold: session events → audit state. */
function foldAudit(state: AuditState, event: SessionEvent): AuditState {
  switch (event.type) {
    case 'audit/write':
      return { round: event.data.round, documentPath: event.data.documentPath, findings: [...event.data.findings], decisions: {} }
    case 'audit/decide':
      if (event.data.round !== state.round) return state
      if (state.decisions[event.data.findingId] !== undefined) return state
      return { ...state, decisions: { ...state.decisions, [event.data.findingId]: event.data.decision } }
    default:
      return state
  }
}

/** Register the audit projection. */
function registerProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'audit',
    stateSchema: auditStateSchema as z.ZodType<AuditState>,
    init: (): AuditState => ({ ...emptyState }),
    apply: foldAudit,
    wire: {
      viewSchema: auditStateSchema as z.ZodType<AuditState>,
      view: (state: AuditState) => state,
    },
    stateVersion: 1,
  })
}

/** The audit_write tool definition. */
const auditWriteTool = defineTool({
  name: 'audit_write',
  description: 'Record audit findings after analyzing a document. MUST be called when the user asks to audit/review a document. Each finding cites a specific location with a quoted anchor and a replacement suggestion. NEVER output findings as plain text - always use this tool.',
  parameters: {
    round: { type: 'integer', required: true, description: 'Audit round number (increment for each new pass).' },
    documentPath: { type: 'string', required: true, description: 'Path to the original document being audited (the file the user uploaded or specified).' },
    findings: {
      type: 'array',
      required: true,
      description: 'List of findings.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: 'Unique finding identifier within this round.' },
          anchor: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              path: { type: 'string', required: true, description: 'File path relative to workspace.' },
              line: { type: 'integer', required: true, description: 'Line number of the issue.' },
              quote: { type: 'string', required: true, description: 'Exact quoted text from the document.' },
            },
          },
          issue: { type: 'string', required: true, description: 'Description of the problem.' },
          replacement: { type: 'string', required: true, description: 'Suggested replacement text.' },
        },
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        round: { type: 'integer', required: true },
        findingCount: { type: 'integer', required: true },
      },
    },
    render: (_args, value) => [{
      type: 'text' as const,
      text: `Audit round ${value.round}: ${value.findingCount} finding(s) recorded.`,
    }],
  },
  async execute(args, exec) {
    const session = exec.agent?.session
    if (session === undefined) throw new Error('audit_write: no active session')
    session.append('audit/write', { round: args.round, documentPath: args.documentPath as string, findings: args.findings as AuditState['findings'] })
    return { round: args.round, findingCount: (args.findings as unknown[]).length }
  },
})

/** Remote service for user decisions on audit findings. */
export class AuditReviewService extends TypertRemoteService {
  static inject = ['sessions', 'sessionProjections', 'fs', 'tools', 'systemPrompt']

  constructor(ctx: Context) {
    super(ctx, 'auditReview')
  }

  protected [Service.init](): void {
    registerProjection(this.ctx)
    this.ctx.tools.register(auditWriteTool)
    this.ctx.systemPrompt.section({
      name: 'audit-review:guidance',
      order: 100,
      text: `When the user asks to audit or review a document:
1. Call \`audit_write\` to record all findings
2. After calling the tool, output ONLY:
   - A one-line summary: "审计完成，共 N 条发现，请查看审查卡片。"
   - A download link for the modified document (if applicable)
3. NEVER output findings as text, tables, or lists - the card displays them
4. NEVER explain your analysis process or reasoning`,
    })
  }

  @Remote('decide')
  decide(request: AuditDecideRequest): Promise<AuditDecideResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return Promise.resolve({ ok: false, error: { code: 'session-not-found', message: `no live session '${request.sessionId}'` } })
    }
    const state = this.ctx.sessionProjections.stateOf(session, 'audit')
    if (state === undefined || state.round !== request.round) {
      return Promise.resolve({
        ok: false,
        error: { code: 'stale-round', message: `decision names round ${request.round} but the session's current audit round is ${state?.round ?? 'none'}` },
      })
    }
    if (!state.findings.some(f => f.id === request.findingId)) {
      return Promise.resolve({ ok: false, error: { code: 'finding-not-found', message: `round ${request.round} has no finding '${request.findingId}'` } })
    }
    if (state.decisions[request.findingId] === undefined) {
      session.append('audit/decide', { round: request.round, findingId: request.findingId, decision: request.decision })
    }
    return Promise.resolve({ ok: true })
  }

  @Remote('apply')
  async apply(request: AuditApplyRequest): Promise<AuditApplyResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return { ok: false, error: { code: 'session-not-found', message: `no live session '${request.sessionId}'` } }
    }
    const state = this.ctx.sessionProjections.stateOf(session, 'audit')
    if (state === undefined || state.round !== request.round) {
      return { ok: false, error: { code: 'stale-round', message: `apply names round ${request.round} but the session's current audit round is ${state?.round ?? 'none'}` } }
    }
    const finding = state.findings.find(f => f.id === request.findingId)
    if (finding === undefined) {
      return { ok: false, error: { code: 'finding-not-found', message: `round ${request.round} has no finding '${request.findingId}'` } }
    }
    const cwd = session.header.cwd
    const target = await this.ctx.fs.resolve(finding.anchor.path, { ...cwd !== undefined ? { cwd } : {} })
    let content: string
    try {
      content = await this.ctx.fs.readText(target)
    } catch {
      return { ok: false, error: { code: 'not-text', message: `"${finding.anchor.path}" is not readable as UTF-8 text` } }
    }
    if (!content.includes(finding.anchor.quote)) {
      return { ok: false, error: { code: 'anchor-not-found', message: `anchor quote not found in "${finding.anchor.path}"` } }
    }
    const updated = content.replace(finding.anchor.quote, finding.replacement)
    await this.ctx.fs.writeText(target, updated)
    return { ok: true }
  }
}

export default AuditReviewService
