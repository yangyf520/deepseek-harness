/**
 * Local hybrid knowledge provider (`ctx.knowledge`).
 * @module @deepseek-ai/dsh-knowledge/provider
 */

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parse } from 'csv-parse/sync'
import { parse as parseHtml } from 'node-html-parser'
import mammoth from 'mammoth'
import Turndown from 'turndown'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CollectionId,
  Knowledge,
  KnowledgeError,
  KnowledgeNormalizerRegistry,
} from './types.ts'
import type {
  ChunkMetadata,
  CollectionSummary,
  DocumentChunkSummary,
  DocumentNormalizer,
  DocumentSummary,
  IngestError,
  IngestProgress,
  IngestRequest,
  IngestResult,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
  NormalizeInput,
  NormalizeOutput,
  StageDocumentRequest,
  StageDocumentResult,
  StagingDocumentSummary,
} from './types.ts'
import {
  chunkDocument,
  chunkQualityScore,
  detectLang,
  runSearch,
  hashEmbedding,
  httpEmbed,
  CollectionStore,
  readManifest,
  writeManifest,
  parseYamlFrontmatter,
  loadSidecarMeta,
  mergeIngestMeta,
  matchLabelFilters,
  chunkRetrievable,
  resolveChunkPolicyFromUris,
  localEmbed,
  indexDbPath,
  type ChunkDraft,
  type SearchRuntimeConfig,
} from './store.ts'

const require = createRequire(import.meta.url)
const pdf = require('pdf-parse') as (data: Buffer) => Promise<{ text: string; numpages: number }>
const turndown = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

/**
 * Drop inline `data:` image payloads that mammoth/HTML leave in markdown —
 * otherwise chunking splits multi-hundred-KB base64 into non-prose "child" rows.
 */
export function stripEmbeddedDataImages(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*]\(data:[^)]+\)/gi, '[image]')
    .replace(/data:image\/[a-z0-9./+-]+;base64,[a-z0-9+/=]+(?:\s+[a-z0-9+/=]+)*/gi, '')
}

/** Mammoth image handler: keep a text placeholder, never inline base64. */
const DOCX_IMAGE_PLACEHOLDER = mammoth.images.imgElement(async () => ({
  src: '',
  alt: 'image',
}))

/** Extensions ingest accepts when a normalizer registry is mounted. */
export const BINARY_INGEST_EXTENSIONS = ['.pdf', '.docx', '.html', '.htm'] as const

export const pdfNormalizer: DocumentNormalizer = {
  id: 'pdf',
  match(uri) {
    return uri.toLowerCase().endsWith('.pdf')
  },
  async normalize(input: NormalizeInput): Promise<NormalizeOutput> {
    const parsed = await pdf(input.data)
    const text = parsed.text.trim()
    if (text.length === 0) {
      throw new Error('pdf has no extractable text layer (scan-only PDF needs OCR plugin)')
    }
    const pages = text.split('\f').map(page => page.trim()).filter(page => page.length > 0)
    const markdown = pages.length > 1
      ? pages.map((page, index) => `## Page ${index + 1}\n\n${page}`).join('\n\n')
      : text
    return { markdown, labels: { pages: String(parsed.numpages) } }
  },
}

export const docxNormalizer: DocumentNormalizer = {
  id: 'docx',
  match(uri) {
    return uri.toLowerCase().endsWith('.docx')
  },
  async normalize(input: NormalizeInput): Promise<NormalizeOutput> {
    const result = await mammoth.convertToHtml(
      { buffer: input.data },
      { convertImage: DOCX_IMAGE_PLACEHOLDER },
    )
    const markdown = stripEmbeddedDataImages(turndown.turndown(result.value))
    if (markdown.trim().length === 0) {
      throw new Error('docx produced empty text (unsupported layout or scan-only content)')
    }
    return { markdown }
  },
}

export const htmlNormalizer: DocumentNormalizer = {
  id: 'html',
  match(uri) {
    const lower = uri.toLowerCase()
    return lower.endsWith('.html') || lower.endsWith('.htm')
  },
  async normalize(input: NormalizeInput): Promise<NormalizeOutput> {
    const html = input.data.toString('utf8')
    const root = parseHtml(html)
    const title = root.querySelector('title')?.text.trim()
    const body = root.querySelector('body')?.innerHTML ?? html
    const markdown = stripEmbeddedDataImages(turndown.turndown(body))
    return {
      markdown,
      ...(title !== undefined && title.length > 0 ? { title } : {}),
    }
  },
}

