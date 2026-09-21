/**
 * Audit-review plugin: projection, remote service, and tool for the
 * document audit workflow. The agent calls `audit_write` to record findings;
 * the user decides accept/reject/undo via the remote; the projection folds events.
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
  AuditFinding,
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
    title: z.string().optional(),
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
    case 'audit/decide': {
      if (event.data.round !== state.round) return state
      const { findingId, decision } = event.data
      // The latest decision wins, so a user who changes their mind can undo one.
      const decisions = Object.fromEntries(Object.entries(state.decisions).filter(([id]) => id !== findingId))
      if (decision !== 'undo') decisions[findingId] = decision
      return { ...state, decisions }
    }
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

/**
 * Every index at which `quote` occurs in `content`; an empty quote yields none.
 * @param content - File text searched for the quote.
 * @param quote - Quoted span to locate.
 * @returns each matching character index, in file order.
 */
function occurrences(content: string, quote: string): number[] {
  if (quote === '') return []
  const found: number[] = []
  for (let at = content.indexOf(quote); at !== -1; at = content.indexOf(quote, at + quote.length)) found.push(at)
  return found
}

/**
 * 1-based line number holding the character at `index`.
 * @param content - File text owning the index.
 * @param index - Character index to locate.
 * @returns the 1-based line number.
 */
function lineAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

/**
 * Resolve a finding's quote to its span in `content`, disambiguating a repeated quote by the
 * anchor's line number.
 * @param content - File text searched for the quote.
 * @param finding - Finding whose anchor names the quote.
 * @returns the resolved span, or the error the caller reports instead of writing.
 */
function locateQuote(content: string, finding: AuditFinding):
  { ok: true; start: number; end: number } | { ok: false; code: string; message: string } {
  const quote = finding.anchor.quote
  const matches = occurrences(content, quote)
  const first = matches[0]
  if (first === undefined) {
    return { ok: false, code: 'anchor-not-found', message: `anchor quote not found in "${finding.anchor.path}"` }
  }
  const start = matches.length === 1 ? first : matches.find(at => lineAt(content, at) === finding.anchor.line)
  if (start === undefined) {
    return {
      ok: false,
      code: 'anchor-ambiguous',
      message: `anchor quote appears ${matches.length} times in "${finding.anchor.path}" and none sits on line ${finding.anchor.line}`,
    }
  }
  return { ok: true, start, end: start + quote.length }
}

/**
 * Render the file text the accepted findings ask for from the content captured before the round's
 * first apply. Edits are resolved against that base and written right to left, so each one keeps
 * the offsets the base gave it; an empty replacement whose line holds nothing else removes that
 * line. Rendering from the base makes an undo exact whatever order findings were decided in.
 * @param base - File text before the round's first apply.
 * @param findings - Accepted findings anchored in this file, in any order.
 * @returns the rendered text, or the error to report when an anchor cannot be placed.
 */
function renderAccepted(base: string, findings: readonly AuditFinding[]):
  { ok: true; text: string } | { ok: false; code: string; message: string } {
  const edits: { start: number; end: number; text: string }[] = []
  for (const finding of findings) {
    const span = locateQuote(base, finding)
    if (!span.ok) return span
    const lineStart = base.lastIndexOf('\n', span.start - 1) + 1
    const lineEnd = base.indexOf('\n', span.end)
    const tail = lineEnd === -1 ? base.slice(span.end) : base.slice(span.end, lineEnd)
    const removesLine = finding.replacement === '' && base.slice(lineStart, span.start).trim() === '' && tail.trim() === ''
    edits.push(removesLine
      ? { start: lineStart, end: lineEnd === -1 ? base.length : lineEnd + 1, text: '' }
      : { start: span.start, end: span.end, text: finding.replacement })
  }
  edits.sort((left, right) => right.start - left.start)
  let text = base
  let boundary = base.length
  for (const edit of edits) {
    if (edit.end > boundary) {
      return { ok: false, code: 'anchor-overlap', message: 'two accepted findings cover the same text; undo one of them first' }
    }
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    boundary = edit.start
  }
  return { ok: true, text }
}

