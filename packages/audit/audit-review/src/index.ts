/**
 * Audit-review plugin: projection, remote service, and tool for the
 * document audit workflow. The agent calls `audit_write` to record findings;
 * the user decides accept/reject/undo via the remote; the projection folds events.
 * @module @deepseek-ai/dsh-audit-review
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { basename } from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  AuditState,
  AuditFinding,
  AuditMetadataValue,
  AuditFailure,
  AuditDecideRequest,
  AuditDecideResult,
  AuditApplyRequest,
  AuditApplyResult,
  AuditExportRequest,
  AuditExportResult,
  AuditGroupRequest,
  AuditGroupResult,
  AuditRateRequest,
  AuditRateResult,
  AuditCommentRequest,
  AuditCommentResult,
  AuditTagRequest,
  AuditTagResult,
  AuditExportDataRequest,
  AuditExportDataResult,
  AuditTrackRequest,
  AuditTrackResult,
} from './types.ts'

import { registerProjection } from './projection.ts'
import { occurrences, lineAt, renderAccepted } from './text-edits.ts'
import { convertScript, exportScript } from './document-scripts.ts'
import { extractField } from './extraction.ts'
import { presentationHintsSchema, resolvePresentationHints } from './scenario.ts'

function metadataRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Escape model- and user-authored text before embedding it in an HTML export. */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'audit-review'

/**
 * Resolve findings whose anchors must be located verbatim in the audited file. A unique quote
 * fixes the span, so the line the caller reported is replaced by the one the quote occupies:
 * review and apply act on the same text either way, and a hand-counted line never rejects the
 * round. Only a quote that is missing or ambiguous makes the round unusable.
 * @param ctx - Host context carrying the filesystem service.
 * @param cwd - Session working directory resolving `anchor.path`.
 * @param findings - Findings about to be recorded.
 * @returns the findings carrying quote-pinned lines, and one message per unusable anchor; the
 * findings are complete only when there are no problems.
 */
async function resolveAnchors(ctx: Context, cwd: string | undefined, findings: readonly AuditFinding[]):
Promise<{ problems: string[]; findings: AuditFinding[] }> {
  const problems: string[] = []
  const pinned: AuditFinding[] = []
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
    pinned.push(line === finding.anchor.line ? finding : { ...finding, anchor: { ...finding.anchor, line } })
  }
  return { problems, findings: pinned }
}

/** The audit_write tool definition. */
const auditWriteToolDescription = 'Record structured findings after analyzing a document against criteria. Use when the user asks to audit, review, compare, or analyze a document. Each finding cites a specific location with a quoted anchor and an optional suggested fix. NEVER output findings as plain text - always use this tool. Every anchor is validated against the audited file: a quote that is missing or ambiguous rejects the whole call, so fix the anchor and call again. For more than 3 findings write a temporary JSON file named after the document (e.g. /tmp/findings-<name>.json) with Python json.dump and pass findingsFile instead of hand-writing the inline array: long inline arrays drop required fields and waste retries, and a reused generic name collides with leftovers from an earlier session and trips the read-before-write guard.'

/**
 * Quote one shell word with single quotes; the script and paths carry no restrictions then.
 * @param value - Raw word to embed in a POSIX command line.
 * @returns the quoted word.
 */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The audit_convert_document tool: one call replaces the write-converter/run/read chain the
 * guidance used to teach, so naming collisions, retyped quotes, and attribute guards stop being
 * per-session model work.
 * @param ctx - Host context carrying the filesystem, shell, and sandbox-policy services.
 * @returns the registered tool definition.
 */
function createAuditConvertTool(ctx: Context) {
  return defineTool({
    name: 'audit_convert_document',
    description: 'Convert a .docx document into the audit workspace files in one call: work/<name>.html (formatted preview the review panel renders), work/<name>.txt (plain text, the audit anchor source), and work/<name>.docx (a workspace-local copy of the original for preview and export). MUST be used instead of writing a converter; write your own python-docx converter under /tmp only when this tool fails.',
    parameters: {
      documentPath: { type: 'string', required: true, description: 'Path of the original document to convert (the file the user uploaded or specified).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          htmlPath: { type: 'string', required: true },
          textPath: { type: 'string', required: true },
          textLines: { type: 'integer', required: true },
          docxPath: { type: 'string', required: true, description: 'Workspace-relative path to the copied original .docx; use this as documentPath in audit_write so the review panel and export stay inside the tenant scope.' },
        },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: `Converted to ${value.htmlPath}, ${value.textPath}, and ${value.docxPath} (${value.textLines} lines).`,
      }],
    },
    async execute(args: { documentPath: string }, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('audit_convert_document: no active session')
      const cwd = session.header.cwd
      if (cwd === undefined) throw new Error('audit_convert_document: the session has no working directory')
      const src = await ctx.fs.resolve(args.documentPath, { cwd })
      const base = basename(src.displayPath).replace(/\.docx$/i, '')
      const htmlPath = `work/${base}.html`
      const textPath = `work/${base}.txt`
      const docxPath = `work/${base}.docx`
      const command = `python3 -c ${shellWord(convertScript)} -- ${shellWord(src.displayPath)} ${shellWord(htmlPath)} ${shellWord(textPath)} && cp ${shellWord(src.displayPath)} ${shellWord(docxPath)}`
      const execution = await ctx.shell.execute(ctx.shell.resolve({
        command,
        workdir: cwd,
        timeoutMs: 120_000,
        stdoutMaxBytes: 4096,
        sandboxPolicy: ctx.sandboxPolicy.resolve({ session, mode: 'danger-full-access' }),
        signal: exec.signal,
      }))
      const result = await execution.result()
      if (result.aborted) throw new Error('audit_convert_document: aborted')
      if (result.exitCode !== 0) {
        throw new Error(`audit_convert_document: python failed (exit ${result.exitCode ?? 'killed'}): ${result.stderr.text.slice(-400).trim()}`)
      }
      const textLines = Number(/LINES (\d+)/.exec(result.stdout.text)?.[1] ?? 0)
      return { htmlPath, textPath, textLines, docxPath }
    },
  })
}

