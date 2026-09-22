/**
 * Audit-review plugin: projection, remote service, and tool for the
 * document audit workflow. The agent calls `audit_write` to record findings;
 * the user decides accept/reject/undo via the remote; the projection folds events.
 * @module @deepseek-ai/dsh-audit-review
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { basename } from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-shell'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  AuditState,
  AuditFinding,
  AuditDecideRequest,
  AuditDecideResult,
  AuditApplyRequest,
  AuditApplyResult,
  AuditExportRequest,
  AuditExportResult,
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
const auditWriteToolDescription = 'Record audit findings after analyzing a document. MUST be called when the user asks to audit/review a document. Each finding cites a specific location with a quoted anchor and a replacement suggestion. NEVER output findings as plain text - always use this tool. Every anchor is validated against the audited file: a quote that is missing or ambiguous rejects the whole call, so fix the anchor and call again. For more than 3 findings write a temporary JSON file named after the document (e.g. /tmp/findings-<name>.json) with Python json.dump and pass findingsFile instead of hand-writing the inline array: long inline arrays drop required fields and waste retries, and a reused generic name collides with leftovers from an earlier session and trips the read-before-write guard.'

/**
 * The document converter audit_convert_document runs. It emits the exact HTML the review panel
 * renders (headings, paragraphs, lists, bordered tables) plus one plain-text line per paragraph
 * or table row — the line structure anchor.line and the highlight linkage rely on. Double quotes
 * only: the tool embeds the script in a single-quoted shell word. Paths arrive as argv so no
 * quoting can break.
 */
const convertScript = [
  'import html as H, os, sys',
  'import docx',
  'from docx.document import Document as _Doc',
  'from docx.oxml.table import CT_Tbl',
  'from docx.oxml.text.paragraph import CT_P',
  'from docx.table import Table',
  'from docx.text.paragraph import Paragraph',
  'SRC, OUT_HTML, OUT_TXT = sys.argv[2], sys.argv[3], sys.argv[4]  # argv[1] is the -- separator',
  'os.makedirs(os.path.dirname(OUT_HTML) or ".", exist_ok=True)',
  'def iter_block_items(parent):',
  '    parent_elm = parent.element.body if isinstance(parent, _Doc) else parent._tc',
  '    for child in parent_elm.iterchildren():',
  '        if isinstance(child, CT_P):',
  '            yield Paragraph(child, parent)',
  '        elif isinstance(child, CT_Tbl):',
  '            yield Table(child, parent)',
  'def esc(s):',
  '    return H.escape(s, quote=False)',
  'doc = docx.Document(SRC)',
  'def para_html(p):',
  '    style = p.style.name if p.style is not None else ""',
  '    txt = p.text',
  '    if not txt.strip():',
  '        return None',
  '    if style.startswith("Heading 1"):',
  '        return f"<h1>{esc(txt)}</h1>"',
  '    if style.startswith("Heading 2"):',
  '        return f"<h2>{esc(txt)}</h2>"',
  '    if style.startswith("Heading"):',
  '        return f"<h3>{esc(txt)}</h3>"',
  '    if style.startswith("List"):',
  '        return f"<li>{esc(txt)}</li>"',
  '    return f"<p>{esc(txt)}</p>"',
  'def cell_html(c):',
  '    return "<td>" + "<br>".join(esc(x) for x in c.text.split("\\n")) + "</td>"',
  'def table_html(tbl):',
  '    rows = []',
  '    for r in tbl.rows:',
  '        cells = "".join(cell_html(c) for c in r.cells)',
  '        rows.append("<tr>" + cells + "</tr>")',
  '    return "<table>" + "".join(rows) + "</table>"',
  'body = []',
  'text = []',
  'for block in iter_block_items(doc):',
  '    if isinstance(block, Paragraph):',
  '        h = para_html(block)',
  '        if h:',
  '            body.append(h)',
  '        if block.text.strip():',
  '            text.append(block.text)',
  '    elif isinstance(block, Table):',
  '        body.append(table_html(block))',
  '        for r in block.rows:',
  '            cells = [c.text.replace("\\n", " ") for c in r.cells]',
  '            text.append(" | ".join(cells))',
  '        text.append("")',
  'html_doc = ("<!DOCTYPE html><html><head><meta charset=\\"utf-8\\"><style>"',
  '            "body{font-family:sans-serif;margin:2em;max-width:960px;line-height:1.6}"',
  '            "table{border-collapse:collapse;margin:1em 0}"',
  '            "td,th{border:1px solid #999;padding:6px 10px;vertical-align:top}"',
  '            "h1{font-size:22px}h2{font-size:18px}h3{font-size:16px}"',
  '            "</style></head><body>" + "\\n".join(body) + "</body></html>")',
  'with open(OUT_HTML, "w", encoding="utf-8") as f:',
  '    f.write(html_doc)',
  'with open(OUT_TXT, "w", encoding="utf-8") as f:',
  '    f.write("\\n".join(text))',
  'print("LINES", len(text))',
].join('\n')

