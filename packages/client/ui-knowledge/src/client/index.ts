/**
 * Knowledge admin: DOM sidebar entry + center-column board over loopback HTTP.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { IngestResult, KnowledgeSearchResult } from '@deepseek-ai/dsh-knowledge'
import {
  createKnowledgeBoardStore,
  en,
  NS,
  zh,
} from './Board.tsx'
import { mountKnowledgeBoard } from './board-mount.ts'
import { mountKnowledgeSidebarEntry } from './sidebar-entry.ts'
import type { AdminApi, Translate } from '../components/types.ts'

type AdminResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

async function postAction(
  action: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, params }),
  }
  if (signal !== undefined) init.signal = signal
  const response = await fetch('/knowledge-admin', init)
  const body = await response.json() as AdminResponse
  if (!response.ok || !body.ok) {
    throw new Error(!body.ok ? body.error : `knowledge-admin HTTP ${String(response.status)}`)
  }
  return body.value
}

function createAdminFetchApi(): AdminApi {
  function call<T>(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    return postAction(action, params, signal) as Promise<T>
  }
  return {
    listCollections: signal => call('listCollections', {}, signal),
    createCollection: (id, title, signal) => call('createCollection', {
      id,
      ...(title !== undefined && title !== '' ? { title } : {}),
    }, signal),
    deleteCollection: (collectionId, signal) => call('deleteCollection', { collectionId }, signal),
    listDocuments: (collectionId, signal) => call('listDocuments', { collectionId }, signal),
    listDocumentChunks: (collectionId, uri, signal) =>
      call('listDocumentChunks', { collectionId, uri }, signal),
    listStaging: (collectionId, signal) => call('listStaging', { collectionId }, signal),
    deleteDocument: (collectionId, uri, signal) =>
      call('deleteDocument', { collectionId, uri }, signal),
    ingest: (collectionId, uri, signal) =>
      call<IngestResult>('ingest', { collectionId, uri }, signal),
    getIngestProgress: signal => call('getIngestProgress', {}, signal),
    uploadStagingFile: async (collectionId, file, signal) => {
      const buffer = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (const byte of buffer) binary += String.fromCharCode(byte)
      return call<string>('uploadToStaging', {
        collectionId,
        filename: file.name,
        contentBase64: btoa(binary),
      }, signal)
    },
    search: (query, collectionId, topK, signal) => call<KnowledgeSearchResult>('search', {
      query,
      ...(collectionId !== undefined && collectionId !== '' ? { collectionId } : {}),
      ...(topK !== undefined ? { topK } : {}),
    }, signal),
  }
}

/** Required services: locale dictionaries. */
export const inject = ['locale']

/**
 * Register dictionaries, DOM sidebar entry, and center-column board.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-knowledge: dictionaries')
  const api = createAdminFetchApi()
  // defineStore returns a handle; entry and board mount must share one instance.
  const boardHandle = createKnowledgeBoardStore()
  const board = boardHandle.create()

  ctx.effect(() => mountKnowledgeSidebarEntry({
    label: () => ctx.locale.bind(NS)('entry.label'),
    tooltip: () => ctx.locale.bind(NS)('entry.tooltip'),
    onToggle: () => { board.actions.toggle() },
    refresh: { subscribe: listener => ctx.locale.subscribe(listener) },
    active: {
      subscribe: listener => board.subscribe(listener),
      isOpen: () => board.getSnapshot().open,
    },
  }), 'ui-knowledge: sidebar entry')

  ctx.effect(() => mountKnowledgeBoard({
    api,
    t: () => ctx.locale.bind(NS) as Translate,
    isOpen: () => board.getSnapshot().open,
    close: () => { board.actions.close() },
    subscribe: listener => board.subscribe(listener),
    locale: { subscribe: listener => ctx.locale.subscribe(listener) },
  }), 'ui-knowledge: center board')
}
