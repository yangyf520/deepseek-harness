/** Runtime validation for model-authored scenario presentation settings. */
import { z } from 'zod'
import type { AuditFinding, CapabilityConfig, PresentationHints } from './types.ts'

const actions = z.enum(['accept', 'reject', 'undo', 'approve', 'mitigate'])
const scoreRange = z.array(z.number().finite()).length(2).refine((range) => {
  const [minimum, maximum] = range
  return minimum !== undefined && maximum !== undefined && minimum < maximum
}, 'score range must increase')
const metadata = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))

/** Settings accepted from model tools and preserved in projection snapshots. */
export const presentationHintsSchema = z.object({
  layout: z.enum(['split-panel', 'diff-view', 'matrix', 'grouped-list', 'timeline', 'custom']).optional(),
  capabilities: z.object({
    grouping: z.object({ enabled: z.boolean(), groupBy: z.string(), pattern: z.string().optional() }).optional(),
    scoring: z.object({ enabled: z.boolean(), target: z.string(), label: z.string(), range: scoreRange }).optional(),
    commenting: z.object({ enabled: z.boolean() }).optional(),
    tagging: z.object({ enabled: z.boolean(), allowedTags: z.array(z.string()).optional() }).optional(),
    deciding: z.object({ enabled: z.boolean(), actions: z.array(actions).optional() }).optional(),
    exporting: z.object({ enabled: z.boolean(), formats: z.array(z.enum(['csv', 'json', 'html', 'markdown', 'modified-document'])) }).optional(),
    visualizing: z.object({ enabled: z.boolean(), type: z.enum(['chart', 'heatmap', 'matrix', 'timeline', 'distribution']).optional() }).optional(),
    comparing: z.object({ enabled: z.boolean() }).optional(),
    tracking: z.object({ enabled: z.boolean() }).optional(),
    collaboration: z.object({ enabled: z.boolean() }).optional(),
  }).optional(),
  allowedActions: z.array(z.enum(['accept', 'reject', 'undo', 'comment', 'score', 'shortlist', 'compare'])).optional(),
  groupBy: z.string().optional(),
  scoring: z.object({ enabled: z.boolean(), field: z.string(), label: z.string(), range: scoreRange }).optional(),
  visualization: z.enum(['severity-distribution', 'score-chart', 'heatmap', 'timeline', 'comparison-matrix']).optional(),
  exportFormats: z.array(z.enum(['modified-document', 'score-sheet', 'comparison-report', 'summary-pdf', 'findings-matrix'])).optional(),
  userGoals: z.array(z.string()).optional(),
  custom: metadata.optional(),
})

/**
 * Resolve presentation settings into the capability model consumed by every client layout.
 * Baseline workflow operations remain available when an older session or a model-authored write
 * omits capability settings; scenario-specific scoring and grouping are upgraded from legacy hints.
 * @param hints - Stored or model-authored presentation settings.
 * @param findings - Findings used to determine whether document decisions are meaningful.
 * @returns Presentation settings with a complete baseline capability configuration.
 */
export function resolvePresentationHints(
  hints: PresentationHints | undefined,
  findings: readonly AuditFinding[] = [],
): PresentationHints {
  const legacyScoring = hints?.scoring
  const capabilities: CapabilityConfig = {
    commenting: { enabled: true },
    tagging: { enabled: true },
    tracking: { enabled: true },
    collaboration: { enabled: true },
    exporting: { enabled: true, formats: ['csv', 'json', 'html', 'markdown'] },
    deciding: { enabled: findings.some(finding => finding.replacement !== undefined), actions: ['accept', 'reject', 'undo'] },
    ...(hints?.groupBy !== undefined ? { grouping: { enabled: true, groupBy: hints.groupBy } } : {}),
    ...(legacyScoring?.enabled === true ? { scoring: {
      enabled: true,
      target: legacyScoring.field,
      label: legacyScoring.label,
      range: legacyScoring.range,
    } } : {}),
    ...hints?.capabilities,
  }
  return { ...hints, capabilities }
}
