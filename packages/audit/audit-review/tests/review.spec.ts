/** Regression coverage for extraction and revision-based document edits. */
import { describe, expect, it } from 'vitest'
import { extractField } from '../src/extraction.ts'
import { renderAccepted } from '../src/text-edits.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { auditStateSchema, foldAudit } from '../src/projection.ts'
import { presentationHintsSchema, resolvePresentationHints } from '../src/scenario.ts'
import type { AuditFinding, AuditState } from '../src/types.ts'

const finding = (quote: string, replacement?: string): AuditFinding => ({
  id: quote, anchor: { path: 'document.txt', line: 1, quote }, issue: 'Review',
  ...(replacement !== undefined ? { replacement } : {}),
})

describe('document extraction', () => {
  it('keeps absent and malformed numbers unknown', () => {
    for (const value of [undefined, '', ' ', 'unknown', 'Infinity']) expect(extractField(value, 'number')).toBeNull()
    expect(extractField('0', 'number')).toBe(0)
    expect(extractField('2.5', 'number')).toBe(2.5)
  })
  it('parses boolean values explicitly', () => {
    expect(extractField('false', 'boolean')).toBe(false)
    expect(extractField('否', 'boolean')).toBe(false)
    expect(extractField(' TRUE ', 'boolean')).toBe(true)
    expect(extractField('unknown', 'boolean')).toBeNull()
  })
})

describe('document modifications', () => {
  it('keeps acknowledged findings without replacement unchanged', () => {
    expect(renderAccepted('keep this', [finding('keep')])).toEqual({ ok: true, text: 'keep this' })
  })
  it('distinguishes explicit deletion from acknowledgment', () => {
    expect(renderAccepted('delete\nkeep', [finding('delete', '')])).toEqual({ ok: true, text: 'keep' })
  })
  it('applies changes against the original revision regardless of input order', () => {
    const edits = [finding('alpha', 'long replacement'), finding('beta', 'b')]
    expect(renderAccepted('alpha beta', edits)).toEqual({ ok: true, text: 'long replacement b' })
    expect(renderAccepted('alpha beta', [...edits].reverse())).toEqual(renderAccepted('alpha beta', edits))
    expect(renderAccepted('alpha beta', [])).toEqual({ ok: true, text: 'alpha beta' })
  })
  it('rejects overlapping or missing evidence before writing', () => {
    expect(renderAccepted('alpha beta', [finding('alpha', 'a'), finding('alpha beta', 'b')])).toMatchObject({ ok: false, code: 'anchor-overlap' })
    expect(renderAccepted('alpha', [finding('beta', 'b')])).toMatchObject({ ok: false, code: 'anchor-not-found' })
  })
})

describe('scenario snapshots', () => {
  it('preserves layout and capabilities through wire validation', () => {
    const presentationHints = { layout: 'matrix', capabilities: { scoring: { enabled: true, target: 'vendor', label: 'Score', range: [0, 10] } } }
    expect(auditStateSchema.parse({ round: 1, documentPath: 'a.txt', findings: [], decisions: {}, presentationHints }).presentationHints).toEqual(presentationHints)
  })
  it('rejects invalid layouts and scoring ranges', () => {
    expect(presentationHintsSchema.safeParse({ layout: 'missing' }).success).toBe(false)
    expect(presentationHintsSchema.safeParse({ capabilities: { scoring: { enabled: true, target: 'vendor', label: 'Score', range: [10, 0] } } }).success).toBe(false)
  })
  it('opens baseline workflow capabilities and upgrades legacy scenario hints', () => {
    const resolved = resolvePresentationHints({
      groupBy: 'supplier',
      scoring: { enabled: true, field: 'risk', label: 'Risk', range: [1, 5] },
    }, [finding('clause', 'replacement')])
    expect(resolved.capabilities).toMatchObject({
      commenting: { enabled: true }, tagging: { enabled: true }, tracking: { enabled: true },
      collaboration: { enabled: true }, exporting: { enabled: true }, deciding: { enabled: true },
      grouping: { enabled: true, groupBy: 'supplier' },
      scoring: { enabled: true, target: 'risk', label: 'Risk', range: [1, 5] },
    })
  })
})


describe('scenario event replay', () => {
  it('keeps configuration when the first review round arrives', () => {
    const empty: AuditState = { round: 0, documentPath: '', findings: [], decisions: {} }
    const configured = foldAudit(empty, { type: 'scenario/update', seq: SessionSeq(0), time: 0, data: { presentationHints: { layout: 'matrix' } } })
    expect(configured.presentationHints?.layout).toBe('matrix')
    const reviewed = foldAudit(configured, { type: 'audit/write', seq: SessionSeq(1), time: 1, data: { round: 1, documentPath: 'a.txt', findings: [] } })
    expect(reviewed.presentationHints?.layout).toBe('matrix')
    expect(reviewed.presentationHints?.capabilities?.tracking?.enabled).toBe(true)
    expect(empty.presentationHints).toBeUndefined()
  })

  it('allows an explicit new-round layout to override prior configuration', () => {
    const state: AuditState = { round: 1, documentPath: 'a.txt', findings: [], decisions: {}, presentationHints: { layout: 'matrix' } }
    const next = foldAudit(state, { type: 'audit/write', seq: SessionSeq(2), time: 2, data: { round: 2, documentPath: 'a.txt', findings: [], presentationHints: { layout: 'timeline' } } })
    expect(next.presentationHints?.layout).toBe('timeline')
    expect(state.presentationHints?.layout).toBe('matrix')
  })
})
