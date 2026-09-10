/**
 * Shared types and pure helpers for the knowledge UI plugin.
 */
import type {
  CollectionSummary,
  DocumentChunkSummary,
  DocumentSummary,
  IngestProgress,
  IngestResult,
  KnowledgeSearchResult,
  StagingDocumentSummary,
} from '@deepseek-ai/dsh-knowledge'

/** Bound locale translator for knowledge copy keys. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Admin callbacks over knowledge-admin HTTP (not Host RPC). */
export interface AdminApi {
  listCollections(signal?: AbortSignal): Promise<readonly CollectionSummary[]>
  createCollection(id: string, title?: string, signal?: AbortSignal): Promise<void>
  deleteCollection(collectionId: string, signal?: AbortSignal): Promise<void>
  listDocuments(collectionId: string, signal?: AbortSignal): Promise<readonly DocumentSummary[]>
  listDocumentChunks(
    collectionId: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<readonly DocumentChunkSummary[]>
  listStaging(collectionId: string, signal?: AbortSignal): Promise<readonly StagingDocumentSummary[]>
  deleteDocument(collectionId: string, uri: string, signal?: AbortSignal): Promise<void>
  ingest(collectionId: string, uri: string, signal?: AbortSignal): Promise<IngestResult>
  getIngestProgress(signal?: AbortSignal): Promise<IngestProgress>
  uploadStagingFile(collectionId: string, file: File, signal?: AbortSignal): Promise<string>
  search(query: string, collectionId?: string, topK?: number, signal?: AbortSignal): Promise<KnowledgeSearchResult>
}

/** Basename of a document uri for dense list rows. */
export function basenameUri(uri: string): string {
  const normalized = uri.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(slash + 1) || uri : uri
}

/** Format a retrieval score for display. */
export function formatScore(value: number | undefined): string {
  return value === undefined ? '—' : value.toFixed(3)
}

/** Human-readable error text for board banners. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
