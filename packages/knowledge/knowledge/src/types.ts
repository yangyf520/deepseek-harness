/**
 * Knowledge-base capability types and abstract `Knowledge`.
 * @module @deepseek-ai/dsh-knowledge/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { Context, Service } from '@deepseek-ai/cordis'

/** Opaque collection identifier. */
export type CollectionId = Branded<'CollectionId'>
/** Construct a {@link CollectionId}. */
export function CollectionId(id: string): CollectionId {
  return id as CollectionId
}

/** Opaque chunk identifier. */
export type ChunkId = Branded<'ChunkId'>
/** Construct a {@link ChunkId}. */
export function ChunkId(id: string): ChunkId {
  return id as ChunkId
}

/** Chunk role in parent–child indexing. */
export type ChunkRole = 'child' | 'parent' | 'standalone'

/** Evidence confidence band for search hits. */
export type KnowledgeConfidence = 'high' | 'medium' | 'low'

/** Per-stage retrieval scores for operator debug. */
export interface ScoreBreakdown {
  readonly lexical?: number
  readonly dense?: number
  readonly fused?: number
}

/** Citation source for a chunk. */
export interface KnowledgeSource {
  readonly uri: string
  readonly loc?: string
  readonly title?: string
}

/** Ingest/search metadata stored with each chunk. */
export interface ChunkMetadata {
  readonly enabled: boolean
  readonly role?: ChunkRole
  readonly parentChunkIndex?: number
  readonly labels?: Readonly<Record<string, string>>
  readonly updatedAt?: string
}

/** One search hit returned to consumers. */
export interface KnowledgeHit {
  readonly chunkId: ChunkId
  readonly text: string
  readonly score: number
  readonly source: KnowledgeSource
  readonly collectionId?: CollectionId
  readonly confidence?: KnowledgeConfidence
  readonly scoreBreakdown?: ScoreBreakdown
}

/** Search request. */
export interface KnowledgeSearchRequest {
  readonly query: string
  readonly collection?: CollectionId
  readonly topK?: number
  readonly filters?: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

/** Search result. */
export interface KnowledgeSearchResult {
  readonly hits: readonly KnowledgeHit[]
  readonly insufficientEvidence?: boolean
}

/** Collection summary for list operations. */
export interface CollectionSummary {
  readonly id: CollectionId
  readonly title: string
  readonly description?: string
  readonly docCount?: number
}

/** Document summary for list operations. */
export interface DocumentSummary {
  readonly uri: string
  readonly chunkCount: number
  readonly updatedAt?: string
  readonly labels?: Readonly<Record<string, string>>
}

/** Staging file awaiting ingest (admin list). */
export interface StagingDocumentSummary {
  readonly uri: string
  /** File birth time when available, otherwise mtime (ISO-8601). */
  readonly createdAt: string
}

/** Live ingest progress for admin polling. */
export interface IngestProgress {
  readonly phase: 'idle' | 'normalize' | 'chunk' | 'embed' | 'write' | 'done' | 'error'
  readonly uri?: string
  readonly done: number
  readonly total: number
  readonly message?: string
}

/** One indexed chunk for admin document inspection. */
export interface DocumentChunkSummary {
  readonly chunkId: ChunkId
  readonly chunkIndex: number
  readonly text: string
  readonly role?: ChunkRole
  readonly source: KnowledgeSource
}

/** Ingest input. */
export interface IngestRequest {
  readonly collectionId: CollectionId
  readonly paths?: readonly string[]
  readonly uri?: string
  readonly dryRun?: boolean
  /** When true, apply `manifest.chunkPolicy.suggestion` target size on this ingest. */
  readonly applyChunkSuggestion?: boolean
  /** When true, re-index even if content hash is unchanged. */
  readonly forceReingest?: boolean
  readonly signal?: AbortSignal
}

/** Per-uri ingest error. */
export interface IngestError {
  readonly uri: string
  readonly code: string
  readonly message: string
}

/** Ingest outcome. */
export interface IngestResult {
  readonly filesProcessed: number
  readonly chunksWritten: number
  readonly skipped: number
  readonly errors: readonly IngestError[]
}

/** Stage one workspace file into collection staging (no index change). */
export interface StageDocumentRequest {
  readonly collectionId: CollectionId
  readonly path: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** Staging outcome. */
export interface StageDocumentResult {
  readonly stagingUri: string
}

/** Knowledge error codes. */
export type KnowledgeErrorCode =
  | 'KNOWLEDGE_COLLECTION_NOT_FOUND'
  | 'KNOWLEDGE_CHUNK_NOT_FOUND'
  | 'KNOWLEDGE_DOCUMENT_NOT_FOUND'
  | 'KNOWLEDGE_INGEST_FAILED'
  | 'KNOWLEDGE_INVALID_FILTER'
  | 'KNOWLEDGE_NORMALIZE_FAILED'

/** Typed error for the knowledge seam. */
export class KnowledgeError extends HarnessError {
  override readonly code: KnowledgeErrorCode