/**
 * Reject findings whose anchors cannot be located verbatim in the audited file,
 * so a recorded quote always pins the line review and apply then act on.
 * @param ctx - Host context carrying the filesystem service.
 * @param cwd - Session working directory resolving `anchor.path`.
 * @param findings - Findings about to be recorded.
 * @returns one message per unusable anchor; empty when every anchor matches.
 */
async function anchorProblems(ctx: Context, cwd: string | undefined, findings: readonly AuditFinding[]): Promise<string[]> {
  const problems: string[] = []
  const contents = new Map<string, string>()
  for (const finding of findings) {
    let content = contents.get(finding.anchor.path)
    if (content === undefined) {
      try {
        content = await ctx.fs.readText(await ctx.fs.resolve(finding.anchor.path, { ...cwd !== undefined ? { cwd } : {} }))
        contents.set(finding.anchor.path, content)
      } catch {
        problems.push(`${finding.id}: "${finding.anchor.path}" is not readable as UTF-8 text; audit the extracted text file (work/<name>.txt)`)
        continue
      }
    }
    const quote = finding.anchor.quote
    if (quote === '') {
      problems.push(`${finding.id}: anchor.quote is empty`)
      continue
    }
    const matches = occurrences(content, quote)
    const first = matches[0]
    if (first === undefined) {
      problems.push(`${finding.id}: anchor.quote does not appear verbatim in "${finding.anchor.path}"`)
      continue
    }
    if (matches.length > 1) {
      problems.push(`${finding.id}: anchor.quote appears ${matches.length} times in "${finding.anchor.path}"; extend it with surrounding words so it is unique`)
      continue
    }
    const line = lineAt(content, first)
    if (line !== finding.anchor.line) {
      problems.push(`${finding.id}: anchor.quote sits on line ${line} (1-based), not line ${finding.anchor.line}`)
    }
  }
  return problems
}

/** The audit_write tool definition. */
const auditWriteToolDescription = 'Record audit findings after analyzing a document. MUST be called when the user asks to audit/review a document. Each finding cites a specific location with a quoted anchor and a replacement suggestion. NEVER output findings as plain text - always use this tool. Every anchor is validated against the audited file: a quote that is missing, ambiguous, or on a different line rejects the whole call, so fix the anchor and call again. For more than 3 findings write work/findings.json with Python json.dump and pass findingsFile instead of hand-writing the inline array: long inline arrays drop required fields and waste retries.'

/**
 * Problems in one parsed findings file, element by element: file content skips the tool schema's
 * argument validation, so the same required fields are checked here.
 * @param value - Parsed JSON the findings file held.
 * @returns one message per unusable element; empty when the array is usable.
 */
function fileFindingProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ['findingsFile must hold a JSON array of finding objects']
  const problems: string[] = []
  value.forEach((record, index) => {
    const at = `findings[${index}]`
    if (typeof record !== 'object' || record === null) {
      problems.push(`${at} is not an object`)
      return
    }
    const entries = record as Record<string, unknown>
    for (const field of ['id', 'issue', 'replacement'] as const) {
      if (typeof entries[field] !== 'string' || entries[field] === '') problems.push(`${at}.${field} is missing or empty`)
    }
    if (entries.title !== undefined && typeof entries.title !== 'string') problems.push(`${at}.title is not a string`)
    const anchor = entries.anchor
    if (typeof anchor !== 'object' || anchor === null) {
      problems.push(`${at}.anchor is missing`)
      return
    }
    const anchorEntries = anchor as Record<string, unknown>
    for (const field of ['path', 'quote'] as const) {
      if (typeof anchorEntries[field] !== 'string' || anchorEntries[field] === '') problems.push(`${at}.anchor.${field} is missing or empty`)
    }
    if (!Number.isInteger(anchorEntries.line)) problems.push(`${at}.anchor.line is missing or not an integer`)
  })
  return problems
}

/**
 * Findings from the inline array or the JSON file named by `findingsFile`; the file wins because a
 * Python-written array is the reliable shape for large rounds.
 * @param ctx - Host context carrying the filesystem service.
 * @param cwd - Session working directory resolving `findingsFile`.
 * @param args - Tool arguments naming one of the two findings sources.
 * @returns the findings to record, or throws the message naming what to fix.
 */