const NORMALIZERS = [pdfNormalizer, docxNormalizer, htmlNormalizer]

/** Split a CSV body into rows of cells (RFC 4180 via csv-parse). */
export function parseCsv(text: string): string[][] {
  const rows = parse(text.replace(/^\uFEFF/, ''), {
    relax_column_count: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as string[][]
  return rows.filter(row => row.some(cell => cell.trim().length > 0))
}

function csvCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

/** Render CSV rows as one markdown table. */
export function csvToMarkdownTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map(row => row.length))
  const padded = rows.map(row => Array.from({ length: width }, (_, i) => csvCell(row[i] ?? '')))
  const header = padded[0]
  if (header === undefined) return ''
  const sep = header.map(() => '---')
  const body = padded.slice(1)
  return [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}

/** Render each CSV data row as a heading plus field list (one chunk per row after split). */
export function csvToFaqMarkdown(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return ''
  const header = rows[0]
  if (header === undefined) return ''
  const data = rows.slice(1)
  if (data.length === 0) return csvToMarkdownTable(rows)
  return data.map((row, index) => {
    const title = (row[0] ?? '').trim() || `Row ${index + 1}`
    const lines = header.map((name, col) => `- ${name.trim() || `col${col + 1}`}: ${(row[col] ?? '').trim()}`)
    return `## ${title}\n\n${lines.join('\n')}`
  }).join('\n\n')
}

/** Normalize CSV text as a markdown table (default) or FAQ rows. */
export function csvToMarkdown(text: string, mode: 'table' | 'faq-row' = 'table'): string {
  const rows = parseCsv(text)
  return mode === 'faq-row' ? csvToFaqMarkdown(rows) : csvToMarkdownTable(rows)
}

/**
 * Register built-in PDF/DOCX/HTML normalizers when the registry is mounted.
 * Uses non-strict get so registration works during provider construction
 * (fiber is still LOADING; strict get would miss a same-fiber provide).
 * @returns disposer that unregisters every normalizer this call added
 */
export function registerBornDigitalNormalizers(ctx: Context): () => void {
  const registry = ctx.get('knowledgeNormalizers', false)
  if (registry === undefined) return () => undefined
  const disposers = NORMALIZERS.map(normalizer => registry.register(normalizer))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

interface NormalizedDocument {
  readonly body: string
  readonly title?: string
  readonly labels?: Readonly<Record<string, string>>
}

async function readNormalizedDocument(ctx: Context, uri: string): Promise<NormalizedDocument> {
  const data = readFileSync(uri)
  const registry = ctx.get('knowledgeNormalizers') as KnowledgeNormalizerRegistry | undefined
  if (registry === undefined) {
    const lower = uri.toLowerCase()
    if (!lower.endsWith('.md') && !lower.endsWith('.txt') && !lower.endsWith('.markdown')) {
      throw new KnowledgeError(`no normalizer for ${uri}`, 'KNOWLEDGE_NORMALIZE_FAILED')
    }
    return { body: data.toString('utf8') }
  }
  try {
    const normalizer = registry.resolveOrPassthrough(uri)
    const out = await normalizer.normalize({ uri, data })
    return {
      body: out.markdown,
      ...(out.title !== undefined ? { title: out.title } : {}),
      ...(out.labels !== undefined ? { labels: out.labels } : {}),
    }
  } catch (error) {
    throw new KnowledgeError(
      error instanceof Error ? error.message : String(error),
      'KNOWLEDGE_NORMALIZE_FAILED',
      error instanceof Error ? { cause: error } : undefined,
    )
  }
}

/** Deployment knobs: index root and embedding backend only. */
export interface Config {
  root?: string
  embeddingProvider?: 'hash' | 'http' | 'local'
  embeddingModel?: string
  embeddingApiKeyEnv?: string
  embeddingBaseUrl?: string
  localEmbeddingModel?: string
  localModelCacheDir?: string
}

const DEFAULT_ROOT = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh'), 'knowledge')
const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2'
const HARDCODED = {
  hybrid: true,
  recallTopK: 50,
  searchTopK: 8,
  confidenceHighThreshold: 0.75,
  confidenceLowThreshold: 0.45,
  chunkQualityMinScore: 0.2,
  embeddingDedupeEnabled: true,
}

type ResolvedConfig = Required<Pick<Config,
  | 'root'
  | 'embeddingProvider'
  | 'embeddingModel'
  | 'embeddingApiKeyEnv'
  | 'embeddingBaseUrl'
  | 'localEmbeddingModel'
>> & Config

/**
 * Filesystem-backed hybrid index: SQLite FTS5 + dense vectors + RRF.
 */
export class LocalKnowledge extends Knowledge {
  static Config: z<Config> = z.object({
    root: z.string().default(DEFAULT_ROOT),
    embeddingProvider: z.union(['hash', 'http', 'local'] as const).default('hash'),
    embeddingModel: z.string().default('text-embedding-v3'),
    embeddingApiKeyEnv: z.string().default('DASHSCOPE_API_KEY'),
    embeddingBaseUrl: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    localEmbeddingModel: z.string().default(DEFAULT_LOCAL_MODEL),
    localModelCacheDir: z.string(),
  })

  readonly config: ResolvedConfig
  private readonly stores = new Map<string, CollectionStore>()
  private ingestProgress: IngestProgress = { phase: 'idle', done: 0, total: 0 }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    // Provider owns the normalizer registry: no separate cordis entry / re-export shim.
    // Non-strict get: fiber is LOADING during class-plugin construction.
    const registry = ctx.get('knowledgeNormalizers', false) ?? new KnowledgeNormalizerRegistry(ctx)
    this.config = LocalKnowledge.Config(config) as ResolvedConfig
    mkdirSync(this.collectionsRoot(), { recursive: true })
    // Own registrations on this provider fiber so they outlive construction.
    ctx.effect(() => {
      const disposers = NORMALIZERS.map(normalizer => registry.register(normalizer))
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    }, 'knowledge: born-digital normalizers')
  }

  private collectionsRoot(): string {
    return join(this.config.root, 'collections')
  }

  private collectionDir(id: CollectionId): string {
    return join(this.collectionsRoot(), id as string)
  }

  private stagingDir(id: CollectionId): string {
    return join(this.collectionDir(id), 'staging')
  }

  private auditPath(): string {
    return join(this.config.root, 'audit.jsonl')
  }

  private embeddingBackend(): 'hash' | 'http' | 'local' {
    return this.config.embeddingProvider
  }

  private embeddingGenerationKey(): string {
    const backend = this.embeddingBackend()
    if (backend === 'hash') return 'hash'
    if (backend === 'local') return `local:${this.config.localEmbeddingModel}`
    return this.config.embeddingModel
  }

  private stampEmbeddingGeneration(collectionId: CollectionId, overwrite: boolean): void {
    const dir = this.collectionDir(collectionId)
    const manifest = readManifest(dir)
    if (!overwrite && manifest.embeddingGeneration !== undefined) return
    writeManifest(dir, { ...manifest, embeddingGeneration: this.embeddingGenerationKey() })
  }

  private async loadDocument(_collectionId: CollectionId, uri: string): Promise<NormalizedDocument> {
    if (uri.toLowerCase().endsWith('.csv')) {
      return { body: csvToMarkdown(readFileSync(uri, 'utf8'), 'table') }
    }
    return readNormalizedDocument(this.ctx, uri)
  }

  private emitAudit(action: string, outcome: 'ok' | 'failed', detail: Record<string, unknown>): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      actor: 'cli',
      outcome,
      detail,
    })
    appendFileSync(this.auditPath(), `${line}\n`, 'utf8')
  }

  private chunkVisible(metadata: ChunkMetadata): boolean {
    return chunkRetrievable(metadata)
  }

  private applyMatchFilters(metadata: ChunkMetadata, filters: Readonly<Record<string, unknown>>): boolean {
    try {
      return matchLabelFilters(metadata.labels ?? {}, filters)
    } catch (error) {
      throw new KnowledgeError(
        error instanceof Error ? error.message : String(error),
        'KNOWLEDGE_INVALID_FILTER',
        error instanceof Error ? { cause: error } : undefined,
      )
    }
  }

  private sampleUris(collectionId: CollectionId): string[] {
    const store = this.openStore(collectionId)
    const staging = this.stagingDir(collectionId)
    return [
      ...store.listUris().map(row => row.uri),
      ...readdirSync(staging, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => join(staging, entry.name)),
    ]
  }

  private async ensureChunkPolicy(collectionId: CollectionId): Promise<void> {
    const dir = this.collectionDir(collectionId)
    const manifest = readManifest(dir)
    if (manifest.chunkPolicy?.resolved !== undefined) return
    const resolved = resolveChunkPolicyFromUris(this.sampleUris(collectionId))
    writeManifest(dir, {
      ...manifest,
      chunkPolicy: { ...manifest.chunkPolicy, resolved },
    })
  }

  private openStore(id: CollectionId, generation?: number): CollectionStore {
    const gen = generation ?? this.activeGeneration(id)
    const key = `${id as string}:${gen}`
    let store = this.stores.get(key)
    if (!store) {
      store = new CollectionStore(this.resolveIndexDbPath(id, gen))
      this.stores.set(key, store)
    }
    return store
  }

  private activeGeneration(id: CollectionId): number {
    return this.loadManifest(id).activeGeneration ?? 1
  }

  private resolveIndexDbPath(id: CollectionId, generation: number): string {
    const dir = this.collectionDir(id)
    const genPath = indexDbPath(dir, generation)
    const legacyPath = join(dir, 'index.sqlite')
    if (existsSync(genPath)) return genPath
    if (generation === 1 && existsSync(legacyPath)) return legacyPath
    mkdirSync(dirname(genPath), { recursive: true })
    return genPath
  }

  private clearStoreCache(id: CollectionId): void {
    const prefix = `${id as string}:`
    for (const key of [...this.stores.keys()]) {
      if (!key.startsWith(prefix)) continue
      this.stores.get(key)?.close()
      this.stores.delete(key)
    }
  }

  private loadManifest(id: CollectionId): ReturnType<typeof readManifest> {
    try {
      return readManifest(this.collectionDir(id))
    } catch {
      throw new KnowledgeError(`collection not found: ${id as string}`, 'KNOWLEDGE_COLLECTION_NOT_FOUND')
    }
  }

  private baseSearchConfig(): SearchRuntimeConfig {
    return {
      hybrid: HARDCODED.hybrid,
      recallTopK: HARDCODED.recallTopK,
      searchTopK: HARDCODED.searchTopK,
      confidenceHighThreshold: HARDCODED.confidenceHighThreshold,
      confidenceLowThreshold: HARDCODED.confidenceLowThreshold,
    }
  }

  private searchStores(): Map<string, CollectionStore> {
    const out = new Map<string, CollectionStore>()
    for (const entry of readdirSync(this.collectionsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      out.set(entry.name, this.openStore(CollectionId(entry.name)))
    }
    return out
  }

  async listCollections(_signal?: AbortSignal): Promise<readonly CollectionSummary[]> {
    const entries = readdirSync(this.collectionsRoot(), { withFileTypes: true })
    const out: CollectionSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = CollectionId(entry.name)
      try {
        const manifest = this.loadManifest(id)
        const store = this.openStore(id)
        out.push({
          id,
          title: manifest.title,
          ...(manifest.description !== undefined ? { description: manifest.description } : {}),
          docCount: store.docCount(),
        })
      } catch {
        // skip incomplete dirs
      }
    }
    return out
  }

  async createCollection(id: CollectionId, title?: string): Promise<void> {
    const dir = this.collectionDir(id)
    mkdirSync(dir, { recursive: true })
    mkdirSync(this.stagingDir(id), { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      id,
      title: title ?? id,
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
    }, null, 2))
    this.openStore(id)
    this.emitAudit('createCollection', 'ok', { collectionId: id as string })
  }

  async listDocuments(collectionId: CollectionId, _signal?: AbortSignal): Promise<readonly DocumentSummary[]> {
    this.loadManifest(collectionId)
    return this.openStore(collectionId).listUris()
  }

  async listDocumentChunks(
    collectionId: CollectionId,
    uri: string,
    _signal?: AbortSignal,
  ): Promise<readonly DocumentChunkSummary[]> {
    this.loadManifest(collectionId)
    const store = this.openStore(collectionId)
    if (!store.uriExists(uri)) {
      throw new KnowledgeError(`document not found: ${uri}`, 'KNOWLEDGE_DOCUMENT_NOT_FOUND')
    }
    return store.listByUri(uri).map(chunk => ({
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      source: chunk.source,
      ...(chunk.metadata.role !== undefined ? { role: chunk.metadata.role } : {}),
    }))
  }

  async deleteDocument(collectionId: CollectionId, uri: string): Promise<void> {
    this.loadManifest(collectionId)
    const removed = this.openStore(collectionId).deleteUri(uri)
    const stagingRoot = resolve(this.stagingDir(collectionId))
    const target = resolve(uri)
    const rel = relative(stagingRoot, target)
    let stagingRemoved = false
    if (
      rel !== ''
      && !rel.startsWith(`..${sep}`)
      && rel !== '..'
      && existsSync(target)
      && statSync(target).isFile()
    ) {
      unlinkSync(target)
      stagingRemoved = true
    }
    if (removed === 0 && !stagingRemoved) {
      this.emitAudit('deleteDocument', 'failed', { collectionId: collectionId as string, uri })
      throw new KnowledgeError(`document not found: ${uri}`, 'KNOWLEDGE_DOCUMENT_NOT_FOUND')
    }
    this.emitAudit('deleteDocument', 'ok', {
      collectionId: collectionId as string,
      uri,
      chunks: removed,
      ...(stagingRemoved ? { stagingRemoved: true } : {}),
    })
  }

  async deleteCollection(id: CollectionId): Promise<void> {
    this.loadManifest(id)
    this.clearStoreCache(id)
    rmSync(this.collectionDir(id), { recursive: true, force: true })
    this.emitAudit('deleteCollection', 'ok', { collectionId: id as string })
  }

  async stageDocument(request: StageDocumentRequest): Promise<StageDocumentResult> {
    this.loadManifest(request.collectionId)
    const src = resolve(request.path)
    const staging = this.stagingDir(request.collectionId)
    mkdirSync(staging, { recursive: true })
    const dest = join(staging, basename(src))
    copyFileSync(src, dest)
    return { stagingUri: dest }
  }

  async listStaging(
    collectionId: CollectionId,
    _signal?: AbortSignal,
  ): Promise<readonly StagingDocumentSummary[]> {
    this.loadManifest(collectionId)
    const staging = this.stagingDir(collectionId)
    mkdirSync(staging, { recursive: true })
    const indexed = new Set(this.openStore(collectionId).listUris().map(row => row.uri))
    return readdirSync(staging, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map((entry): StagingDocumentSummary => {
        const uri = join(staging, entry.name)
        const st = statSync(uri)
        const created = st.birthtimeMs > 0 ? st.birthtime : st.mtime
        return { uri, createdAt: created.toISOString() }
      })
      .filter(row => !indexed.has(row.uri))
      .sort((a, b) => a.uri.localeCompare(b.uri))
  }

  getIngestProgress(): IngestProgress {
    return this.ingestProgress
  }

  private setIngestProgress(next: IngestProgress): void {
    this.ingestProgress = next
  }

  async ingest(request: IngestRequest): Promise<IngestResult> {
    this.loadManifest(request.collectionId)
    if (request.dryRun !== true) {
      await this.ensureChunkPolicy(request.collectionId)
    }
    const uris = request.uri !== undefined
      ? [resolve(request.uri)]
      : (request.paths ?? []).flatMap(path => this.walkFiles(path))
    if (uris.length === 0) {
      throw new KnowledgeError('ingest requires uri or paths', 'KNOWLEDGE_INGEST_FAILED')
    }

    let filesProcessed = 0
    let chunksWritten = 0
    let skipped = 0
    const errors: IngestError[] = []

    for (const file of uris) {
      filesProcessed++
      try {
        if (request.dryRun) {
          await this.planIngest(request.collectionId, file, request.signal)
          continue
        }
        const written = await this.ingestUri(request.collectionId, file, request.signal, {
          ...(request.applyChunkSuggestion ? { applyChunkSuggestion: true } : {}),
          ...(request.forceReingest ? { forceReingest: true } : {}),
        })
        if (written === 'skipped') skipped++
        else chunksWritten += written
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.setIngestProgress({
          phase: 'error',
          uri: file,
          done: 0,
          total: 0,
          message,
        })
        errors.push({
          uri: file,
          code: error instanceof KnowledgeError ? error.code : 'KNOWLEDGE_INGEST_FAILED',
          message,
        })
      }
    }
    this.emitAudit('ingest', errors.length > 0 ? 'failed' : 'ok', {
      collectionId: request.collectionId as string,
      filesProcessed,
      chunksWritten,
      skipped,
      errorCount: errors.length,
      ...(errors[0] !== undefined ? { error: errors[0].message } : {}),
    })
    if (errors.length === 0) {
      this.setIngestProgress({ phase: 'done', done: 1, total: 1 })
    }
    return { filesProcessed, chunksWritten, skipped, errors }
  }

  private async ingestUri(
    collectionId: CollectionId,
    uri: string,
    signal?: AbortSignal,
    opts?: { applyChunkSuggestion?: boolean; forceReingest?: boolean },
  ): Promise<number | 'skipped'> {
    const store = this.openStore(collectionId)
    this.setIngestProgress({ phase: 'normalize', uri, done: 0, total: 1, message: '解析文档…' })
    const normalized = await this.loadDocument(collectionId, uri)
    const contentHash = createHash('sha256').update(normalized.body).digest('hex')
    const targetUri = uri
    if (opts?.forceReingest !== true && store.shouldSkipUri(targetUri, contentHash)) {
      this.setIngestProgress({ phase: 'done', uri, done: 1, total: 1, message: '内容未变，已跳过' })
      return 'skipped'
    }
    this.setIngestProgress({ phase: 'chunk', uri, done: 0, total: 1, message: '分块…' })
    const { drafts } = await this.planIngest(
      collectionId,
      targetUri,
      signal,
      normalized,
      opts?.applyChunkSuggestion === true,
    )
    this.setIngestProgress({
      phase: 'embed',
      uri,
      done: 0,
      total: drafts.filter(d => d.role !== 'parent').length,
      message: '生成向量…',
    })
    const embeddings = await this.embedDrafts(drafts, signal, (done, total) => {
      this.setIngestProgress({
        phase: 'embed',
        uri,
        done,
        total,
        message: `生成向量 ${done}/${total}`,
      })
    })
    this.setIngestProgress({ phase: 'write', uri, done: 0, total: 1, message: '写入索引…' })
    const written = store.replaceUri(collectionId, targetUri, drafts, embeddings)
    store.setUriHash(targetUri, contentHash)
    this.stampEmbeddingGeneration(collectionId, false)
    this.setIngestProgress({
      phase: 'done',
      uri,
      done: 1,
      total: 1,
      message: `已写入 ${written} 块`,
    })
    return written
  }

  private async planIngest(
    collectionId: CollectionId,
    uri: string,
    signal?: AbortSignal,
    preNormalized?: Awaited<ReturnType<typeof readNormalizedDocument>>,
    applyChunkSuggestion = false,
  ): Promise<{ drafts: ChunkDraft[]; skippedQuality: number }> {
    this.loadManifest(collectionId)
    const raw = preNormalized ?? await this.loadDocument(collectionId, uri)
    const frontmatter = parseYamlFrontmatter(raw.body)
    const docMeta = mergeIngestMeta(
      loadSidecarMeta(uri),
      frontmatter.meta,
      raw.labels !== undefined ? { labels: raw.labels } : undefined,
    )
    const normalized = {
      ...raw,
      body: frontmatter.body,
      labels: { ...(docMeta.labels ?? {}), ...(raw.labels ?? {}) },
    }
    const lang = detectLang(normalized.body)
    const labels: Record<string, string> = { lang, ...(normalized.labels ?? {}) }
    const title = normalized.title ?? labels.title
    const manifest = readManifest(this.collectionDir(collectionId))
    const targetTokens = applyChunkSuggestion
      ? manifest.chunkPolicy?.suggestion?.targetTokens
      : manifest.chunkPolicy?.resolved?.targetTokens
    const maxChunkChars = targetTokens !== undefined ? Math.max(256, targetTokens * 4) : undefined
    let drafts = chunkDocument(uri, normalized.body, {
      ...(title !== undefined ? { title } : {}),
      labels,
      docMeta,
      ...(maxChunkChars !== undefined ? { maxChunkChars } : {}),
    })
    const minQuality = HARDCODED.chunkQualityMinScore
    let skippedQuality = 0
    drafts = drafts.filter((draft) => {
      if (draft.role === 'parent') return true
      const score = chunkQualityScore(draft.text)
      if (score < minQuality) {
        skippedQuality++
        return false
      }
      return true
    })
    void signal
    void collectionId
    return { drafts, skippedQuality }
  }

  private walkFiles(path: string): string[] {
    const abs = resolve(path)
    const stat = statSync(abs)
    if (stat.isFile()) return this.isIngestible(abs) ? [abs] : []
    const out: string[] = []
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      out.push(...this.walkFiles(join(abs, entry.name)))
    }
    return out
  }

  private isIngestible(path: string): boolean {
    const lower = path.toLowerCase()
    if (
      lower.endsWith('.md')
      || lower.endsWith('.txt')
      || lower.endsWith('.markdown')
      || lower.endsWith('.csv')
    ) return true
    if (this.ctx.get('knowledgeNormalizers') === undefined) return false
    return BINARY_INGEST_EXTENSIONS.some(ext => lower.endsWith(ext))
  }

  private async embedDrafts(
    drafts: readonly ChunkDraft[],
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<(Float32Array | undefined)[]> {
    const dedupe = HARDCODED.embeddingDedupeEnabled
    const cache = new Map<string, Float32Array>()
    const out: (Float32Array | undefined)[] = drafts.map(() => undefined)
    const toEmbed: string[] = []
    const indexMap: number[] = []

    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i]
      if (draft === undefined || draft.role === 'parent') continue
      const key = createHash('sha256').update(draft.text).digest('hex')
      if (dedupe && cache.has(key)) {
        out[i] = cache.get(key)
        continue
      }
      indexMap.push(i)
      toEmbed.push(draft.text)
    }

    const total = drafts.filter(draft => draft.role !== 'parent').length
    const done = total - toEmbed.length
    onProgress?.(done, total)

    const vectors = await this.embedTexts(toEmbed, signal, (batchDone) => {
      onProgress?.(done + batchDone, total)
    })
    for (let j = 0; j < indexMap.length; j++) {
      const index = indexMap[j]
      const vec = vectors[j]
      if (index === undefined || vec === undefined) continue
      out[index] = vec
      if (dedupe) {
        const draft = drafts[index]
        if (draft === undefined) continue
        cache.set(createHash('sha256').update(draft.text).digest('hex'), vec)
      }
    }
    onProgress?.(total, total)
    return out
  }

  private async embedTexts(
    texts: readonly string[],
    signal?: AbortSignal,
    onBatch?: (done: number) => void,
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const backend = this.embeddingBackend()
    const batchSize = backend === 'http' ? 32 : backend === 'local' ? 1 : 64
    const out: Float32Array[] = []
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize)
      if (backend === 'hash') {
        out.push(...batch.map(text => hashEmbedding(text)))
      } else if (backend === 'local') {
        void signal
        const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh')
        const cacheDir = this.config.localModelCacheDir ?? join(home, 'models')
        out.push(...await localEmbed(this.config.localEmbeddingModel, cacheDir, batch))
      } else {
        out.push(...await httpEmbed(this.ctx, {
          model: this.config.embeddingModel,
          apiKeyEnv: this.config.embeddingApiKeyEnv,
          baseUrl: this.config.embeddingBaseUrl,
        }, batch, signal))
      }
      onBatch?.(out.length)
      // Yield so a concurrent getIngestProgress poll can observe mid-embed progress.
      await Promise.resolve()
    }
    return out
  }

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult> {
    const collections = request.collection
      ? [request.collection]
      : (await this.listCollections()).map(c => c.id)
    if (collections.length === 0) {
      return { hits: [], insufficientEvidence: true }
    }
    return runSearch(
      {
        embedQuery: texts => this.embedTexts(texts, request.signal),
        chunkVisible: metadata => this.chunkVisible(metadata),
        matchFilters: (metadata, filters) => this.applyMatchFilters(metadata, filters),
      },
      this.baseSearchConfig(),
      this.searchStores(),
      collections,
      request,
    )
  }

}

export default LocalKnowledge
