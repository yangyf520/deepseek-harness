/**
 * SQLite store, chunking, and hybrid retrieval.
 * @module @deepseek-ai/dsh-knowledge/store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ChunkId, CollectionId } from './types.ts'
import type {
  KnowledgeConfidence,
  KnowledgeHit,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
  ChunkMetadata,
  KnowledgeSource,
} from './types.ts'

const DEFAULT_DIMS = 64

/** Hash-based embedding for tests and offline dev (no API key). */
export function hashEmbedding(text: string, dims = DEFAULT_DIMS): Float32Array {
  const out = new Float32Array(dims)
  for (let i = 0; i < dims; i++) {
    const digest = createHash('sha256').update(text).update('\0').update(String(i)).digest()
    out[i] = (digest.readUInt32BE(0) / 0xffff_ffff) * 2 - 1
  }
  let norm = 0
  for (let i = 0; i < out.length; i++) {
    const v = out[i] ?? 0
    norm += v * v
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) {
    out[i] = (out[i] ?? 0) / norm
  }
  return out
}

/** Serialize a float vector for SQLite storage. */
export function embeddingToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

/** Deserialize a stored embedding blob. */
export function blobToEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT)
}

/** Cosine similarity for L2-normalized vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

export interface HttpEmbedConfig {
  readonly model: string
  readonly apiKeyEnv: string
  readonly baseUrl: string
}

/** Embed strings via an OpenAI-compatible embeddings API. */
export async function httpEmbed(
  ctx: Context,
  config: HttpEmbedConfig,
  texts: readonly string[],
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const resolved = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv))
  const apiKey = resolved?.value
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`embedding API key not configured: ${config.apiKeyEnv}`)
  }
  const url = `${config.baseUrl.replace(/\/$/, '')}/embeddings`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: config.model, input: texts }),
    ...(signal !== undefined ? { signal } : {}),
  })
  if (!response.ok) {
    throw new Error(`embedding HTTP ${response.status}: ${await response.text()}`)
  }
  const body = await response.json() as { data: Array<{ embedding: number[] }> }
  return body.data.map((row) => {
    const vec = new Float32Array(row.embedding.length)
    for (let i = 0; i < row.embedding.length; i++) vec[i] = row.embedding[i] ?? 0
    return vec
  })
}

export interface StoredChunk {
  readonly chunkId: ChunkId
  readonly uri: string
  readonly chunkIndex: number
  readonly text: string
  readonly source: KnowledgeSource
  readonly metadata: ChunkMetadata
  readonly embedding: Float32Array | undefined
}

/** Monotonic on-disk schema version for collection indexes. */
export const SCHEMA_VERSION = 1