async function resolveFindings(
  ctx: Context,
  cwd: string | undefined,
  args: { findings?: unknown; findingsFile?: unknown },
): Promise<AuditFinding[]> {
  const file = args.findingsFile
  if (typeof file === 'string' && file !== '') {
    let raw: string
    try {
      raw = await ctx.fs.readText(await ctx.fs.resolve(file, { ...cwd !== undefined ? { cwd } : {} }))
    } catch {
      throw new Error(`audit_write: findingsFile "${file}" is not readable as UTF-8 text`)
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw new Error(`audit_write: findingsFile "${file}" is not valid JSON: ${String(error)}`)
    }
    const problems = fileFindingProblems(value)
    if (problems.length > 0) {
      throw new Error(`audit_write: fix these in the findings file and call again:\n${problems.join('\n')}`)
    }
    return value as AuditFinding[]
  }
  if (Array.isArray(args.findings)) return args.findings as AuditFinding[]
  throw new Error('audit_write: provide findings inline or as findingsFile')
}

/**
 * The audit_write tool; validation rejects unusable anchors before they are logged.
 * @param ctx - Host context carrying the filesystem service.
 * @returns the registered tool definition.
 */
function createAuditWriteTool(ctx: Context) {
  return defineTool({
    name: 'audit_write',
    description: auditWriteToolDescription,
    parameters: {
      round: { type: 'integer', required: true, description: 'Audit round number (increment for each new pass).' },
      documentPath: { type: 'string', required: true, description: 'Path to the original document being audited (the file the user uploaded or specified).' },
      findings: {
        type: 'array',
        description: 'Inline findings; reliable up to 3. For more, write work/findings.json with Python json.dump and pass findingsFile instead. Ignored when findingsFile is set.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Unique finding identifier within this round.' },
            title: { type: 'string', description: 'Recommended: max 20 Chinese characters. One plain-language sentence summarizing WHAT IS WRONG. Use everyday language. GOOD: "登录流程跟设计稿对不上" (11 chars). BAD: "P0 凭据转交交互与原型冲突" (too technical) or anything over 20 characters. When omitted the card falls back to the issue text.' },
            anchor: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                path: { type: 'string', required: true, description: 'Path of the audited text file relative to the workspace - the file the quote is copied from (e.g. work/<name>.txt), NOT the original document.' },
                line: { type: 'integer', required: true, description: 'Line number (1-based) in the text file that contains the quote. It MUST be the line where the quote actually sits.' },
                quote: { type: 'string', required: true, description: 'Text copied verbatim from that line, never paraphrased or re-wrapped. It MUST appear exactly once in the file: extend it with surrounding words when a short quote repeats. The call is rejected otherwise.' },
              },
            },
            issue: { type: 'string', required: true, description: 'Description of the problem. MUST start with the level tag [高风险], [中风险] or [低风险]; the card color and ordering read that tag.' },
            replacement: { type: 'string', required: true, description: 'Text that replaces exactly the quoted span; it must read as correct document prose after the swap. For a whole-line deletion set it to the empty string (the line is removed). NEVER put instructions, parentheses, or notes such as （删除该行） here. MUST be inside each finding object, NOT at the top level.' },
          },
        },
      },
      findingsFile: {
        type: 'string',
        description: 'Path to a JSON file holding the findings array, preferred for more than 3 findings; the file is validated like the inline array and wins when both are given.',
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
      const findings = await resolveFindings(ctx, session.header.cwd, args)
      const problems = await anchorProblems(ctx, session.header.cwd, findings)
      if (problems.length > 0) {
        throw new Error(`audit_write: every anchor must match the audited file; fix these and call again:\n${problems.join('\n')}`)
      }
      session.append('audit/write', { round: args.round, documentPath: args.documentPath, findings })
      return { round: args.round, findingCount: findings.length }
    },
  })
}

/** Content each audited file held before its round's first apply, keyed by session and path, so a
 * later apply or undo re-renders from the same base instead of from edited text. */
const applyBases = new Map<string, { round: number; base: string }>()

/** Remote service for user decisions on audit findings. */
export class AuditReviewService extends TypertRemoteService {
  static inject = ['sessions', 'sessionProjections', 'fs', 'tools', 'systemPrompt']

