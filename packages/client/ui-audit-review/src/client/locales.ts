/** Locale dictionaries for audit review UI. */

/** Dictionary shape. */
export interface AuditKey {
  'overview.title': string
  'overview.findings': string
  'overview.more': string
  'overview.openReview': string
  'overview.download': string
  'severity.high': string
  'severity.medium': string
  'severity.low': string
  'finding.original': string
  'finding.suggestion': string
  'action.accept': string
  'action.reject': string
  'action.apply': string
  'status.accepted': string
  'status.rejected': string
}

/** Chinese dictionary. */
export const zh: AuditKey = {
  'overview.title': '文档审计',
  'overview.findings': '条发现',
  'overview.more': '更多发现',
  'overview.openReview': '打开审查',
  'overview.download': '下载文档',
  'severity.high': '高风险',
  'severity.medium': '中风险',
  'severity.low': '低风险',
  'finding.original': '原文',
  'finding.suggestion': '建议替换',
  'action.accept': '接受',
  'action.reject': '拒绝',
  'action.apply': '应用',
  'status.accepted': '已接受',
  'status.rejected': '已拒绝',
}

/** English dictionary. */
export const en: AuditKey = {
  'overview.title': 'Document Audit',
  'overview.findings': 'findings',
  'overview.more': 'more findings',
  'overview.openReview': 'Open Review',
  'overview.download': 'Download',
  'severity.high': 'High',
  'severity.medium': 'Medium',
  'severity.low': 'Low',
  'finding.original': 'Original',
  'finding.suggestion': 'Suggested replacement',
  'action.accept': 'Accept',
  'action.reject': 'Reject',
  'action.apply': 'Apply',
  'status.accepted': 'Accepted',
  'status.rejected': 'Rejected',
}
