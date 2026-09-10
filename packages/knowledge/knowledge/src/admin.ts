/**
 * Host HTTP admin for `ctx.knowledge` over `POST /knowledge-admin`.
 * Loopback Host only; does not extend `RpcMethodMap`.
 * @module @deepseek-ai/dsh-knowledge/admin
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isLoopbackHostname } from '@deepseek-ai/dsh-client-connection/src/loopback-hostname.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CollectionId } from './types.ts'

/** Absolute pathname registered on `ctx.webServer`. */
export const KNOWLEDGE_ADMIN_PATH = '/knowledge-admin'

/** Cordis plugin name. */
export const name = 'knowledge-admin'

/** Requires the HTTP carrier and a knowledge provider. */
export const inject = ['webServer', 'knowledge']

const MAX_BODY_BYTES = 32 * 1024 * 1024

type ActionBody = {
  action?: string
  params?: Record<string, unknown>
}

function readHostHostname(req: IncomingMessage): string | undefined {
  const raw = req.headers.host
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    return new URL(`http://${raw}`).hostname
  } catch {
    return undefined
  }
}

async function readJson(req: IncomingMessage): Promise<ActionBody> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
    throw new Error('request body too large')
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.byteLength
    if (received > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ActionBody
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} required`)
  }
  return value
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return value
}

function safeBasename(filename: string): string {
  const base = basename(filename)
  if (base.length === 0 || base === '.' || base === '..') {
    throw new Error('filename must be a plain file name')
  }
  if (base !== filename.replaceAll('\\', '/').split('/').pop()) {
    throw new Error('filename must not contain path segments')
  }
  return base
}

/**
 * Dispatch one admin action against `ctx.knowledge`.
 * @param ctx - context carrying knowledge
 * @param action - action discriminant
 * @param params - JSON params object
 * @returns action result value
 */
export async function dispatchKnowledgeAdminAction(
  ctx: Context,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const knowledge = ctx.knowledge
  switch (action) {
    case 'listCollections':
      return knowledge.listCollections()
    case 'createCollection': {
      const title = optionalString(params, 'title')
      await knowledge.createCollection(CollectionId(requireString(params, 'id')), title)
      return null
    }
    case 'deleteCollection':
      await knowledge.deleteCollection(CollectionId(requireString(params, 'collectionId')))
      return null
    case 'listDocuments':
      return knowledge.listDocuments(CollectionId(requireString(params, 'collectionId')))
    case 'listDocumentChunks':
      return knowledge.listDocumentChunks(
        CollectionId(requireString(params, 'collectionId')),
        requireString(params, 'uri'),
      )
    case 'listStaging':
      return knowledge.listStaging(CollectionId(requireString(params, 'collectionId')))
    case 'deleteDocument':
      await knowledge.deleteDocument(
        CollectionId(requireString(params, 'collectionId')),
        requireString(params, 'uri'),
      )
      return null
    case 'ingest':
      return knowledge.ingest({
        collectionId: CollectionId(requireString(params, 'collectionId')),
        uri: requireString(params, 'uri'),
      })
    case 'getIngestProgress':
      return knowledge.getIngestProgress()
    case 'search': {
      const collectionId = optionalString(params, 'collectionId')
      const topK = optionalNumber(params, 'topK')
      return knowledge.search({
        query: requireString(params, 'query'),
        ...(collectionId !== undefined ? { collection: CollectionId(collectionId) } : {}),
        ...(topK !== undefined ? { topK } : {}),
      })
    }
    case 'uploadToStaging': {
      const collectionId = CollectionId(requireString(params, 'collectionId'))
      const filename = safeBasename(requireString(params, 'filename'))
      const contentBase64 = requireString(params, 'contentBase64')
      const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-upload-'))
      const path = join(dir, filename)
      try {
        await writeFile(path, Buffer.from(contentBase64, 'base64'))
        const staged = await knowledge.stageDocument({ collectionId, path })
        return staged.stagingUri
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
    default:
      throw new Error(`unknown action: ${action}`)
  }
}

/**
 * Register the loopback `/knowledge-admin` POST route.
 * @param ctx - Host context with `webServer` and `knowledge`.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: KNOWLEDGE_ADMIN_PATH,
    handler: async (req, res) => {
      const hostname = readHostHostname(req)
      if (hostname === undefined || !isLoopbackHostname(hostname)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      try {
        const body = await readJson(req)
        const action = body.action
        if (typeof action !== 'string' || action.trim() === '') {
          sendJson(res, 400, { ok: false, error: 'action required' })
          return
        }
        const value = await dispatchKnowledgeAdminAction(ctx, action, body.params ?? {})
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'knowledge-admin: /knowledge-admin route')
}