/**
 * Problems in one parsed findings file, element by element: file content skips the tool schema's
 * argument validation, so the same required fields are checked here. An empty replacement stays
 * valid — it is the line-deletion form the tool description documents.
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
    for (const field of ['id', 'issue'] as const) {
      if (typeof entries[field] !== 'string' || entries[field] === '') problems.push(`${at}.${field} is missing or empty`)
    }
    if (entries.replacement !== undefined && typeof entries.replacement !== 'string') problems.push(`${at}.replacement is not a string`)
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

// ========== Generic Capability Tools (Phase 3) ==========

/**
 * Generic analysis tool: extract structured data from documents using extraction rules.
 */
function createAnalyzeTool(ctx: Context) {
  return defineTool({
    name: 'analyze_document',
    description: 'Analyze a document and extract structured information using extraction rules. Works for any scenario: resume extraction, contract clause identification, requirement analysis, etc.',
    parameters: {
      documentPath: { type: 'string', required: true, description: 'Path to the text file to analyze (e.g. work/<name>.txt).' },
      extractionRules: {
        type: 'array',
        required: true,
        description: 'Extraction rules. Each rule defines how to extract one field from the document.',
        items: { type: 'object', additionalProperties: false, properties: {
          field: { type: 'string', description: 'Field name.' },
          pattern: { type: 'string', description: 'Regex pattern.' },
          type: { type: 'string', enum: ['string', 'number', 'boolean'], description: 'Data type.' },
        } },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { extracted: { type: 'object', additionalProperties: true, required: true } } },
      render: (_args, value) => [{ type: 'text' as const, text: `Extracted ${Object.keys(value.extracted).length} field(s).` }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) throw new Error('analyze_document: no active session')
      const cwd = session.header.cwd
      if (!cwd) throw new Error('analyze_document: no working directory')
      const resolved = await ctx.fs.resolve(args.documentPath, { cwd })
      const text = await ctx.fs.readText(resolved)
      const extracted: Record<string, AuditMetadataValue> = {}
      for (const rule of args.extractionRules as Array<{ field: string; pattern?: string; type?: 'string' | 'number' | 'boolean' }>) {
        if (rule.pattern) {
          const match = text.match(new RegExp(rule.pattern))
          extracted[rule.field] = extractField(match?.[1] ?? match?.[0], rule.type ?? 'string')
        }
      }
      return { extracted }
    },
  })
}

/**
 * Generic grouping tool: group findings by any field or pattern.
 */
function createGroupTool(ctx: Context) {
  return defineTool({
    name: 'group_findings',
    description: 'Group audit findings by any field or pattern. Use after audit_write to organize findings for the UI.',
    parameters: {
      groupBy: { type: 'string', required: true, description: 'Field name to group by (e.g. candidate-name, section, requirement-id).' },
      pattern: { type: 'string', description: 'Optional regex to extract the grouping key from finding titles.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { groupCount: { type: 'integer', required: true }, groups: { type: 'object', additionalProperties: true, required: true } } },
      render: (args, value) => [{ type: 'text' as const, text: `Grouped into ${value.groupCount} group(s) by '${args.groupBy}'.` }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) throw new Error('group_findings: no active session')
      const state = ctx.sessionProjections.stateOf(session, 'audit') as AuditState
      if (state.round === 0) throw new Error('group_findings: no audit round recorded')
      const groups = new Map<string, string[]>()
      const regex = args.pattern ? new RegExp(args.pattern) : null
      for (const finding of state.findings) {
        let key: string = String(finding.metadata?.[args.groupBy] ?? '未分组')
        if (finding.metadata?.[args.groupBy] === undefined && regex) {
          const match = (finding.title ?? finding.issue).match(regex)
          key = match?.[1] ?? '未分组'
        }
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)?.push(finding.id)
      }
      const groupsObj = Object.fromEntries(groups)
      const existingMetadata = (state.scenarioMetadata ?? {}) as Record<string, unknown>
      session.append('scenario/update', { ...existingMetadata, grouping: { groupBy: args.groupBy, groups: groupsObj } })
      return { groupCount: groups.size, groups: groupsObj }
    },
  })
}

/**
 * Generic scenario configuration tool: configure which capabilities to enable.
 */