/**
 * The document exporter the `exportDocument` remote runs: rewrites the original .docx so it holds
 * the round's accepted findings. Quotes and replacements arrive as argv pairs; a quote no
 * paragraph holds is counted as skipped instead of failing the export. Each replacement inherits
 * the formatting of the run its quote started in, and a replacement that empties its paragraph
 * removes the paragraph, matching the text file's whole-line deletion.
 */
const exportScript = [
  'import os, sys',
  'import docx',
  'from docx.document import Document as _Doc',
  'from docx.oxml.table import CT_Tbl',
  'from docx.oxml.text.paragraph import CT_P',
  'from docx.table import Table',
  'from docx.text.paragraph import Paragraph',
  'SRC, OUT = sys.argv[2], sys.argv[3]  # argv[1] is the -- separator',
  'PAIRS = sys.argv[4:]  # quote replacement quote replacement ...',
  'os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)',
  'def iter_paragraphs(parent):',
  '    parent_elm = parent.element.body if isinstance(parent, _Doc) else parent._tc',
  '    for child in parent_elm.iterchildren():',
  '        if isinstance(child, CT_P):',
  '            yield Paragraph(child, parent)',
  '        elif isinstance(child, CT_Tbl):',
  '            tbl = Table(child, parent)',
  '            for row in tbl.rows:',
  '                for cell in row.cells:',
  '                    yield from iter_paragraphs(cell)',
  'doc = docx.Document(SRC)',
  'paras = list(iter_paragraphs(doc))',
  'applied = 0',
  'skipped = 0',
  'for i in range(0, len(PAIRS), 2):',
  '    quote, repl = PAIRS[i], PAIRS[i + 1]',
  '    done = False',
  '    for p in paras:',
  '        runs = p.runs',
  '        full = "".join(r.text for r in runs)',
  '        at = full.find(quote)',
  '        if at == -1:',
  '            continue',
  '        end = at + len(quote)',
  '        pos = 0',
  '        first = True',
  '        for r in runs:',
  '            s, e = pos, pos + len(r.text)',
  '            pos = e',
  '            lo, hi = max(at, s), min(end, e)',
  '            if lo >= hi:',
  '                continue',
  '            head, tail = r.text[:lo - s], r.text[hi - s:]',
  '            if first:',
  '                r.text = head + repl + tail',
  '                first = False',
  '            else:',
  '                r.text = head + tail',
  '        if repl == "" and p.text.strip() == "":',
  '            p._element.getparent().remove(p._element)',
  '        applied += 1',
  '        done = True',
  '        break',
  '    if not done:',
  '        skipped += 1',
  'doc.save(OUT)',
  'print(f"APPLIED {applied} SKIPPED {skipped}")',
].join('\n')

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
    description: 'Convert a .docx document into the two audit workspace files in one call: work/<name>.html (formatted preview the review panel renders) and work/<name>.txt (plain text, one paragraph or table row per line — the audit anchor source). MUST be used instead of writing a converter; write your own python-docx converter under /tmp only when this tool fails.',
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
        },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: `Converted to ${value.htmlPath} and ${value.textPath} (${value.textLines} lines).`,
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
      const command = `python3 -c ${shellWord(convertScript)} -- ${shellWord(src.displayPath)} ${shellWord(htmlPath)} ${shellWord(textPath)}`
      const result = await ctx.shell.run(ctx.shell.resolve({
        command,
        workdir: cwd,
        timeoutMs: 120_000,
        stdoutMaxBytes: 4096,
        sandboxPolicy: ctx.sandboxPolicy.resolve({ session }),
        signal: exec.signal,
      }))
      if (result.aborted) throw new Error('audit_convert_document: aborted')
      if (result.exitCode !== 0) {
        throw new Error(`audit_convert_document: python failed (exit ${result.exitCode ?? 'killed'}): ${result.stderr.text.slice(-400).trim()}`)
      }
      const textLines = Number(/LINES (\d+)/.exec(result.stdout.text)?.[1] ?? 0)
      return { htmlPath, textPath, textLines }
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
    if (typeof entries.replacement !== 'string') problems.push(`${at}.replacement is missing or not a string`)
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
        description: 'Inline findings; reliable up to 3. For more, write a temporary JSON file named after the document (e.g. /tmp/findings-<name>.json) with Python json.dump and pass findingsFile instead. Ignored when findingsFile is set.',
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
                line: { type: 'integer', required: true, description: 'Line number (1-based) in the text file that contains the quote.' },
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
      const anchor = await resolveAnchors(ctx, session.header.cwd, findings)
      if (anchor.problems.length > 0) {
        throw new Error(`audit_write: every anchor must match the audited file; fix these and call again:\n${anchor.problems.join('\n')}`)
      }
      session.append('audit/write', { round: args.round, documentPath: args.documentPath, findings: anchor.findings })
      return { round: args.round, findingCount: anchor.findings.length }
    },
  })
}

/** Content each audited file held before its round's first apply, keyed by session and path, so a
 * later apply or undo re-renders from the same base instead of from edited text. */
const applyBases = new Map<string, { round: number; base: string }>()

