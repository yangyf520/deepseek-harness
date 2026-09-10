/**
 * Model-facing `knowledge_search` over `ctx.knowledge`.
 * @module @deepseek-ai/dsh-knowledge/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from './types.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { CollectionId } from './types.ts'
import type { KnowledgeHit, KnowledgeSource } from './types.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, JsonValue, PreToolDecision, ToolResult } from '@deepseek-ai/dsh-tools'

const KNOWLEDGE_TOOLS = new Set(['knowledge_search'])

const ALLOW_ALL = '*'

function readCollectionArg(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) return undefined
  const collection = (argumentsValue as { collection?: unknown }).collection
  return typeof collection === 'string' ? collection : undefined
}

function isAllowAll(collections: readonly string[]): boolean {
  return collections.includes(ALLOW_ALL)
}

/** Whether the preset allowlist permits every indexed collection. */
export function isAllowAllCollections(allowed: readonly string[]): boolean {
  return isAllowAll(allowed)
}

/** Register `tools/pre-execute` guard that rejects out-of-allowlist `collection` args. */
export function applyCollectionAllowlist(ctx: Context, collections: readonly string[]): void {
  const allowAll = isAllowAll(collections)
  const allowed = new Set(collections)
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!KNOWLEDGE_TOOLS.has(exec.name)) return next()
    if (allowAll) return next()
    const collection = readCollectionArg(exec.arguments)
    if (collection !== undefined && !allowed.has(collection)) {
      return Promise.resolve({
        kind: 'deny',
        reason: `collection "${collection}" is not allowed for this agent; allowed: ${[...allowed].join(', ')}`,
      } satisfies PreToolDecision)
    }
    return next()
  })
}

/** Narrow a collection id against the preset allowlist at execute time. */
export function resolveAllowedCollection(
  allowed: readonly string[],
  collection: string | undefined,
): CollectionId | undefined {
  if (collection === undefined) return undefined
  if (isAllowAll(allowed)) return CollectionId(collection)
  if (!allowed.includes(collection)) {
    throw new Error(`collection "${collection}" is not allowed for this agent`)
  }
  return CollectionId(collection)
}

export const DEFAULT_SEARCH_TOP_K = 8
export const DEFAULT_SEARCH_SNIPPET_CHARS = 512

export interface KnowledgeSearchMeta {
  hits: Array<{
    chunkId: string
    score: number
    text: string
    source: {
      uri: string
      loc?: string
      title?: string
    }
    collectionId?: string
  }>
}

function projectSource(source: KnowledgeSource): KnowledgeSearchMeta['hits'][number]['source'] {
  return {
    uri: source.uri,
    ...(source.loc !== undefined ? { loc: source.loc } : {}),
    ...(source.title !== undefined ? { title: source.title } : {}),
  }
}

function projectHit(hit: KnowledgeHit): KnowledgeSearchMeta['hits'][number] {
  return {
    chunkId: hit.chunkId as string,
    score: hit.score,
    text: hit.text,
    source: projectSource(hit.source),
    ...(hit.collectionId !== undefined ? { collectionId: hit.collectionId as string } : {}),
  }
}

/** Format search hits for the model. */
export function formatSearchOutput(hits: readonly KnowledgeHit[], insufficientEvidence?: boolean): string {
  if (hits.length === 0 || insufficientEvidence) {
    return 'No reliable knowledge evidence found. Do not invent facts; try rephrasing the query or another collection.'
  }
  const lines = hits.map((hit, index) => {
    const loc = hit.source.loc !== undefined ? ` (${hit.source.loc})` : ''
    const title = hit.source.title !== undefined ? `${hit.source.title}: ` : ''
    return `${index + 1}. [${hit.chunkId as string}] ${title}${hit.source.uri}${loc}\n${hit.text}`
  })
  return `${lines.join('\n\n')}\n\nCite source URIs from hits. Prefer another knowledge_search with a tighter query when a hit is incomplete.`
}

export function searchMetaFromValue(hits: readonly KnowledgeHit[]): JsonValue {
  return { hits: hits.map(projectHit) }
}

export function searchMetaFromResult(meta: unknown): KnowledgeSearchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { hits } = meta as { hits?: unknown }
  if (!Array.isArray(hits)) return undefined
  return { hits: hits as KnowledgeSearchMeta['hits'] }
}

export function presentSearchCall(args: { query: string }): GenericCallView {
  return { card: 'generic', title: args.query, kind: 'search', rawInput: args.query }
}

export function presentSearchResult(
  args: { query: string },
  result: ToolResult,
): GenericResultView | undefined {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  const hits = meta.hits.map(hit => ({
    chunkId: hit.chunkId,
    text: hit.text,
    score: hit.score,
    source: hit.source,
    ...(hit.collectionId !== undefined ? { collectionId: hit.collectionId } : {}),
  })) as KnowledgeHit[]
  return {
    card: 'generic',
    title: args.query,
    content: [{ type: 'text', text: formatSearchOutput(hits) }],
  }
}