function createConfigureTool(ctx: Context) {
  return defineTool({
    name: 'configure_scenario',
    description: 'Configure an enterprise scenario by declaring which capabilities to enable (grouping, scoring, commenting, tagging, exporting, etc.).',
    parameters: {
      layout: { type: 'string', enum: ['split-panel', 'diff-view', 'matrix', 'grouped-list', 'timeline', 'custom'], description: 'Layout type.' },
      capabilities: {
        type: 'object', required: true, additionalProperties: false,
        description: 'Capability configuration. Enable/disable each capability.',
        properties: {
          grouping: { type: 'object', additionalProperties: true, description: '{enabled, groupBy, pattern}' },
          scoring: { type: 'object', additionalProperties: true, description: '{enabled, target, label, range}' },
          commenting: { type: 'object', additionalProperties: true, description: '{enabled}' },
          tagging: { type: 'object', additionalProperties: true, description: '{enabled, allowedTags}' },
          deciding: { type: 'object', additionalProperties: true, description: '{enabled, actions}' },
          exporting: { type: 'object', additionalProperties: true, description: '{enabled, formats}' },
          visualizing: { type: 'object', additionalProperties: true, description: '{enabled, type}' },
          comparing: { type: 'object', additionalProperties: true, description: '{enabled}' },
          tracking: { type: 'object', additionalProperties: true, description: '{enabled}' },
          collaboration: { type: 'object', additionalProperties: true, description: '{enabled}' },
        },
      },
      custom: { type: 'object', additionalProperties: true, description: 'Arbitrary scenario-specific configuration.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { configured: { type: 'boolean', required: true }, enabledCapabilities: { type: 'array', items: { type: 'string' }, required: true } } },
      render: (_args, value) => [{ type: 'text' as const, text: `Configured ${value.enabledCapabilities.length} capability(ies): ${value.enabledCapabilities.join(', ')}.` }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) throw new Error('configure_scenario: no active session')
      const state = ctx.sessionProjections.stateOf(session, 'audit') as AuditState
      const caps = args.capabilities as Record<string, { enabled?: boolean } | undefined>
      const hints = presentationHintsSchema.parse({
        ...state.presentationHints,
        ...(args.layout !== undefined ? { layout: args.layout } : {}),
        capabilities: caps,
        ...(args.custom !== undefined ? { custom: args.custom } : {}),
      })
      const enabled = Object.entries(caps).filter(([, v]) => v?.enabled).map(([k]) => k)
      session.append('scenario/update', { ...(state.scenarioMetadata ?? {}), presentationHints: hints as Record<string, import('@deepseek-ai/dsh-util-values').JsonValue> })
      return { configured: true, enabledCapabilities: enabled }
    },
  })
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
        description: 'Inline findings; reliable up to 3. For more, write a temporary JSON file named after the document (e.g. /tmp/findings-<name>.json) with Python json.dump and pass findingsFile instead. Ignored when findingsFile is set.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Unique finding identifier within this round.' },
            title: { type: 'string', description: 'Recommended: max 20 Chinese characters. One plain-language sentence summarizing the finding. Use everyday language. GOOD: "候选人具备7年Java开发经验" or "未实现用户注销功能". BAD: too technical or over 20 characters. When omitted the card falls back to the issue text.' },
            anchor: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                path: { type: 'string', required: true, description: 'Path of the audited text file relative to the workspace - the file the quote is copied from (e.g. work/<name>.txt), NOT the original document.' },
                line: { type: 'integer', required: true, description: 'Line number (1-based) in the text file that contains the quote.' },
                quote: { type: 'string', required: true, description: 'Text copied verbatim from that line, never paraphrased or re-wrapped. It MUST appear exactly once in the file: extend it with surrounding words when a short quote repeats. The call is rejected otherwise.' },
              },
            },
            issue: { type: 'string', required: true, description: 'Finding description. MUST start with the level tag [高], [中] or [低]; the card color and ordering read that tag. Severity is determined by how important this dimension is to the overall judgment. When there is a clear reference source, cite it at the end (e.g. 依据：《来源名》相关条目).' },
            replacement: { type: 'string', description: 'Optional suggested fix. For compliance audits, text that replaces exactly the quoted span; empty string deletes the line. For pure analysis (matching, comparison), omit this field. MUST be inside each finding object, NOT at the top level.' },
          },
        },
      },
      findingsFile: {
        type: 'string',
        description: 'Path to a JSON file holding the findings array, preferred for more than 3 findings; the file is validated like the inline array and wins when both are given.',
      },
      cardTitle: { type: 'string', description: 'Optional card title reflectinging the analysis scenario, set after reading the documents. Examples: "合规审查", "匹配结果", "对比发现", "合同风险". When omitted the card shows a generic title.' },
      summary: { type: 'string', description: 'Optional summary line shown next to the title. Examples: "21 条违规", "3 位候选人", "7 处差异". When omitted the card shows "N 条发现".' },
      severityLabels: {
        type: 'object',
        description: 'Optional scenario-specific labels for the three severity levels, displayed on severity badges. Set based on the analysis scenario. Examples: compliance → {high:"违规",medium:"风险",low:"建议"}; resume matching → {high:"缺失",medium:"部分",low:"满足"}; contract review → {high:"高危",medium:"中危",low:"低危"}. When omitted the UI falls back to "高"/"中"/"低".',
        additionalProperties: false,
        properties: {
          high: { type: 'string', required: true },
          medium: { type: 'string', required: true },
          low: { type: 'string', required: true },
        },
      },
      presentationHints: {
        type: 'object',
        description: 'Optional model-driven guidance for adaptive UI. Tell the UI how to display findings based on data characteristics. Layout options: split-panel (document + findings), diff-view (side-by-side comparison), matrix (grouped scoring), grouped-list (by category), timeline (chronological). Allowed actions: accept/reject/undo (for edits), comment (for discussion), score (for rating), shortlist (for selection), compare (for diff). Scoring: enable when findings include numerical assessments (e.g., match percentage). Visualization: severity-distribution, score-chart, heatmap, timeline, comparison-matrix. Export formats: modified-document, score-sheet, comparison-report, summary-pdf, findings-matrix.',
        additionalProperties: false,
        properties: {
          layout: { type: 'string', enum: ['split-panel', 'diff-view', 'matrix', 'grouped-list', 'timeline'], description: 'Recommended layout.' },
          allowedActions: { type: 'array', items: { type: 'string', enum: ['accept', 'reject', 'undo', 'comment', 'score', 'shortlist', 'compare'] }, description: 'User actions to enable.' },
          groupBy: { type: 'string', description: 'Field to group findings by (e.g., candidate-name, section).' },
          scoring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean', required: true },
              field: { type: 'string', required: true },
              label: { type: 'string', required: true },
              range: { type: 'array', items: { type: 'number' }, required: true, description: 'Score range as [min, max].' },
            },
            description: 'Scoring configuration.',
          },
          visualization: { type: 'string', enum: ['severity-distribution', 'score-chart', 'heatmap', 'timeline', 'comparison-matrix'], description: 'Recommended visualization.' },
          exportFormats: { type: 'array', items: { type: 'string', enum: ['modified-document', 'score-sheet', 'comparison-report', 'summary-pdf', 'findings-matrix'] }, description: 'Export format options.' },
          userGoals: { type: 'array', items: { type: 'string' }, description: 'User goals inferred from conversation.' },
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
      const findings = await resolveFindings(ctx, session.header.cwd, args)
      const anchor = await resolveAnchors(ctx, session.header.cwd, findings)
      if (anchor.problems.length > 0) {
        throw new Error(`audit_write: every anchor must match the audited file; fix these and call again:\n${anchor.problems.join('\n')}`)
      }
      session.append('audit/write', {
        round: args.round,
        documentPath: args.documentPath,
        findings: anchor.findings,
        ...args.cardTitle !== undefined ? { cardTitle: args.cardTitle } : {},
        ...args.summary !== undefined ? { summary: args.summary } : {},
        ...args.severityLabels !== undefined ? { severityLabels: args.severityLabels } : {},
        ...args.presentationHints !== undefined ? { presentationHints: args.presentationHints } : {},
      })
      return { round: args.round, findingCount: anchor.findings.length }
    },
  })
}