/** Remote service for user decisions on audit findings. */
export class AuditReviewService extends TypertRemoteService {
  static inject = ['sessions', 'sessionProjections', 'fs', 'tools', 'systemPrompt', 'sandboxPolicy', 'shell']

  constructor(ctx: Context) {
    super(ctx, 'auditReview')
  }

  protected [Service.init](): void {
    registerProjection(this.ctx)
    this.ctx.tools.register(createAuditWriteTool(this.ctx))
    this.ctx.tools.register(createAuditConvertTool(this.ctx))
    this.ctx.systemPrompt.section({
      name: 'audit-review:guidance',
      order: 100,
      text: `When the user uploads a document without saying what to do with it, ask first with \`ask_user_question\`: offer auditing/reviewing the document as the recommended option plus at least one alternative (summarize, extract requirements, revise), and never start converting or auditing before the answer.

When the user asks to audit or review a document:

## Step 1: Convert the document (one call)
Call \`audit_convert_document\` with the original document path; it writes \`work/<name>.html\` (formatted preview) and \`work/<name>.txt\` (plain text, one paragraph or table row per line — the audit anchor source) in one call. Only when the tool fails may you write your own converter with python-docx under \`/tmp\` with a name unique to this document, guarding every optional attribute (\`paragraph.style\` and \`paragraph.alignment\` are \`None\` without explicit formatting: read \`p.style.name if p.style is not None else ''\`).

## Step 2: Audit the document
1. Read the plain text file (\`work/<name>.txt\`) for analysis
2. Call \`audit_write\` to record all findings
   - With 3 or fewer findings pass them inline; with more, build the array in Python by slicing the quote for each finding straight out of the text file — never retype quotes by hand, full-width lookalikes break the verbatim match — and \`json.dump\` it to a temporary file named after the document (e.g. \`/tmp/findings-<name>.json\`), then pass \`findingsFile\`
   - \`anchor.path\` MUST point to the text file (\`work/<name>.txt\`)
   - \`anchor.line\` MUST be the 1-based line that contains the quote
   - \`anchor.quote\` MUST be copied verbatim and appear exactly once in the file; extend it with surrounding words when a short quote repeats
   - \`issue\` MUST start with [高风险], [中风险] or [低风险]
   - \`replacement\` MUST replace exactly the quoted span and read as correct prose afterwards; set it to the empty string to delete the whole line, never to instructions or notes
   - \`documentPath\` is the original document path
3. The moment \`audit_write\` succeeds, reply with ONLY this one line and make no further tool calls in between — background archiving never delays the reply: "审计完成，共 N 条发现，请查看审查卡片。"
4. NEVER output findings as text, tables, or lists - the card displays them
5. NEVER explain your analysis process or reasoning
6. NEVER list, link, or present the generated files and NEVER call the file-presentation tool - the review card already carries the review and download actions

## Important
- The HTML file (\`work/<name>.html\`) and text file (\`work/<name>.txt\`) MUST have the same base name
- The review panel renders the HTML file for formatted preview with highlight linkage
- \`audit_write\` validates every anchor against the file and rejects the call when a quote is missing or ambiguous
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
    // The session's own policy fences the write: its cwd is the workspace-write boundary, which can
    // differ from the deployment fallback root.
    await this.ctx.fs.writeText(target, rendered.text, undefined, undefined, this.ctx.sandboxPolicy.resolve({ session }))
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
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return { ok: false, error: { code: 'session-not-found', message: `no live session '${request.sessionId}'` } }
    }
    const state = this.ctx.sessionProjections.stateOf(session, 'audit')
    if (state === undefined || state.round !== request.round) {
      return { ok: false, error: { code: 'stale-round', message: `exportDocument names round ${request.round} but the session's current audit round is ${state?.round ?? 'none'}` } }
    }
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
    const accepted = state.findings.filter(f => state.decisions[f.id] === 'accept')
    const pairs = accepted.flatMap(f => [f.anchor.quote, f.replacement])
    const command = `python3 -c ${shellWord(exportScript)} -- ${shellWord(source.displayPath)} ${shellWord(out)}`
      + pairs.map(pair => ` ${shellWord(pair)}`).join('')
    const result = await this.ctx.shell.run(this.ctx.shell.resolve({
      command,
      workdir: cwd,
      timeoutMs: 120_000,
      stdoutMaxBytes: 4096,
      sandboxPolicy: this.ctx.sandboxPolicy.resolve({ session }),
    }))
    if (result.aborted) {
      return { ok: false, error: { code: 'export-aborted', message: 'the export was aborted' } }
    }
    if (result.exitCode !== 0) {
      return { ok: false, error: { code: 'export-failed', message: `python failed (exit ${result.exitCode ?? 'killed'}): ${result.stderr.text.slice(-400).trim()}` } }
    }
    const counts = /APPLIED (\d+) SKIPPED (\d+)/.exec(result.stdout.text)
    return { ok: true, value: { path: out, filename, applied: Number(counts?.[1] ?? 0), skipped: Number(counts?.[2] ?? 0) } }
  }
}

export default AuditReviewService