export class CollectionStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    const onDisk = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {
      this.db.close()
      throw new Error(
        `knowledge index at "${dbPath}" has schema version ${onDisk}, incompatible with this build (${SCHEMA_VERSION})`,
      )
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        uri TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB,
        metadata_json TEXT NOT NULL,
        source_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_uri ON chunks(uri);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, chunk_id UNINDEXED);
      CREATE TABLE IF NOT EXISTS uri_hashes (
        uri TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL
      );
    `)
    if (onDisk === 0) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  close(): void {
    this.db.close()
  }

  /** Skip ingest when file body hash is unchanged. */
  shouldSkipUri(uri: string, contentHash: string): boolean {
    const row = this.db.prepare('SELECT content_hash FROM uri_hashes WHERE uri = ?').get(uri) as { content_hash: string } | undefined
    return row?.content_hash === contentHash
  }

  /** Whether any chunk exists for a document uri. */
  uriExists(uri: string): boolean {
    const row = this.db.prepare('SELECT 1 AS n FROM chunks WHERE uri = ? LIMIT 1').get(uri) as { n: number } | undefined
    return row !== undefined
  }

  setUriHash(uri: string, contentHash: string): void {
    this.db.prepare(`
      INSERT INTO uri_hashes(uri, content_hash) VALUES (?, ?)
      ON CONFLICT(uri) DO UPDATE SET content_hash = excluded.content_hash
    `).run(uri, contentHash)
  }

  replaceUri(
    collectionId: CollectionId,
    uri: string,
    drafts: readonly ChunkDraft[],
    embeddings: readonly (Float32Array | undefined)[],
  ): number {
    const existing = this.db.prepare('SELECT chunk_id FROM chunks WHERE uri = ?').all(uri) as Array<{ chunk_id: string }>
    for (const row of existing) {
      this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(row.chunk_id)
    }
    this.db.prepare('DELETE FROM chunks WHERE uri = ?').run(uri)

    let written = 0
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks(chunk_id, uri, chunk_index, text, embedding, metadata_json, source_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = this.db.prepare('INSERT INTO chunks_fts(text, chunk_id) VALUES (?, ?)')

    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i]
      if (draft === undefined) continue
      const chunkId = makeChunkId(collectionId, uri, draft.chunkIndex, draft.text)
      const embedding = embeddings[i]
      insertChunk.run(
        chunkId,
        uri,
        draft.chunkIndex,
        draft.text,
        embedding ? embeddingToBlob(embedding) : null,
        JSON.stringify({
          ...draft.metadata,
          role: draft.role,
          ...(draft.parentChunkIndex !== undefined ? { parentChunkIndex: draft.parentChunkIndex } : {}),
        }),
        JSON.stringify(draft.source),
      )
      if (draft.role !== 'parent') {
        insertFts.run(draft.text, chunkId)
      }
      written++
    }
    return written
  }

  get(chunkId: ChunkId): StoredChunk | undefined {
    return this.rowToChunk(this.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get(chunkId) as Row | undefined)
  }

  getByUriAndIndex(uri: string, chunkIndex: number): StoredChunk | undefined {
    return this.rowToChunk(this.db.prepare('SELECT * FROM chunks WHERE uri = ? AND chunk_index = ?').get(uri, chunkIndex) as Row | undefined)
  }

  getSiblings(uri: string, chunkIndex: number, radius: number): StoredChunk[] {
    const rows = this.db.prepare(`
      SELECT * FROM chunks
      WHERE uri = ? AND chunk_index BETWEEN ? AND ?
      ORDER BY chunk_index
    `).all(uri, chunkIndex - radius, chunkIndex + radius) as unknown as Row[]
    return rows.flatMap((row) => {
      const chunk = this.rowToChunk(row)
      return chunk === undefined ? [] : [chunk]
    })
  }

  docCount(): number {
    const row = this.db.prepare('SELECT COUNT(DISTINCT uri) AS n FROM chunks').get() as { n: number }
    return row.n
  }

  chunkCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
    return row.n
  }

  deleteUri(uri: string): number {
    const existing = this.db.prepare('SELECT chunk_id FROM chunks WHERE uri = ?').all(uri) as Array<{ chunk_id: string }>
    for (const row of existing) {
      this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(row.chunk_id)
    }
    this.db.prepare('DELETE FROM chunks WHERE uri = ?').run(uri)
    this.db.prepare('DELETE FROM uri_hashes WHERE uri = ?').run(uri)
    return existing.length
  }

  listUris(): Array<{ uri: string; chunkCount: number; updatedAt?: string; labels?: Readonly<Record<string, string>> }> {
    const rows = this.db.prepare(`
      SELECT uri, COUNT(*) AS chunk_count,
        MAX(json_extract(metadata_json, '$.updatedAt')) AS updated_at
      FROM chunks
      GROUP BY uri
      ORDER BY uri
    `).all() as Array<{
      uri: string
      chunk_count: number
      updated_at: string | null
    }>
    return rows.map(row => ({
      uri: row.uri,
      chunkCount: row.chunk_count,
      ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    }))
  }

  /** All chunks for one document uri, ordered by chunk index. */
  listByUri(uri: string): StoredChunk[] {
    const rows = this.db.prepare('SELECT * FROM chunks WHERE uri = ? ORDER BY chunk_index').all(uri) as unknown as Row[]
    return rows.flatMap((row) => {
      const chunk = this.rowToChunk(row)
      return chunk === undefined ? [] : [chunk]
    })
  }

  searchLexical(query: string, limit: number): Array<{ chunkId: ChunkId; rank: number }> {
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter(token => token.length > 0)
      .map(token => `"${token.replaceAll('"', '')}"`)
      .join(' OR ')
    if (ftsQuery.length === 0) return []
    const rows = this.db.prepare(`
      SELECT chunk_id, bm25(chunks_fts) AS rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{ chunk_id: string; rank: number }>
    return rows.map(row => ({ chunkId: row.chunk_id as ChunkId, rank: -row.rank }))
  }

  searchVector(query: Float32Array, limit: number): Array<{ chunkId: ChunkId; score: number }> {
    const rows = this.db.prepare('SELECT chunk_id, embedding FROM chunks WHERE embedding IS NOT NULL').all() as Array<{
      chunk_id: string
      embedding: Buffer
    }>
    const scored = rows.map(row => ({
      chunkId: row.chunk_id as ChunkId,
      score: cosineSimilarity(query, blobToEmbedding(row.embedding)),
    }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  private rowToChunk(row: Row | undefined): StoredChunk | undefined {
    if (!row) return undefined
    return {
      chunkId: row.chunk_id as ChunkId,
      uri: row.uri,
      chunkIndex: row.chunk_index,
      text: row.text,
      metadata: JSON.parse(row.metadata_json) as ChunkMetadata,
      source: JSON.parse(row.source_json) as KnowledgeSource,
      embedding: row.embedding ? blobToEmbedding(row.embedding) : undefined,
    }
  }
}

interface Row {
  chunk_id: string
  uri: string
  chunk_index: number
  text: string
  embedding: Buffer | null
  metadata_json: string
  source_json: string
}

/** Reciprocal rank fusion for two ranked lists. */
export function reciprocalRankFusion(
  lists: ReadonlyArray<ReadonlyArray<{ chunkId: ChunkId; score: number }>>,
  k = 60,
): Array<{ chunkId: ChunkId; score: number }> {
  const totals = new Map<string, number>()
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = item.chunkId as string
      totals.set(key, (totals.get(key) ?? 0) + 1 / (k + index + 1))
    })
  }
  return [...totals.entries()]
    .map(([chunkId, score]) => ({ chunkId: chunkId as ChunkId, score }))
    .sort((a, b) => b.score - a.score)
}

/** Adaptive chunk policy snapshot stored on the collection manifest. */
export interface ChunkPolicyResolved {
  readonly targetTokens?: number
  readonly sampleSize?: number
  readonly resolvedAt?: string
}

export interface CollectionManifest {
  readonly id: string
  title: string
  description?: string
  schemaVersion: number
  updatedAt: string
  activeGeneration?: number
  pendingGeneration?: number
  chunkPolicy?: {
    resolved?: ChunkPolicyResolved
    suggestion?: {
      targetTokens?: number
      suggestedAt?: string
      recallAtK?: number
    }
  }
  embeddingGeneration?: string
}

/** Read manifest.json for one collection directory. */
export function readManifest(collectionDir: string): CollectionManifest {
  const raw = readFileSync(join(collectionDir, 'manifest.json'), 'utf8')
  return JSON.parse(raw) as CollectionManifest
}

/** Persist manifest.json for one collection directory. */
export function writeManifest(collectionDir: string, manifest: CollectionManifest): void {
  writeFileSync(join(collectionDir, 'manifest.json'), JSON.stringify({
    ...manifest,
    updatedAt: new Date().toISOString(),
  }, null, 2))
}

export const DEFAULT_CHUNK_MAX_CHARS = 768
export const DEFAULT_CHUNK_OVERLAP = 77

export interface ChunkDraft {
  readonly chunkIndex: number
  readonly role: 'child' | 'parent' | 'standalone'
  readonly text: string
  readonly parentChunkIndex?: number
  readonly source: KnowledgeSource
  readonly metadata: ChunkMetadata
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Stable chunk id per design doc.
 * @param collectionId - owning collection.
 * @param uri - source document uri.
 * @param chunkIndex - ordinal within the document.
 * @param text - normalized chunk body.
 */
export function makeChunkId(
  collectionId: CollectionId,
  uri: string,
  chunkIndex: number,
  text: string,
): ChunkId {
  const id = createHash('sha256')
    .update(collectionId)
    .update('\0')
    .update(uri)
    .update('\0')
    .update(String(chunkIndex))
    .update('\0')
    .update(contentHash(text))
    .digest('hex')
  return ChunkId(id)
}

function mergeParagraphs(paragraphs: string[], maxChars: number, minChars: number): string[] {
  const chunks: string[] = []
  let buf = ''
  for (const para of paragraphs) {
    const next = buf.length === 0 ? para : `${buf}\n\n${para}`
    if (next.length <= maxChars) {
      buf = next
      continue
    }
    if (buf.length >= minChars) chunks.push(buf)
    if (para.length <= maxChars) {
      buf = para
      continue
    }
    for (let i = 0; i < para.length; i += maxChars - DEFAULT_CHUNK_OVERLAP) {
      chunks.push(para.slice(i, i + maxChars))
    }
    buf = ''
  }
  if (buf.length > 0) chunks.push(buf)
  return chunks
}

/**
 * Split markdown or plain text into child chunks.
 * @param uri - document path.
 * @param body - file contents.
 * @param title - optional document title.
 */
export function chunkDocument(
  uri: string,
  body: string,
  options?: {
    title?: string
    labels?: Readonly<Record<string, string>>
    maxChunkChars?: number
    docMeta?: IngestDocMeta
  },
): ChunkDraft[] {
  const title = options?.title
  const maxChars = options?.maxChunkChars ?? DEFAULT_CHUNK_MAX_CHARS
  const ext = uri.toLowerCase().endsWith('.txt') ? 'txt' : 'md'
  const updatedAt = new Date().toISOString()
  const docMeta = options?.docMeta
  const baseMeta: ChunkMetadata = {
    enabled: docMeta?.enabled ?? true,
    updatedAt,
    ...(options?.labels !== undefined ? { labels: options.labels } : {}),
  }
  if (ext === 'txt') {
    const paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
    const parts = mergeParagraphs(paragraphs, maxChars, 80)
    return parts.map((text, chunkIndex) => ({
      chunkIndex,
      role: parts.length === 1 ? 'standalone' as const : 'child' as const,
      text,
      source: {
        uri,
        loc: `L1-L${body.split('\n').length}`,
        ...(title !== undefined ? { title } : {}),
      },
      metadata: baseMeta,
    }))
  }

  const sections = body.split(/(?=^#{1,3} )/m).filter(s => s.trim().length > 0)
  const drafts: ChunkDraft[] = []
  let chunkIndex = 0
  for (const section of sections) {
    const heading = section.match(/^(#{1,3}) (.+)/)?.[2]
    const paragraphs = section.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
    const parts = mergeParagraphs(paragraphs, maxChars, 80)
    if (parts.length > 1) {
      const parentIndex = chunkIndex
      drafts.push({
        chunkIndex: parentIndex,
        role: 'parent',
        text: section.trim(),
        source: {
          uri,
          ...(heading !== undefined ? { title: heading } : title !== undefined ? { title } : {}),
        },
        metadata: baseMeta,
      })
      chunkIndex++
      for (const text of parts) {
        drafts.push({
          chunkIndex,
          role: 'child',
          parentChunkIndex: parentIndex,
          text,
          source: {
            uri,
            ...(heading !== undefined ? { title: heading } : title !== undefined ? { title } : {}),
          },
          metadata: baseMeta,
        })
        chunkIndex++
      }
      continue
    }
    for (const text of parts) {
      drafts.push({
        chunkIndex,
        role: 'child',
        text,
        source: {
          uri,
          ...(heading !== undefined ? { title: heading } : title !== undefined ? { title } : {}),
        },
        metadata: baseMeta,
      })
      chunkIndex++
    }
  }
  if (drafts.length === 0 && body.trim().length > 0) {
    drafts.push({
      chunkIndex: 0,
      role: 'standalone',
      text: body.trim(),
      source: {
        uri,
        ...(title !== undefined ? { title } : {}),
      },
      metadata: baseMeta,
    })
  }
  return drafts
}

/** Heuristic chunk quality in `[0,1]`; low scores are skipped at ingest. */
export function chunkQualityScore(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  if (trimmed.length < 16) return 0.1
  if (/data:image\/[a-z0-9+.-]+;base64,/i.test(trimmed)) return 0
  const compact = trimmed.replace(/\s+/g, '')
  // Bare base64 payloads (e.g. split image data-URIs) have letters but no prose.
  if (
    compact.length >= 48
    && !/[\u4e00-\u9fff]/.test(trimmed)
    && /^[A-Za-z0-9+/=]+$/.test(compact)
  ) {
    return 0
  }
  const letters = (trimmed.match(/\p{L}/gu) ?? []).length
  if (letters === 0) return 0
  return Math.min(1, letters / trimmed.length)
}

/** Best-effort ISO-ish language tag for ingest labels. */
export function detectLang(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  return 'en'
}

/** Fields parsed from YAML frontmatter or sidecar metadata at ingest. */
export interface IngestDocMeta {
  readonly enabled?: boolean
  readonly labels?: Readonly<Record<string, string>>
}

/** Split optional YAML frontmatter from markdown body. */
export function parseYamlFrontmatter(body: string): { body: string; meta: IngestDocMeta } {
  const firstLineEnd = body.indexOf('\n')
  if (firstLineEnd < 0) return { body, meta: {} }
  const firstLine = body.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return { body, meta: {} }
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(body, start)
  if (closing === undefined) return { body, meta: {} }
  const yamlText = body.slice(start, closing.start)
  const rest = body.slice(closing.bodyStart)
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch {
    return { body: rest, meta: {} }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { body: rest, meta: {} }
  }
  return { body: rest, meta: ingestMetaFromFrontmatter(parsed as Record<string, unknown>) }
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function ingestMetaFromRecord(parsed: Record<string, unknown>, promoteStringLabels = false): IngestDocMeta {
  const reserved = new Set(['enabled', 'labels'])
  const labels: Record<string, string> = {}
  if (typeof parsed.labels === 'object' && parsed.labels !== null && !Array.isArray(parsed.labels)) {
    for (const [key, value] of Object.entries(parsed.labels)) {
      if (typeof value === 'string') labels[key] = value
    }
  }
  if (promoteStringLabels) {
    for (const [key, value] of Object.entries(parsed)) {
      if (reserved.has(key) || typeof value !== 'string') continue
      labels[key] = value
    }
  }
  return {
    ...(typeof parsed.enabled === 'boolean' ? { enabled: parsed.enabled } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  }
}

function ingestMetaFromFrontmatter(parsed: Record<string, unknown>): IngestDocMeta {
  return ingestMetaFromRecord(parsed, true)
}

/** Read optional `.meta.json` sidecar for one source uri. */
export function loadSidecarMeta(uri: string): IngestDocMeta | undefined {
  const sidecar = `${uri}.meta.json`
  if (!existsSync(sidecar)) return undefined
  try {
    return ingestMetaFromRecord(JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/** Merge ingest metadata from frontmatter, sidecar, and normalizer labels. */
export function mergeIngestMeta(...sources: readonly (IngestDocMeta | undefined)[]): IngestDocMeta {
  const out: {
    enabled?: boolean
    labels?: Record<string, string>
  } = {}
  for (const source of sources) {
    if (source === undefined) continue
    if (source.enabled !== undefined) out.enabled = source.enabled
    if (source.labels !== undefined) out.labels = { ...out.labels, ...source.labels }
  }
  return {
    ...(out.enabled !== undefined ? { enabled: out.enabled } : {}),
    ...(out.labels !== undefined ? { labels: out.labels } : {}),
  }
}

/** Whether one chunk passes the enabled gate before label filters. */
export function chunkRetrievable(metadata: ChunkMetadata): boolean {
  return metadata.enabled
}

/**
 * Match ingest `labels` against model or operator filters.
 * @throws when an operator shape is invalid.
 */
export function matchLabelFilters(
  labels: Readonly<Record<string, string>>,
  filters: Readonly<Record<string, unknown>>,
): boolean {
  for (const [key, expected] of Object.entries(filters)) {
    if (typeof expected === 'string') {
      if (labels[key] !== expected) return false
      continue
    }
    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
      const ops = expected as Record<string, unknown>
      if ('$in' in ops) {
        const list = ops.$in
        if (!Array.isArray(list) || !list.every(entry => typeof entry === 'string')) {
          throw new Error(`invalid $in filter for ${key}`)
        }
        if (!list.includes(labels[key] ?? '')) return false
        continue
      }
      if ('$prefix' in ops) {
        const prefix = ops.$prefix
        if (typeof prefix !== 'string') throw new Error(`invalid $prefix filter for ${key}`)
        if (!(labels[key] ?? '').startsWith(prefix)) return false
        continue
      }
      if ('$exists' in ops) {
        const exists = ops.$exists
        if (typeof exists !== 'boolean') throw new Error(`invalid $exists filter for ${key}`)
        const has = labels[key] !== undefined
        if (has !== exists) return false
        continue
      }
    }
    throw new Error(`unsupported filter for ${key}`)
  }
  return true
}

/** Sample up to 32 uris and derive adaptive chunk target token size. */
export function resolveChunkPolicyFromUris(sampleUris: readonly string[]): ChunkPolicyResolved {
  let totalLen = 0
  let counted = 0
  for (const uri of sampleUris.slice(0, 32)) {
    try {
      totalLen += readFileSync(uri, 'utf8').length
      counted++
    } catch {
      // skip unreadable sample
    }
  }
  const avg = counted > 0 ? totalLen / counted : 1000
  return {
    targetTokens: Math.max(256, Math.min(1024, Math.round(avg / 4))),
    sampleSize: counted,
    resolvedAt: new Date().toISOString(),
  }
}

type LocalFeatureExtractor = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>

let localPipelinePromise: Promise<LocalFeatureExtractor> | undefined

/**
 * Embed texts with an in-process transformers model (`embeddingProvider: local`).
 * @throws when `@xenova/transformers` is not installed.
 */
export async function localEmbed(
  modelId: string,
  cacheDir: string,
  texts: readonly string[],
): Promise<Float32Array[]> {
  let transformers: typeof import('@xenova/transformers')
  try {
    transformers = await import('@xenova/transformers')
  } catch (error) {
    throw new Error(
      `local embedding requires @xenova/transformers: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (localPipelinePromise === undefined) {
    localPipelinePromise = transformers.pipeline('feature-extraction', modelId, {
      cache_dir: cacheDir,
    }) as Promise<LocalFeatureExtractor>
  }
  const extractor = await localPipelinePromise
  const out: Float32Array[] = []
  for (const text of texts) {
    const tensor = await extractor(text, { pooling: 'mean', normalize: true })
    out.push(tensor.data instanceof Float32Array ? tensor.data : new Float32Array(tensor.data))
  }
  return out
}