/** Register `knowledge_search`. */
export function applyKnowledgeSearchTool(
  ctx: Context,
  allowedCollections: readonly string[],
  defaultTopK: number,
  maxSnippetChars: number,
): void {
  ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description:
      'Search indexed knowledge libraries for enterprise knowledge: ops runbooks, requirements, design/test notes, business rules, product docs, product names, version matrices, and similar material. '
      + 'Call this immediately when the user names a product, system, or internal term that may be documented in a knowledge library — do not ask the user what that term means first. '
      + 'Prefer this over workspace grep/glob when the answer may live in a knowledge library rather than this repository\'s source. '
      + 'Returns scored excerpts with source URIs; refine the query or pass a collection id when results are incomplete.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search query.' },
      collection: { type: 'string', description: 'Optional collection id to search within.' },
      topK: { type: 'number', description: 'Maximum hits to return.' },
      filters: { type: 'object', additionalProperties: true, description: 'Optional label filters (equality or $in / $prefix / $exists).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                chunkId: { type: 'string', required: true },
                text: { type: 'string', required: true },
                score: { type: 'number', required: true },
                source: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    uri: { type: 'string', required: true },
                    loc: { type: 'string' },
                    title: { type: 'string' },
                  },
                },
                collectionId: { type: 'string' },
              },
            },
          },
          insufficientEvidence: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatSearchOutput(value.hits as KnowledgeHit[], value.insufficientEvidence),
      }],
      presentationMeta: (_args, value) => searchMetaFromValue(value.hits as KnowledgeHit[]),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query.length === 0) throw new Error('query must be a non-empty string')
      const collection = resolveAllowedCollection(
        allowedCollections,
        typeof args.collection === 'string' ? args.collection : undefined,
      )
      const topK = typeof args.topK === 'number' ? args.topK : defaultTopK
      const filters = typeof args.filters === 'object' && args.filters !== null && !Array.isArray(args.filters)
        ? args.filters as Readonly<Record<string, unknown>>
        : undefined
      const result = await ctx.knowledge.search({
        query,
        topK,
        signal: exec.signal,
        ...(collection !== undefined ? { collection } : {}),
        ...(filters !== undefined ? { filters } : {}),
      })
      const allowedSet = new Set(allowedCollections)
      const allowAll = isAllowAllCollections(allowedCollections)
      const hits = result.hits
        .filter(hit => allowAll || hit.collectionId === undefined || allowedSet.has(hit.collectionId as string))
        .map(hit => ({
          ...hit,
          text: hit.text.slice(0, maxSnippetChars),
        }))
      return {
        hits,
        ...(result.insufficientEvidence ? { insufficientEvidence: true } : {}),
      }
    },
    presentCall: args => presentSearchCall({ query: String(args.query ?? '') }),
    presentResult: (args, result) => presentSearchResult({ query: String(args.query ?? '') }, result),
  }))
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-knowledge'

/** Services required by knowledge_search. */
export const inject = ['tools', 'knowledge', 'systemPrompt']

/** Plugin config: collection allowlist for this preset. */
export interface Config {
  /** Collection ids this preset may search; required and non-empty. */
  collections: string[]
}

export const Config: z<Config> = z.object({
  collections: z.array(z.string()).min(1),
})

/**
 * Register `knowledge_search` and system-prompt guidance for one agent preset.
 * @param ctx - Cordis context.
 * @param config - preset collection allowlist.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config)
  const collections = resolved.collections
  applyCollectionAllowlist(ctx, collections)

  const allowAll = isAllowAll(collections)
  const collectionList = collections.join(', ')
  const knowledgeGuidance = allowAll
    ? 'Knowledge libraries hold enterprise knowledge of many kinds — operations, requirements, design and test notes, business rules, product docs, product names, version lists, and similar — and that material is not necessarily in this coding workspace. When the user asks about such knowledge, or names a product/system/internal term that may be documented there, call knowledge_search immediately. Do not ask the user what that term means, and do not wait for clarification, before searching. Cite source URIs from hits. Refine the query or pass a collection id when results are incomplete. Only fall back to workspace grep/glob or ask_user_question when knowledge returns insufficient evidence or the user is clearly asking about this repository\'s source code.'
    : `Knowledge libraries (${collectionList}) hold enterprise knowledge of many kinds — operations, requirements, design and test notes, business rules, product docs, product names, version lists, and similar — and that material is not necessarily in this coding workspace. When the user asks about such knowledge, or names a product/system/internal term that may be documented there, call knowledge_search immediately. Do not ask the user what that term means, and do not wait for clarification, before searching. Cite source URIs from hits. Refine the query or pass a collection id when results are incomplete. Only fall back to workspace grep/glob or ask_user_question when knowledge returns insufficient evidence or the user is clearly asking about this repository\'s source code.`
  ctx.systemPrompt.section({
    name: 'tool:knowledge',
    order: 103,
    text: knowledgeGuidance,
  })

  applyKnowledgeSearchTool(ctx, collections, DEFAULT_SEARCH_TOP_K, DEFAULT_SEARCH_SNIPPET_CHARS)
}
