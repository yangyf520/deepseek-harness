/** Locale dictionaries for audit review UI. */

/** Chinese dictionary (the key-set source of truth). */
export const zh = {
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
  'finding.delete': '删除该行',
  'finding.basis': '依据',
  'finding.basisView': '查看条文',
  'finding.basisHide': '收起条文',
  'finding.basisLoading': '加载中…',
  'finding.basisMissing': '知识库未收录该条正文',
  'preview.unlocated': '预览中未定位到该引文',
  'action.accept': '接受',
  'action.reject': '拒绝',
  'action.undo': '撤销',
  'action.withdraw': '撤回',
  'status.accepted': '已接受',
  'status.rejected': '已拒绝',
} satisfies Record<string, string>

/** The audit namespace key union. */
export type AuditKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
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
  'finding.delete': 'Delete this line',
  'finding.basis': 'Basis',
  'finding.basisView': 'View provision',
  'finding.basisHide': 'Hide provision',
  'finding.basisLoading': 'Loading…',
  'finding.basisMissing': 'The workspace wiki does not carry this provision',
  'preview.unlocated': 'The quote was not located in this preview',
  'action.accept': 'Accept',
  'action.reject': 'Reject',
  'action.undo': 'Undo',
  'action.withdraw': 'Withdraw',
  'status.accepted': 'Accepted',
  'status.rejected': 'Rejected',
} satisfies Record<AuditKey, string>