  constructor(ctx: Context) {
    super(ctx, 'auditReview')
  }

  protected [Service.init](): void {
    registerProjection(this.ctx)
    this.ctx.tools.register(createAuditWriteTool(this.ctx))
    this.ctx.systemPrompt.section({
      name: 'audit-review:guidance',
      order: 100,
      text: `When the user asks to audit or review a document:

## Step 1: Generate HTML preview and text extraction
Before auditing, convert the document to HTML for preview and plain text for quoting:
1. Use python-docx (via \`load_workspace_dependencies\`) to read the document; when writing the converter, guard every optional attribute: \`paragraph.style\` and \`paragraph.alignment\` are \`None\` for paragraphs without explicit formatting, so read them as \`p.style.name if p.style is not None else ''\` — an unguarded \`block.style.name\` crashes the whole conversion
2. Generate an HTML file preserving structure (paragraphs, tables, headings, lists)
   - Save as \`work/<name>.html\` (same base name as the text file)
3. Extract plain text from the HTML (strip tags, preserve line breaks)
   - Save as \`work/<name>.txt\`
4. The HTML file enables formatted preview; the text file is the audit source

## Step 2: Audit the document
1. Read the plain text file (\`work/<name>.txt\`) for analysis
2. Call \`audit_write\` to record all findings
   - With 3 or fewer findings pass them inline; with more, build the array in Python and \`json.dump\` it to \`work/findings.json\`, then pass \`findingsFile\` — hand-written long inline arrays drop required fields and every drop rejects the whole call
   - \`anchor.path\` MUST point to the text file (\`work/<name>.txt\`)
   - \`anchor.line\` MUST be the 1-based line that contains the quote
   - \`anchor.quote\` MUST be copied verbatim and appear exactly once in the file; extend it with surrounding words when a short quote repeats
   - \`issue\` MUST start with [高风险], [中风险] or [低风险]
   - \`replacement\` MUST replace exactly the quoted span and read as correct prose afterwards; set it to the empty string to delete the whole line, never to instructions or notes
   - \`documentPath\` is the original document path
3. After calling the tool, output ONLY:
   - A one-line summary: "审计完成，共 N 条发现，请查看审查卡片。"
   - A download link for the modified document (if applicable)
4. NEVER output findings as text, tables, or lists - the card displays them
5. NEVER explain your analysis process or reasoning

## Important
- The HTML file (\`work/<name>.html\`) and text file (\`work/<name>.txt\`) MUST have the same base name
- The review panel renders the HTML file for formatted preview with highlight linkage
- \`audit_write\` validates every anchor against the file and rejects the call when a quote is missing, ambiguous, or sits on a different line
- Applying a finding replaces its quote in the text file; an empty replacement deletes the quoted line`,
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
    session.append('audit/decide', { round: request.round, findingId: request.findingId, decision: request.decision })
    return Promise.resolve({ ok: true })
  }

  /**
   * Rewrite the audited file so it holds exactly the round's accepted findings. Every decision goes
   * through here — accepting adds an edit, undoing removes it — so an undo restores the text the
   * remaining decisions ask for instead of appending a second edit.
   * @param request - session, round, and the finding whose decision just changed.
   * @returns the sync outcome; a failure carries the code and message the client logs.
   */
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
    const key = `${request.sessionId}\u0000${finding.anchor.path}`
    const recorded = applyBases.get(key)
    let base: string
    if (recorded !== undefined && recorded.round === request.round) {
      base = recorded.base
    } else {
      try {
        base = await this.ctx.fs.readText(target)
      } catch {
        return { ok: false, error: { code: 'not-text', message: `"${finding.anchor.path}" is not readable as UTF-8 text` } }
      }
      applyBases.set(key, { round: request.round, base })
    }
    const accepted = state.findings.filter(f => f.anchor.path === finding.anchor.path && state.decisions[f.id] === 'accept')
    const rendered = renderAccepted(base, accepted)
    if (!rendered.ok) return { ok: false, error: { code: rendered.code, message: rendered.message } }
    await this.ctx.fs.writeText(target, rendered.text)
    return { ok: true }
  }
}

export default AuditReviewService