/**
 * The live session and the audit state at the request's round, or the failure the caller returns
 * instead of acting: every remote call addresses one round and reports the same two ways of
 * missing it.
 * @param ctx - Host context carrying the session store and projection registry.
 * @param request - session and round the remote call names.
 * @param operation - remote name the stale-round message reports.
 * @returns the session and state, or the failure to return.
 */
function auditRound(ctx: Context, request: { sessionId: SessionId; round: number }, operation: string):
{ ok: true; session: Session; state: AuditState } | { ok: false; error: AuditFailure } {
  const session = ctx.sessions.get(request.sessionId)
  if (session === undefined) {
    return { ok: false, error: { code: 'session-not-found', message: `no live session '${request.sessionId}'` } }
  }
  const state = ctx.sessionProjections.stateOf(session, 'audit')
  if (state === undefined || state.round !== request.round) {
    return {
      ok: false,
      error: {
        code: 'stale-round',
        message: `${operation} names round ${request.round} but the session's current audit round is ${state?.round ?? 'none'}`,
      },
    }
  }
  return { ok: true, session, state }
}

/** Remote service for user decisions on audit findings. */
export class AuditReviewService extends TypertRemoteService {
  private readonly applyBases = new Map<string, { round: number; base: string; version: FsVersion }>()
  static inject = ['sessions', 'sessionProjections', 'fs', 'tools', 'systemPrompt', 'sandboxPolicy', 'shell']

  constructor(ctx: Context) {
    super(ctx, 'auditReview')
  }

