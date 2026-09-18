/** Locale-owned Word implementation name and iframe status text. */
export const zh = {
  title: 'Word',
  frame: 'Word 文档预览',
  loading: '正在准备 Word 预览…',
  failed: '无法预览这份 Word 文档。',
} satisfies Record<string, string>

/** Word renderer dictionary keys. */
export type DocxPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Word',
  frame: 'Word document preview',
  loading: 'Preparing Word preview…',
  failed: 'This Word document could not be previewed.',
} satisfies Record<DocxPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Word preview selection and status text. */
    documentDocx: DocxPreviewKey
  }
}
