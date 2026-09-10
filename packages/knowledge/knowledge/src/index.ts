/**
 * Knowledge capability: seam types, local SQLite provider, and default export for cordis mount.
 * @module @deepseek-ai/dsh-knowledge
 */

export * from './types.ts'
export {
  BINARY_INGEST_EXTENSIONS,
  pdfNormalizer,
  docxNormalizer,
  htmlNormalizer,
  parseCsv,
  csvToMarkdownTable,
  csvToFaqMarkdown,
  csvToMarkdown,
  registerBornDigitalNormalizers,
  stripEmbeddedDataImages,
  LocalKnowledge,
} from './provider.ts'
export type { Config, Config as LocalKnowledgeConfig } from './provider.ts'
export { default } from './provider.ts'