  protected [Service.init](): void {
    // This plugin ships outside the repository that generates the known-event
    // vocabulary, and the persistence read path refuses a stored event type
    // outside it — `append` cannot mark its events ignorable. Declare both
    // types here, before a Session carrying them can be loaded; `ReadonlySet`
    // is a compile-time view over the mutable runtime set.
    const knownEventTypes = KNOWN_SESSION_EVENT_TYPES as Set<string>
    knownEventTypes.add('audit/write')
    knownEventTypes.add('audit/decide')
    knownEventTypes.add('scenario/update')
    registerProjection(this.ctx)
    this.ctx.tools.register(createAuditWriteTool(this.ctx))
    this.ctx.tools.register(createAuditConvertTool(this.ctx))
    this.ctx.tools.register(createAnalyzeTool(this.ctx))
    this.ctx.tools.register(createGroupTool(this.ctx))
    this.ctx.tools.register(createConfigureTool(this.ctx))
    this.ctx.systemPrompt.section({
      name: 'audit-review:guidance',
      order: 100,
      text: `When the user uploads a document without saying what to do with it, identify the document's role from its name and content, then ask with \`ask_user_question\` — recommend the most likely intent:
- Reference/criteria documents (regulations, standards, JDs, requirements — meant to evaluate other things) → use as comparison basis
- Subject documents (product specs, resumes, proposals — meant to be evaluated) → compare against a reference
- Otherwise → summarize
Never start converting or acting before the answer.

When the user wants the document stored as reference material rather than analyzed, convert it (call \`audit_convert_document\` once), then store into \`.wiki/\` at the workspace root following the existing topic page format. If a topic page for the same document already exists, ask the user with \`ask_user_question\` whether to replace it before overwriting.

When the user asks to audit, review, compare, or analyze a document:

## Step 1: Identify roles
Determine which document is the reference standard (criteria to measure against) and which is the subject (being evaluated). If unclear, ask with \`ask_user_question\`.

## Step 2: Convert
Call \`audit_convert_document\` for each subject document → \`work/<name>.html\` + \`work/<name>.txt\` + \`work/<name>.docx\`. The tool copies the original into the workspace so the review panel and export stay inside the tenant scope. Use the returned \`docxPath\` as \`documentPath\` in \`audit_write\`. Only when the tool fails, write your own python-docx converter under \`/tmp\` (guard optional attributes: \`p.style.name if p.style is not None else ''\`).

## Step 3: Extract dimensions
From the reference standard, extract evaluation dimensions — whatever the standard measures. Dimensions should cover all core requirements of the standard.

When the reference is a regulation or compliance standard, use a more thorough process:
1. Read \`.wiki/_index.md\`, then EVERY regulation topic page the group lists
2. Build a worklist: 适用法规｜条号｜义务｜触发条件
3. Two sweeps over the subject:
   - Obligation sweep: for every worklist line locate the passage. Missing = high-priority finding; weaker = finding; non-triggered = no finding
   - Document sweep: internal contradictions, missing values, inconsistent terms

## Step 4: Compare and find
For each dimension, find evidence in the subject document:
- Fully met → positive finding
- Partially met → moderate finding
- Completely missing → critical finding

Severity is determined by how important the dimension is to the overall judgment:
- Compliance: mandatory provision broken → [高]; missing process → [中]; wording → [低]
- Matching: fully meets requirement → [低] (good); partially → [中]; completely missing → [高] (gap)

Cite the source when there is a clear reference (e.g. 依据：《来源名》相关条目). When no source, omit.

## Step 5: Record
Call \`audit_write\` with each finding:
- \`title\`: one sentence summarizing the finding
- \`anchor\`: quote from the subject document text file
- \`issue\`: starts with [高]/[中]/[低], describes the finding
- \`replacement\`: suggested fix (for compliance with edit suggestions); omit for pure analysis
- \`cardTitle\`: a short title reflecting the analysis type (e.g. "合规审查", "匹配结果", "对比发现")
- \`summary\`: a short count line (e.g. "21 条违规", "3 位候选人", "7 处差异")
- \`severityLabels\`: MUST set based on the scenario. This controls the text on severity badges. Examples: compliance → {high:"违规",medium:"风险",low:"建议"}; resume matching → {high:"缺失",medium:"部分",low:"满足"}; contract review → {high:"高危",medium:"中危",low:"低危"}; requirement coverage → {high:"未覆盖",medium:"部分",low:"已覆盖"}; comparison → {high:"重大",medium:"一般",low:"轻微"}. Always set this field — the default "高/中/低" is too generic for any real scenario.
- ≤3 findings inline; more → \`json.dump\` to \`/tmp/findings-<name>.json\`, pass \`findingsFile\`

For multiple subject documents, analyze each separately, then rank by overall assessment.

## Step 6: Presentation Hints (Adaptive UI)
Set \`presentationHints\` to tell the UI how to display findings based on the scenario:

**layout**: Choose based on data characteristics
- \`'split-panel'\`: Single document + findings with replacements (compliance, contract review)
- \`'grouped-list'\`: Findings can be grouped by a field (resume matching by candidate, section-based review)
- \`'diff-view'\`: Multiple documents to compare (version comparison, draft review)
- \`'matrix'\`: Numerical scoring across categories (skill assessment, requirement coverage)
- \`'timeline'\`: Chronological findings (change history, audit trail)

**allowedActions**: What users can do with findings
- \`['accept', 'reject', 'undo']\`: For edits with replacement suggestions (compliance)
- \`['score', 'shortlist', 'compare']\`: For evaluation without edits (resume matching)
- \`['comment']\`: For discussion-based review (collaborative editing)
- \`[]\`: Read-only analysis (comparison, summary)

**groupBy**: Field to group findings (enables grouped-list layout)
- Extract from finding titles: "候选人张三 - 7年经验" → \`'candidate-name'\`
- Section-based: "第3章 第2节 - 缺失" → \`'section'\`
- Omit if no natural grouping

**scoring**: Enable when findings include numerical assessments
- \`{ enabled: true, field: 'match-percentage', label: '匹配度', range: [0, 100] }\`
- Extract scores from finding titles or issues
- Omit for non-scoring scenarios

**visualization**: Recommended chart type
- \`'severity-distribution'\`: Default for compliance (high/medium/low counts)
- \`'score-chart'\`: For numerical scoring scenarios
- \`'heatmap'\`: For grouped data with severity
- \`'comparison-matrix'\`: For multi-document diff

**exportFormats**: What the user can export
- \`['modified-document']\`: Original doc with accepted changes (compliance)
- \`['score-sheet']\`: Excel/CSV with scores (resume matching)
- \`['comparison-report']\`: Side-by-side diff report (comparison)
- \`['summary-pdf']\`: Audit summary report (all scenarios)
- \`['findings-matrix']\`: Excel matrix of findings (enterprise audit)

**userGoals**: What the user is trying to accomplish (inferred from conversation)
- Examples: \`['识别违规条款', '给出修改建议']\`, \`['评估匹配度', '排序候选人']\`

Example for resume matching:
\`\`\`json
{
  "layout": "grouped-list",
  "allowedActions": ["score", "shortlist"],
  "groupBy": "candidate-name",
  "scoring": { "enabled": true, "field": "match-score", "label": "匹配度", "range": [0, 100] },
  "visualization": "score-chart",
  "exportFormats": ["score-sheet", "summary-pdf"],
  "userGoals": ["评估候选人匹配度", "推荐最佳人选"]
}
\`\`\`

Example for compliance audit:
\`\`\`json
{
  "layout": "split-panel",
  "allowedActions": ["accept", "reject", "undo"],
  "visualization": "severity-distribution",
  "exportFormats": ["modified-document", "summary-pdf"],
  "userGoals": ["识别违规条款", "给出修改建议"]
}
\`\`\`

## Output
After \`audit_write\` succeeds, reply with ONE sentence summarizing the result. Never output findings as text/tables/lists, never explain the analysis process — the review card handles all of this.

## Important
- \`audit_write\` rejects the call when a quote is missing or ambiguous
- Applying a finding replaces its quote in the text file; empty replacement deletes the line`,
    })

    // ========== Capability-based Generic Guidance (Phase 4) ==========
    this.ctx.systemPrompt.section({
      name: 'audit-review:capability-guidance',
      order: 101,
      text: `## Enterprise Capability Platform

This audit system is a **generic capability platform** — not tied to any specific scenario. You configure it by combining 10 atomic capabilities to match any enterprise need.

### 10 Core Capabilities

| Capability | What it does | Remote method |
|---|---|---|
| **grouping** | Organize findings by any field/pattern | \`group_findings\` tool or remote \`group\` |
| **scoring** | Rate any target numerically | remote \`rate\` |
| **commenting** | Add notes to any finding/target | remote \`comment\` |
| **tagging** | Label findings with arbitrary tags | remote \`tag\` |
| **deciding** | Accept/reject/approve findings | remote \`decide\` |
| **exporting** | Export as CSV/JSON/HTML/Markdown | remote \`exportData\` |
| **visualizing** | Charts, heatmaps, matrices | UI renders from metadata |
| **comparing** | Track differences between items | UI renders from metadata |
| **tracking** | Progress and status management | stored in scenarioMetadata |
| **collaboration** | Multi-user review and discussion | remote \`comment\` + metadata |

### How to configure any scenario

**Step 1:** Call \`configure_scenario\` to declare which capabilities to enable:
\`\`\`json
{
  "layout": "grouped-list",
  "capabilities": {
    "grouping": { "enabled": true, "groupBy": "any-field", "pattern": "regex" },
    "scoring": { "enabled": true, "target": "score-field", "label": "分数", "range": [0, 100] },
    "exporting": { "enabled": true, "formats": ["csv", "json"] }
  }
}
\`\`\`

**Step 2:** Call \`audit_write\` with findings. Put extracted data in \`finding.metadata\`:
\`\`\`json
{
  "findings": [{
    "id": "f1",
    "title": "...",
    "anchor": { "path": "work/doc.txt", "line": 10, "quote": "..." },
    "issue": "...",
    "metadata": { "group-key": "value", "score": 85, "tags": ["high"] }
  }]
}
\`\`\`

**Step 3:** Use capability tools:
- \`group_findings\` — group by any field
- \`analyze_document\` — extract structured data from documents

**Step 4:** Users interact via UI (rate, comment, tag, export) → remote methods update scenarioMetadata.

### Examples: arbitrary scenarios

**Supplier evaluation:**
\`\`\`json
{ "layout": "matrix", "capabilities": { "grouping": { "enabled": true, "groupBy": "supplier" }, "scoring": { "enabled": true, "target": "score", "label": "评估", "range": [1, 10] }, "commenting": { "enabled": true }, "exporting": { "enabled": true, "formats": ["csv"] } } }
\`\`\`

**Risk assessment:**
\`\`\`json
{ "layout": "grouped-list", "capabilities": { "grouping": { "enabled": true, "groupBy": "risk-category" }, "scoring": { "enabled": true, "target": "risk-level", "label": "风险等级", "range": [1, 5] }, "tagging": { "enabled": true, "allowedTags": ["高", "中", "低"] }, "visualizing": { "enabled": true, "type": "heatmap" } } }
\`\`\`

**Course evaluation:**
\`\`\`json
{ "layout": "grouped-list", "capabilities": { "grouping": { "enabled": true, "groupBy": "course" }, "scoring": { "enabled": true, "target": "satisfaction", "label": "满意度", "range": [1, 5] }, "tagging": { "enabled": true, "allowedTags": ["优秀", "良好", "待改进"] }, "exporting": { "enabled": true, "formats": ["json", "html"] } } }
\`\`\`

**Key principle: scenarios emerge from capability combinations, not from hardcoded logic.**`,
    })
  }