function confidenceBand(
  score: number,
  highThreshold: number,
  lowThreshold: number,
): KnowledgeConfidence {
  if (score >= highThreshold) return 'high'
  if (score >= lowThreshold) return 'medium'
  return 'low'
}

/** Resolve the SQLite path for one blue-green generation. */
export function indexDbPath(collectionDir: string, generation: number): string {
  return join(collectionDir, 'generations', String(generation), 'index.sqlite')
}

export interface SearchRuntimeConfig {
  readonly hybrid: boolean
  readonly recallTopK: number
  readonly searchTopK: number
  readonly confidenceHighThreshold: number
  readonly confidenceLowThreshold: number
}

export interface SearchRunDeps {
  readonly embedQuery: (texts: readonly string[], signal?: AbortSignal) => Promise<Float32Array[]>
  readonly chunkVisible: (metadata: ChunkMetadata) => boolean
  readonly matchFilters: (metadata: ChunkMetadata, filters: Readonly<Record<string, unknown>>) => boolean
}

/** Run hybrid search for one collection store. */
export async function runCollectionSearch(
  deps: SearchRunDeps,
  config: SearchRuntimeConfig,
  store: CollectionStore,
  collectionId: CollectionId,
  request: KnowledgeSearchRequest,
): Promise<{ hits: KnowledgeHit[] }> {
  const recallTopK = config.recallTopK
  const searchTopK = Math.min(request.topK ?? config.searchTopK, config.searchTopK)
  const denseBatch = await deps.embedQuery([request.query], request.signal)
  const denseVec = denseBatch[0]
  if (denseVec === undefined) return { hits: [] }

  const lexical = store.searchLexical(request.query, recallTopK)
  const dense = config.hybrid ? store.searchVector(denseVec, recallTopK) : []
  const lists = config.hybrid
    ? [lexical.map(x => ({ chunkId: x.chunkId, score: x.rank })), dense]
    : [dense]
  const ranked = reciprocalRankFusion(lists).slice(0, searchTopK)

  const hits: KnowledgeHit[] = []
  for (const item of ranked) {
    const chunk = store.get(item.chunkId)
    if (!chunk || chunk.metadata.role === 'parent' || !deps.chunkVisible(chunk.metadata)) continue
    if (request.filters && !deps.matchFilters(chunk.metadata, request.filters)) continue
    hits.push({
      chunkId: chunk.chunkId,
      text: chunk.text.slice(0, 512),
      score: item.score,
      source: chunk.source,
      collectionId,
      confidence: confidenceBand(item.score, config.confidenceHighThreshold, config.confidenceLowThreshold),
      scoreBreakdown: { fused: item.score },
    })
  }
  return { hits }
}

/** Run search across collections and assemble the public result shape. */
export async function runSearch(
  deps: SearchRunDeps,
  baseConfig: SearchRuntimeConfig,
  stores: ReadonlyMap<string, CollectionStore>,
  collectionIds: readonly CollectionId[],
  request: KnowledgeSearchRequest,
): Promise<KnowledgeSearchResult> {
  const fused: KnowledgeHit[] = []
  for (const collectionId of collectionIds) {
    const store = stores.get(collectionId as string)
    if (store === undefined) continue
    const result = await runCollectionSearch(deps, baseConfig, store, collectionId, request)
    fused.push(...result.hits)
  }
  fused.sort((a, b) => b.score - a.score)
  const topK = Math.min(request.topK ?? baseConfig.searchTopK, baseConfig.searchTopK)
  const hits = fused.slice(0, topK)
  const insufficientEvidence = hits.length === 0 || hits.every(hit => hit.confidence === 'low')
  return {
    hits,
    ...(insufficientEvidence ? { insufficientEvidence: true as const } : {}),
  }
}

/** Map fused score to confidence band using deployment thresholds. */
export { confidenceBand }