  constructor(message: string, code: KnowledgeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** Input to a {@link DocumentNormalizer}. */
export interface NormalizeInput {
  readonly uri: string
  readonly data: Buffer
  readonly mime?: string
}

/** Canonical markdown output from normalize. */
export interface NormalizeOutput {
  readonly markdown: string
  readonly title?: string
  readonly labels?: Readonly<Record<string, string>>
}

/** Pre-ingest converter registered by format plugins. */
export interface DocumentNormalizer {
  /** Stable id for diagnostics (optional). */
  readonly id?: string
  /** Return true when this normalizer handles the uri. */
  match(uri: string, mime?: string): boolean
  /**
   * Convert raw bytes to markdown.
   * @param input - source bytes and uri
   * @returns normalized markdown body
   */
  normalize(input: NormalizeInput): Promise<NormalizeOutput>
}

/**
 * Registry of {@link DocumentNormalizer} plugins.
 * Mounted as `ctx.knowledgeNormalizers`.
 */
export class KnowledgeNormalizerRegistry extends Service {
  private readonly normalizers: DocumentNormalizer[] = []

  constructor(ctx: Context) {
    super(ctx, 'knowledgeNormalizers')
  }

  /**
   * Register a normalizer; disposer unregisters it.
   * Callers must install the disposer through `ctx.effect` (do not nest
   * another effect here — a nested effect on this service's ctx can dispose
   * during provider construction and leave the registry empty).
   * @param normalizer - converter to register
   * @returns disposer that removes the normalizer
   */
  register(normalizer: DocumentNormalizer): () => void {
    this.normalizers.push(normalizer)
    return () => {
      const index = this.normalizers.indexOf(normalizer)
      if (index >= 0) this.normalizers.splice(index, 1)
    }
  }

  /**
   * Find the first matching normalizer.
   * @param uri - document uri
   * @param mime - optional mime hint
   * @returns matching normalizer, or undefined
   */
  find(uri: string, mime?: string): DocumentNormalizer | undefined {
    return this.normalizers.find(entry => entry.match(uri, mime))
  }

  /**
   * Resolve a normalizer. Unmatched `.md` / `.txt` / `.markdown` use the
   * identity markdown normalizer; any other unmatched uri fails loud so a
   * binary Office/PDF body cannot be indexed as UTF-8 mojibake.
   * @param uri - document uri
   * @param mime - optional mime hint
   * @returns matching or text-passthrough normalizer
   */
  resolveOrPassthrough(uri: string, mime?: string): DocumentNormalizer {
    const found = this.find(uri, mime)
    if (found !== undefined) return found
    const lower = uri.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.markdown')) {
      return markdownNormalizer
    }
    throw new Error(`no document normalizer for ${uri}`)
  }
}

/** Built-in markdown/text normalizer (identity). */
export const markdownNormalizer: DocumentNormalizer = {
  match(uri) {
    const lower = uri.toLowerCase()
    return lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.markdown')
  },
  async normalize(input) {
    return { markdown: input.data.toString('utf8') }
  },
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledge: Knowledge
    knowledgeNormalizers: KnowledgeNormalizerRegistry
  }
}

/**
 * Abstract knowledge provider mounted as `ctx.knowledge`.
 * Model surface is `knowledge_search` only; list / ingest stay host and admin.
 */
export abstract class Knowledge extends Service {
  constructor(ctx: Context) {
    super(ctx, 'knowledge')
  }

  /** Hybrid search over indexed chunks. */
  abstract search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>

  /** List collections visible to the caller. */
  abstract listCollections(signal?: AbortSignal): Promise<readonly CollectionSummary[]>

  /** Create an empty collection. */
  abstract createCollection(id: CollectionId, title?: string): Promise<void>

  /** Ingest paths or a single uri into a collection. */
  abstract ingest(request: IngestRequest): Promise<IngestResult>

  /** List indexed documents in a collection. */
  abstract listDocuments(collectionId: CollectionId, signal?: AbortSignal): Promise<readonly DocumentSummary[]>

  /** List indexed chunks for one document uri (admin inspection). */
  abstract listDocumentChunks(
    collectionId: CollectionId,
    uri: string,
    signal?: AbortSignal,
  ): Promise<readonly DocumentChunkSummary[]>

  /** Delete one document and all its chunks. */
  abstract deleteDocument(collectionId: CollectionId, uri: string): Promise<void>

  /** Delete a collection and its on-disk index. */
  abstract deleteCollection(id: CollectionId): Promise<void>

  /** Copy a workspace file into collection staging without indexing. */
  abstract stageDocument(request: StageDocumentRequest): Promise<StageDocumentResult>

  /** List staging files not yet indexed (uri + createdAt). */
  abstract listStaging(
    collectionId: CollectionId,
    signal?: AbortSignal,
  ): Promise<readonly StagingDocumentSummary[]>

  /** Snapshot of the in-flight ingest, if any. */
  abstract getIngestProgress(): IngestProgress
}