  /**
   * Save a decision for a finding in the current round.
   * @param request - Session, round, finding and requested decision.
   * @returns Whether the decision was recorded; file application is separate.
   */
  @Remote('decide')
  async decide(request: AuditDecideRequest): Promise<AuditDecideResult> {
    const round = auditRound(this.ctx, request, 'decision')
    if (!round.ok) return round
    if (!round.state.findings.some(f => f.id === request.findingId)) {
      return { ok: false, error: { code: 'finding-not-found', message: `round ${request.round} has no finding '${request.findingId}'` } }
    }
    round.session.append('audit/decide', { round: request.round, findingId: request.findingId, decision: request.decision })
    return { ok: true }
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
    const round = auditRound(this.ctx, request, 'apply')
    if (!round.ok) return round
    const { session, state } = round
    const finding = state.findings.find(f => f.id === request.findingId)
    if (finding === undefined) {
      return { ok: false, error: { code: 'finding-not-found', message: `round ${request.round} has no finding '${request.findingId}'` } }
    }
    const cwd = session.header.cwd
    const target = await this.ctx.fs.resolve(finding.anchor.path, { ...cwd !== undefined ? { cwd } : {} })
    const key = `${request.sessionId}\u0000${finding.anchor.path}`
    const recorded = this.applyBases.get(key)
    let base: string
    let version: FsVersion
    if (recorded !== undefined && recorded.round === request.round) {
      base = recorded.base
      version = recorded.version
    } else {
      try {
        base = await this.ctx.fs.readText(target)
        const info = await this.ctx.fs.stat(target)
        if (info?.version === undefined) {
          return { ok: false, error: { code: 'version-unavailable', message: `cannot safely update "${finding.anchor.path}": its version is unavailable` } }
        }
        version = info.version
      } catch {
        return { ok: false, error: { code: 'not-text', message: `"${finding.anchor.path}" is not readable as UTF-8 text` } }
      }
    }
    const accepted = state.findings.filter(f => f.anchor.path === finding.anchor.path && state.decisions[f.id] === 'accept' && f.replacement !== undefined)
    const rendered = renderAccepted(base, accepted)
    if (!rendered.ok) return { ok: false, error: { code: rendered.code, message: rendered.message } }
    setSandboxMode(session, 'workspace-write')
    try {
      const outcome = await this.ctx.fs.writeText(
        target,
        rendered.text,
        { kind: 'replaceIfVersion', version },
        undefined,
        this.ctx.sandboxPolicy.resolve({ session, mode: 'workspace-write' }),
      )
      this.applyBases.set(key, { round: request.round, base, version: outcome.version })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'FS_STALE_VERSION') {
        return { ok: false, error: { code: 'document-changed', message: `"${finding.anchor.path}" changed outside this review; reload the document before applying decisions` } }
      }
      throw error
    }
    return { ok: true }
  }

  /**
   * Write the original document back out with the round's accepted findings applied, so the review
   * card's download carries the edits to the file the user uploaded. Quotes and replacements
   * travel as shell-quoted argv pairs and the original upload is never modified.
   * @param request - session and round whose accepted findings to apply.
   * @returns the exported file's download name and workspace path, or the failure to report.
   */
  @Remote('exportDocument')
  async exportDocument(request: AuditExportRequest): Promise<AuditExportResult> {
    const round = auditRound(this.ctx, request, 'exportDocument')
    if (!round.ok) return round
    const { session, state } = round
    const cwd = session.header.cwd
    if (cwd === undefined) {
      return { ok: false, error: { code: 'no-working-directory', message: 'the session has no working directory' } }
    }
    const source = await this.ctx.fs.resolve(state.documentPath, { cwd })
    if (!/\.docx$/i.test(source.displayPath)) {
      return { ok: false, error: { code: 'unsupported-format', message: `cannot export "${state.documentPath}": only .docx documents are supported` } }
    }
    const base = basename(source.displayPath).replace(/\.docx$/i, '')
    const filename = `${base}（修改后）.docx`
    const out = `work/${filename}`
    const accepted = state.findings.filter(f => state.decisions[f.id] === 'accept' && f.replacement !== undefined)
    const pairs = accepted.flatMap(f => [f.anchor.quote, f.replacement ?? ''])
    const command = `python3 -c ${shellWord(exportScript)} -- ${shellWord(source.displayPath)} ${shellWord(out)}`
      + pairs.map(pair => ` ${shellWord(pair)}`).join('')
    // Switch to workspace-write mode so the export can write the modified document.
    setSandboxMode(session, 'workspace-write')
    const execution = await this.ctx.shell.execute(this.ctx.shell.resolve({
      command,
      workdir: cwd,
      timeoutMs: 120_000,
      stdoutMaxBytes: 4096,
      sandboxPolicy: this.ctx.sandboxPolicy.resolve({ session, mode: 'workspace-write' }),
    }))
    const result = await execution.result()
    if (result.aborted) {
      return { ok: false, error: { code: 'export-aborted', message: 'the export was aborted' } }
    }
    if (result.exitCode !== 0) {
      return { ok: false, error: { code: 'export-failed', message: `python failed (exit ${result.exitCode ?? 'killed'}): ${result.stderr.text.slice(-400).trim()}` } }
    }
    const counts = /APPLIED (\d+) SKIPPED (\d+)/.exec(result.stdout.text)
    const applied = Number(counts?.[1] ?? 0)
    const skipped = Number(counts?.[2] ?? 0)
    if (skipped > 0) {
      return { ok: false, error: { code: 'export-incomplete', message: `${skipped} accepted finding(s) could not be located in the Word document; no download was published` } }
    }
    return { ok: true, value: { path: out, filename, applied, skipped } }
  }

  // ========== Capability Methods (Phase 2) ==========

  /**
   * Group findings by any field or pattern extracted from titles/issues.
   * Stores grouping result in scenarioMetadata for UI rendering.
   * @param request - Session and operation parameters.
   * @returns Groups of finding IDs, or a failure.
   */
  @Remote('group')
  async group(request: AuditGroupRequest): Promise<AuditGroupResult> {
    const round = auditRound(this.ctx, request, 'group')
    if (!round.ok) return round
    const { session, state } = round

    const groups = new Map<string, string[]>()
    const regex = request.pattern ? new RegExp(request.pattern) : null

    for (const finding of state.findings) {
      let key = finding.metadata?.[request.groupBy]

      // Extract from title or issue using pattern
      if (key === undefined && regex) {
        const text = finding.title ?? finding.issue
        const match = text.match(regex)
        key = match?.[1] ?? '未分组'
      }

      key = String(key ?? '未分组')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)?.push(finding.id)
    }

    // Store in scenarioMetadata via scenario/update event
    const existingMetadata = state.scenarioMetadata ?? {}
    session.append('scenario/update', {
      ...existingMetadata,
      grouping: {
        groupBy: request.groupBy,
        groups: Object.fromEntries(groups),
      },
    })

    return { ok: true, groups: Object.fromEntries(groups) }
  }

  /**
   * Rate any target (candidate, section, item) with a numerical score.
   * Stores ratings in scenarioMetadata.
   * @param request - Session and operation parameters.
   * @returns Whether the rating was recorded.
   */
  @Remote('rate')
  async rate(request: AuditRateRequest): Promise<AuditRateResult> {
    const round = auditRound(this.ctx, request, 'rate')
    if (!round.ok) return round
    const { session, state } = round
    if (!state.findings.some(finding => finding.id === request.targetId)) {
      return { ok: false, error: { code: 'finding-not-found', message: `round ${request.round} has no finding '${request.targetId}'` } }
    }
    const scoring = resolvePresentationHints(state.presentationHints, state.findings).capabilities?.scoring
    if (scoring?.enabled !== true) return { ok: false, error: { code: 'capability-disabled', message: 'scoring is not enabled for this review' } }
    const [minimum, maximum] = scoring.range
    if (minimum === undefined || maximum === undefined || !Number.isFinite(request.score)
      || request.score < minimum || request.score > maximum) {
      return { ok: false, error: { code: 'score-out-of-range', message: `score must be between ${String(minimum)} and ${String(maximum)}` } }
    }

    const existingMetadata = state.scenarioMetadata ?? {}
    const ratings = { ...metadataRecord(existingMetadata.ratings), [request.targetId]: {
      score: request.score,
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      timestamp: Date.now(),
    } }

    session.append('scenario/update', {
      ...existingMetadata,
      ratings,
    })

    return { ok: true }
  }

  /**
   * Add a comment to any target (finding, section, candidate).
   * Stores comments in scenarioMetadata.
   * @param request - Session and operation parameters.
   * @returns Whether the comment was recorded.
   */
  @Remote('comment')
  async comment(request: AuditCommentRequest): Promise<AuditCommentResult> {
    const round = auditRound(this.ctx, request, 'comment')
    if (!round.ok) return round
    const { session, state } = round
    if (!state.findings.some(finding => finding.id === request.targetId)) {
      return { ok: false, error: { code: 'finding-not-found', message: `round ${request.round} has no finding '${request.targetId}'` } }
    }
    if (resolvePresentationHints(state.presentationHints, state.findings).capabilities?.commenting?.enabled !== true) {
      return { ok: false, error: { code: 'capability-disabled', message: 'commenting is not enabled for this review' } }
    }
    if (request.comment.trim() === '') return { ok: false, error: { code: 'empty-comment', message: 'comment must not be empty' } }

    const existingMetadata = state.scenarioMetadata ?? {}
    const previous = metadataRecord(existingMetadata.comments)
    const targetComments = previous[request.targetId]
    const comments = { ...previous, [request.targetId]: [...(Array.isArray(targetComments) ? targetComments : []), {
      text: request.comment,
      author: request.author ?? 'user',
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      timestamp: Date.now(),
    }] }

    session.append('scenario/update', {
      ...existingMetadata,
      comments,
    })

    return { ok: true }
  }

  /**
   * Tag any target with arbitrary labels.
   * Stores tags in scenarioMetadata.
   * @param request - Session and operation parameters.
   * @returns Whether the tags were recorded.
   */
  @Remote('tag')
  async tag(request: AuditTagRequest): Promise<AuditTagResult> {
    const round = auditRound(this.ctx, request, 'tag')
    if (!round.ok) return round
    const { session, state } = round
    if (!state.findings.some(finding => finding.id === request.targetId)) {
      return { ok: false, error: { code: 'finding-not-found', message: `round ${request.round} has no finding '${request.targetId}'` } }
    }
    const tagging = resolvePresentationHints(state.presentationHints, state.findings).capabilities?.tagging
    if (tagging?.enabled !== true) return { ok: false, error: { code: 'capability-disabled', message: 'tagging is not enabled for this review' } }
    const disallowed = tagging.allowedTags === undefined ? undefined : request.tags.find(tag => !tagging.allowedTags?.includes(tag))
    if (disallowed !== undefined) return { ok: false, error: { code: 'tag-not-allowed', message: `tag '${disallowed}' is not allowed for this review` } }

    const existingMetadata = state.scenarioMetadata ?? {}
    const tags = { ...metadataRecord(existingMetadata.tags), [request.targetId]: [...request.tags] }

    session.append('scenario/update', {
      ...existingMetadata,
      tags,
    })

    return { ok: true }
  }

  /**
   * Export findings and metadata in various formats (CSV, JSON, HTML, Markdown).
   * Generates data on-the-fly from current state.
   * @param request - Session and operation parameters.
   * @returns Exported content and download metadata, or a failure.
   */
  @Remote('exportData')
  async exportData(request: AuditExportDataRequest): Promise<AuditExportDataResult> {
    const round = auditRound(this.ctx, request, 'exportData')
    if (!round.ok) return round
    const { state } = round
    const exporting = resolvePresentationHints(state.presentationHints, state.findings).capabilities?.exporting
    if (exporting?.enabled !== true || !exporting.formats.includes(request.format)) {
      return { ok: false, error: { code: 'format-disabled', message: `format '${request.format}' is not enabled for this review` } }
    }
    const metadata = { ...state.scenarioMetadata, decisions: state.decisions }

    // Apply filters if provided
    let findings = state.findings
    const filters = request.filters
    if (filters) {
      findings = findings.filter((f) => {
        for (const [key, value] of Object.entries(filters)) {
          if (f.metadata?.[key] !== value) return false
        }
        return true
      })
    }

    // Generate export based on format
    switch (request.format) {
      case 'csv':
        return this.exportCSV(findings, metadata, request.template)
      case 'json':
        return this.exportJSON(findings, metadata, request.template)
      case 'html':
        return this.exportHTML(findings, metadata, request.template)
      case 'markdown':
        return this.exportMarkdown(findings, metadata, request.template)
      default:
        return { ok: false, error: { code: 'unsupported-format', message: `format '${request.format}' is not supported` } }
    }
  }

  /**
   * Update responsibility and processing state for one finding.
   * @param request - Session, round, target and workflow fields.
   * @returns Whether the workflow state was recorded.
   */
  @Remote('track')
  async track(request: AuditTrackRequest): Promise<AuditTrackResult> {
    const round = auditRound(this.ctx, request, 'track')
    if (!round.ok) return round
    const { session, state } = round
    if (!state.findings.some(finding => finding.id === request.targetId)) {
      return { ok: false, error: { code: 'finding-not-found', message: `round ${request.round} has no finding '${request.targetId}'` } }
    }
    if (resolvePresentationHints(state.presentationHints, state.findings).capabilities?.tracking?.enabled !== true) {
      return { ok: false, error: { code: 'capability-disabled', message: 'tracking is not enabled for this review' } }
    }
    const workflow = {
      ...metadataRecord(state.scenarioMetadata?.workflow),
      [request.targetId]: {
        status: request.status,
        ...(request.assignee?.trim() ? { assignee: request.assignee.trim() } : {}),
        ...(request.dueAt !== undefined ? { dueAt: request.dueAt } : {}),
        updatedAt: Date.now(),
      },
    }
    session.append('scenario/update', { ...state.scenarioMetadata, workflow })
    return { ok: true }
  }

  private exportCSV(findings: AuditFinding[], _metadata: Record<string, JsonValue> | undefined, _template?: string): AuditExportDataResult {
    // Infer columns from findings
    const columns = new Set<string>()
    for (const finding of findings) {
      if (finding.metadata) {
        Object.keys(finding.metadata).forEach(key => columns.add(key))
      }
    }
    const columnArray = Array.from(columns)

    // Generate CSV
    const rows = [
      ['ID', 'Title', 'Issue', ...columnArray],
      ...findings.map(f => [
        f.id,
        f.title ?? '',
        f.issue,
        ...columnArray.map(col => String(f.metadata?.[col] ?? '')),
      ]),
    ]

    const csv = rows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n')
    const filename = `export-${Date.now()}.csv`

    return { ok: true, data: csv, filename, mimeType: 'text/csv;charset=utf-8' }
  }

  private exportJSON(
    findings: AuditFinding[], _metadata: Record<string, JsonValue> | undefined, _template?: string,
  ): AuditExportDataResult {
    const data = {
      findings,
      metadata: _metadata,
      exportedAt: new Date().toISOString(),
    }
    const json = JSON.stringify(data, null, 2)
    const filename = `export-${Date.now()}.json`

    return { ok: true, data: json, filename, mimeType: 'application/json' }
  }

  private exportHTML(
    findings: AuditFinding[], _metadata: Record<string, JsonValue> | undefined, _template?: string,
  ): AuditExportDataResult {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Audit Export</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
  </style>
</head>
<body>
  <h1>Audit Export</h1>
  <p>Exported at: ${new Date().toISOString()}</p>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Title</th>
        <th>Issue</th>
      </tr>
    </thead>
    <tbody>
      ${findings.map(f => `
        <tr>
          <td>${escapeHtml(f.id)}</td>
          <td>${escapeHtml(f.title ?? '')}</td>
          <td>${escapeHtml(f.issue)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</body>
</html>`
    const filename = `export-${Date.now()}.html`

    return { ok: true, data: html, filename, mimeType: 'text/html;charset=utf-8' }
  }

  private exportMarkdown(
    findings: AuditFinding[], _metadata: Record<string, JsonValue> | undefined, _template?: string,
  ): AuditExportDataResult {
    const md = `# Audit Export

Exported at: ${new Date().toISOString()}

## Findings

${findings.map(f => `### ${f.title ?? f.id}

**Issue:** ${f.issue}

`).join('\n')}`
    const filename = `export-${Date.now()}.md`

    return { ok: true, data: md, filename, mimeType: 'text/markdown;charset=utf-8' }
  }

}

export default AuditReviewService
