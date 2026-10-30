/** Deterministic scalar conversion for document extraction; missing or invalid values stay unknown. */
import type { AuditMetadataValue } from './types.ts'

/**
 * Convert a matched field without manufacturing zeroes or truthy strings.
 * @param raw - Captured text, absent when the rule did not match.
 * @param type - Requested scalar type.
 * @returns The parsed value, or null when absent or invalid.
 */
export function extractField(raw: string | undefined, type: 'string' | 'number' | 'boolean'): AuditMetadataValue {
  if (raw === undefined || raw.trim() === '') return null
  if (type === 'string') return raw
  if (type === 'number') {
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  switch (raw.trim().toLowerCase()) {
    case 'true': case '1': case 'yes': case '是': return true
    case 'false': case '0': case 'no': case '否': return false
    default: return null
  }
}
