/**
 * Tool bridge: discovers MCP tools, registers them on the harness ToolRuntime
 * under deterministic server-qualified public names, and handles re-sync when
 * the server's tool list changes.
 *
 * Naming contract (see the mcp-client Agent Note "Naming invariants"): every MCP tool
 * has the stable identity `(serverName, rawName)`; the model-facing public name
 * is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
 * constraints. The raw name is only ever sent on the wire (`tools/call`); the
 * public name is never parsed to recover it.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { execSync } from 'node:child_process'
import { specTypeSchemas, SdkHttpError, UnauthorizedError, ProtocolError, type Client, type ImageContent } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Detect 401 / authentication errors from the MCP SDK. */
function isAuthError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  if (error instanceof SdkHttpError && error.data?.status === 401) return true
  if (error instanceof Error && error.name === 'UnauthorizedError') return true
  return false
}

/**
 * Detect MCP session expiry errors (JSON-RPC -32600 with session-shaped message).
 * The gateway recycles session IDs after inactivity; the fix is to reconnect,
 * not to renew the JWT token (which may still be valid).
 */
function isSessionError(error: unknown): boolean {
  if (error instanceof ProtocolError && error.code === -32600) {
    return /session|invalid.*mcp.*session/i.test(error.message)
  }
  if (error instanceof Error) {
    return /missing or invalid mcp-session-id/i.test(error.message)
  }
  return false
}

/** Resolved options relevant to tool bridging. */
export interface ToolBridgeOptions {
  /** Whether a registry conflict is contained or rejects this synchronization. */
  registrationFailure: 'contain' | 'throw'
  serverName: string
  toolCallTimeoutMs: number
  /**
   * Renew an expired token and re-establish the connection.
   * Returns true if renewal succeeded and a fresh client is available via `currentClient`.
   */
  renewToken?: () => Promise<boolean>
  /** Return the current active client (updated after token renewal + reconnect). */
  currentClient?: () => Client | undefined
  /**
   * Re-establish the connection with a fresh MCP session ID.
   * Used when the gateway recycles the session (e.g. after inactivity) but the
   * JWT token is still valid. Returns true if reconnection succeeded.
   */
  reconnect?: () => Promise<boolean>
}

/** State for one sync generation: the current set of disposers keyed by public name. */
export type ToolDisposers = Map<string, () => void>

/** Canonical MCP result exposed to PTC mode without discarding protocol blocks. */
export type McpResult<Structured extends JsonValue = JsonValue> = {
  content: JsonValue[]
  structuredContent?: Structured
}

/**
 * DeepSeek function-name contract: at most 64 characters. Wire-protocol
 * constant, not configuration.
 */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** Raster formats supported by the durable attachment vocabulary. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Derive the model-facing public name for one MCP tool.
 *
 * Deterministic pure function of `(serverName, rawName)`: the clean case is
 * `mcp__<serverName>__<rawName>` verbatim. When character replacement or
 * truncation to the DeepSeek function-name contract (64 chars,
 * `[A-Za-z0-9_-]`) changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into the
 * same public name.
 *
 * @param serverName - Stable local namespace from plugin config.
 * @param rawName - The MCP server's own tool name.
 * @returns The globally unique, model-facing ToolRuntime name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Sync the MCP server's tool list into the harness ToolRuntime.
 *
 * Two phases keep the swap safe:
 *
 * 1. Fetch: let the SDK aggregate `tools/list` and build the full next
 *    generation of `ToolDefinition`s under public names. Any failure here
 *    (network error or duplicate raw name) rejects
 *    and leaves the previous generation registered untouched.
 * 2. Swap: dispose the previous generation, register the new one. A registry
 *    conflict here can only mean a foreign registration squats on this
 *    server's `mcp__<serverName>__` namespace — the partial generation is
 *    rolled back (zero tools from this server) and logged. Initial strict
 *    synchronization may propagate the conflict so its parent transaction
 *    rejects; ordinary clients and later re-syncs return an empty map.
 *
 * @param client - Connected MCP Client instance used to list and call tools.
 * @param ctx - Cordis context providing the `tools` service for registration.
 * @param opts - Bridge options: server namespace and per-call timeout.
 * @param previous - Disposer map from the prior sync generation; disposed
 *   during the swap phase (only after the fetch phase succeeded).
 * @returns A map of registered public tool names to their unregister
 *   disposers — the exact set of live registrations owned by this server.
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
): Promise<ToolDisposers> {
  // Phase 1: fetch and build the next generation without touching the registry.
  const definitions = new Map<string, ToolDefinition>()
  const response = client.getServerCapabilities()?.tools === undefined
    ? { tools: [] }
    : await client.listTools(undefined, { cacheMode: 'refresh' })
  for (const tool of response.tools) {
    const publicName = publicToolName(opts.serverName, tool.name)
    if (definitions.has(publicName)) {
      throw new Error(
        `mcp-client(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
      )
    }
    definitions.set(publicName, createMcpToolDefinition(ctx, {
      name: publicName,
      rawName: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      taskRequired: tool.execution?.taskSupport === 'required',
      call: async (args, execution) => {
        const activeClient = opts.currentClient?.() ?? client
        let reconnecting = false
        try {
          return await activeClient.callTool(
            { name: tool.name, arguments: args },
            { signal: execution.signal, timeout: opts.toolCallTimeoutMs, toolDefinition: tool },
          )
        } catch (callError) {
          // MCP session expired: reconnect with a fresh session and retry once.
          if (opts.reconnect && opts.currentClient && isSessionError(callError) && !reconnecting) {
            reconnecting = true
            const reconnected = await opts.reconnect()
            if (reconnected) {
              const freshClient = opts.currentClient()
              if (freshClient) {
                return await freshClient.callTool(
                  { name: tool.name, arguments: args },
                  { signal: execution.signal, timeout: opts.toolCallTimeoutMs, toolDefinition: tool },
                )
              }
            }
          }
          // Token expired mid-session: renew and retry once with a fresh client.
          if (opts.renewToken && opts.currentClient && isAuthError(callError)) {
            const renewed = await opts.renewToken()
            if (renewed) {
              const freshClient = opts.currentClient()
              if (freshClient) {
                return await freshClient.callTool(
                  { name: tool.name, arguments: args },
                  { signal: execution.signal, timeout: opts.toolCallTimeoutMs, toolDefinition: tool },
                )
              }
            }
          }
          throw callError
        }
      },
    }))
  }

  // Phase 2: swap generations.
  for (const dispose of previous.values()) dispose()
  const disposers: ToolDisposers = new Map()
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, ctx.tools.register(definition))
    }
  } catch (error) {
    // A conflict on an `mcp__<serverName>__`-qualified name means a foreign
    // registration occupies this server's namespace. Roll back so the model
    // sees either the full generation or none of it — never a partial set.
    for (const dispose of disposers.values()) dispose()
    ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
    if (opts.registrationFailure === 'throw') throw error
    return new Map()
  }
  return disposers
}

/** Fields read from canonical content, including policy-owned value replacements. */
interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
  data?: string
  name?: string
  uri?: string
}

/** Async rich projection staged for one exact ToolRuntime execution. */
interface PreparedProjection {
  /** Canonical MCP value returned by execute before registry materialization. */
  value: McpResult
  /** Synchronous output.render projection expected before finalization. */
  fallback: ContentBlock[]
  /** Image-enriched or explicit-refusal projection prepared during execute. */
  content: ContentBlock[]
}

/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to JsonValue. */
function supportedOutputSchema(candidate: unknown): JsonSchemaNode | undefined {
  if (candidate === undefined) return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate
  } catch {
    return undefined
  }
}

/** One upstream MCP tool and the callback that obtains its raw protocol result. */
export interface McpToolDefinitionOptions {
  /** ToolRuntime name presented to the model. */
  name: string
  /** Upstream name used in result diagnostics. */
  rawName: string
  /** Upstream model-facing description. */
  description: string
  /** Upstream JSON input schema. */
  inputSchema: Record<string, unknown>
  /** Advertised structured output schema, when present. */
  outputSchema?: unknown
  /** Whether the upstream tool requires the unsupported task execution extension. */
  taskRequired?: boolean
  /**
   * Obtain one raw MCP result from the provider.
   * @param args - model arguments admitted by the ToolRuntime.
   * @param execution - exact ToolRuntime invocation, including its Agent and cancellation.
   * @returns the external result object, validated before content projection.
   */
  call(args: Record<string, unknown>, execution: ToolExecution): Promise<unknown>
}

/**
 * Adapt an upstream MCP tool to canonical values and durable image content.
 * Registration, provider lifetime, deadlines, and transport belong to the caller.
 * @param ctx - plugin context carrying optional attachment and model services.
 * @param options - upstream tool fields and its raw-result callback.
 * @returns the unregistered ToolRuntime definition.
 */
export function createMcpToolDefinition(
  ctx: Context,
  options: McpToolDefinitionOptions,
): ToolDefinition {
  const { name, rawName, description, inputSchema } = options
  const projections = new WeakMap<ToolExecution, PreparedProjection>()
  return {
    name,
    description,
    parameters: inputSchema,
    output: createOutput(rawName, supportedOutputSchema(options.outputSchema)),
    execute: createExecutor(ctx, options, projections),
    projectContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) {
      const projection = projections.get(exec)
      if (projection === undefined) return undefined
      projections.delete(exec)
      if (result.isError) return undefined
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined
      return projection.content
    },
  }
}

/** Build the canonical result schema and existing Native text projection. */
function createOutput(rawName: string, structuredSchema: JsonSchemaNode | undefined): ToolDefinition['output'] {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args: unknown, value: JsonValue) {
      const result = value as McpResult
      return [{ type: 'text', text: extractText(result.content, rawName) }]
    },
  }
}

/** Extract an egress OAuth connect URL from tool error text, if present. */
function extractAuthUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"'<>]+oauth2\/egress\/connect[^\s"'<>]*/i)?.[0]
}

/** Module-level lock: ensure the browser is opened at most once per authorization flow. */
let authBrowserOpened = false

/**
 * When the gateway returns an egress authorization prompt, open the browser
 * (once) and poll by retrying the tool call until the user completes sign-in
 * or we time out. Returns the real tool result on success.
 */
async function handleEgressAuth(
  authUrl: string,
  argsObj: Record<string, unknown>,
  call: (args: Record<string, unknown>, execution: ToolExecution) => Promise<unknown>,
  exec: ToolExecution,
  ctx: Context,
): Promise<unknown> {
  // Open the authorization page in the user's default browser — only once.
  if (!authBrowserOpened) {
    authBrowserOpened = true
    try {
      ctx.logger.info(`Opening authorization page: ${authUrl}`)
      execSync(`open "${authUrl.replace(/"/g, '\\"')}"`)
      ctx.logger.info('Authorization page opened successfully')
    } catch (error) {
      ctx.logger.error(`Failed to open authorization page: ${String(error)}`)
      // open may fail in headless environments; polling still proceeds.
    }
  } else {
    ctx.logger.info(`Authorization page already opened, waiting for user to complete sign-in at: ${authUrl}`)
  }

  // Poll by retrying the tool call. Once the user authorizes in the browser,
  // the gateway will forward the call to the upstream server and return data.
  const maxAttempts = 24
  const intervalMs = 5_000
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))
    if (exec.signal?.aborted) {
      throw new Error('Waiting for authorization was interrupted. The authorization page is still open in your browser — complete the sign-in there, then ask your question again.')
    }
    try {
      const retryResult = await call(argsObj, exec)
      const retryParsed = specTypeSchemas.CallToolResult['~standard'].validate(retryResult)
      if (retryParsed.issues === undefined && retryParsed.value.isError !== true) {
        return retryResult
      }
    } catch {
      // Authorization not yet complete; keep polling.
    }
  }
  throw new Error(`Authorization timed out after ${Math.round(maxAttempts * intervalMs / 1000)}s. Please open this URL in your browser to complete authorization: ${authUrl}`)
}

/**
 * Invoke the caller-owned raw-result callback and prepare canonical content.
 * MCP isError results reject before image storage so ToolRuntime records failure.
 * Gateway egress authorization prompts trigger automatic browser open + poll.
 */
function createExecutor(
  ctx: Context,
  options: McpToolDefinitionOptions,
  projections: WeakMap<ToolExecution, PreparedProjection>,
): ToolDefinition['execute'] {
  const { rawName, taskRequired } = options
  return async (args: unknown, exec: ToolExecution) => {
    if (taskRequired) {
      throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`)
    }
    // The agent loop passes `JSON.parse(model_arguments)` which is usually an
    // object, but can be any JSON value if the model misbehaves (outputs a bare
    // string/number/null). Fallback to {} lets the MCP server produce a
    // specific "missing required param" error the model can learn from.
    const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const parsed = specTypeSchemas.CallToolResult['~standard'].validate(await options.call(argsObj, exec))
    if (parsed.issues !== undefined) {
      throw new Error(`Tool "${rawName}" returned an invalid MCP result: ${parsed.issues.map(issue => issue.message).join('; ')}`)
    }
    const result = parsed.value

    const content = result.content as unknown as JsonValue[]
    const text = extractText(content, rawName)

    // MCP isError → handle authorization or throw.
    if (result.isError === true) {
      const authUrl = extractAuthUrl(text)
      if (authUrl) {
        // Gateway egress oauth_user mode: user hasn't authorized yet.
        // Open browser and poll until they complete sign-in.
        const authResult = await handleEgressAuth(authUrl, argsObj, options.call, exec, ctx)
        // Re-validate the successful retry result through the normal path.
        const authParsed = specTypeSchemas.CallToolResult['~standard'].validate(authResult)
        if (authParsed.issues !== undefined) {
          throw new Error(`Tool "${rawName}" returned an invalid MCP result after authorization: ${authParsed.issues.map(issue => issue.message).join('; ')}`)
        }
        // Replace result with the authorized response and continue to normal processing.
        return await processResult(ctx, authParsed.value, rawName, exec, projections)
      }
      throw new Error(text)
    }

    return await processResult(ctx, result, rawName, exec, projections)
  }
}

/** Process a validated MCP result into the canonical McpResult shape. */
async function processResult(
  ctx: Context,
  result: { content: unknown; structuredContent?: unknown },
  rawName: string,
  exec: ToolExecution,
  projections: WeakMap<ToolExecution, PreparedProjection>,
): Promise<McpResult<JsonValue>> {
  const content = result.content as unknown as JsonValue[]
  const value: McpResult = {
    content,
    ...result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent as JsonValue }
      : {},
  }
  if (containsImage(content)) {
    const fallback: ContentBlock[] = [{ type: 'text', text: extractText(content, rawName) }]
    const projected = await prepareImageProjection(ctx, exec, content, rawName)
    projections.set(exec, { value, fallback, content: projected })
  }
  return value
}

/** Whether an untrusted MCP content array contains a declared image block. */
function containsImage(content: JsonValue[]): boolean {
  return content.some(value => isRecord(value) && value.type === 'image')
}

/** Narrow one JSON value to a string-keyed object. */
function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a declared MIME string to the durable image vocabulary. */
function isImageMediaType(value: string): value is ImageMediaType {
  return IMAGE_MEDIA_TYPES.includes(value as ImageMediaType)
}

/** Decode one projected image without accepting base64 aliases. */
function decodeImage(block: ImageContent): SaveImageAttachment {
  if (!isImageMediaType(block.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  }
  if (!CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) {
    throw new Error('the image data is not canonical base64')
  }
  return { data, mediaType: block.mimeType }
}

/**
 * Resolve the active model route and durable store for an image-bearing result.
 * @param ctx - plugin context with optional services.
 * @param exec - exact tool execution whose agent supplies the latest route.
 * @returns the attachment store after exact positive image-capability proof.
 */
async function resolveImageAdmission(ctx: Context, exec: ToolExecution): Promise<AttachmentStore> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    throw new Error('the current model route could not be verified')
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (exec.signal.aborted) throw new Error('the tool call was canceled before image storage')
  return attachments
}

/** Stable diagnostic text for an image block that was not admitted. */
function imageDiagnostic(block: McpContentBlock, reason: string): string {
  const mediaType = block.mimeType ?? 'unknown media type'
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`
}

/**
 * Decode, preflight, and durably save one MCP result's ordered image batch.
 * Any refusal projects every image as text while retaining the canonical raw
 * value for programmatic callers.
 */
async function prepareImageProjection(
  ctx: Context,
  exec: ToolExecution,
  content: JsonValue[],
  toolName: string,
): Promise<ContentBlock[]> {
  const decoded: SaveImageAttachment[] = []
  const validationErrors = new Map<number, string>()
  const imageIndexes: number[] = []
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue
    imageIndexes.push(index)
    try {
      decoded.push(decodeImage(value as unknown as ImageContent))
    } catch (error: unknown) {
      // decodeImage owns every throw above and always produces Error.
      validationErrors.set(index, (error as Error).message)
    }
  }
  if (validationErrors.size > 0) {
    return projectContent(content, toolName, (block, index) => ({
      type: 'text',
      text: imageDiagnostic(
        block,
        validationErrors.get(index) ?? 'another image in the same result was invalid',
      ),
    }))
  }

  let attachments: AttachmentStore
  try {
    attachments = await resolveImageAdmission(ctx, exec)
  } catch (error: unknown) {
    // resolveImageAdmission contains provider failures and throws Error only.
    const reason = (error as Error).message
    return projectContent(content, toolName, block => ({ type: 'text', text: imageDiagnostic(block, reason) }))
  }

  try {
    const refs = await attachments.saveImages(decoded)
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset] as ImageAttachmentRef] as const))
    return projectContent(content, toolName, (_block, index) => ({
      type: 'image',
      attachment: byIndex.get(index) as ImageAttachmentRef,
    }))
  } catch (error: unknown) {
    const reason = isImageAdmissionError(error)
      ? `image admission rejected the result: ${error.message}`
      : 'durable image storage rejected the result'
    return projectContent(content, toolName, block => ({
      type: 'text',
      text: imageDiagnostic(block, reason),
    }))
  }
}

/**
 * Extract text from an MCP content array into a single string.
 * - text blocks: join with '\n'
 * - image/audio/resource blocks: replaced with a placeholder
 *
 * Policy-owned canonical-value replacements may omit fields required on the MCP wire.
 */
function extractText(mcpContent: JsonValue[], toolName: string): string {
  const content = projectContent(mcpContent, toolName)
  // The default image projector below also returns text, so this local call
  // cannot produce a core image block.
  return content.map(block => (block as Extract<ContentBlock, { type: 'text' }>).text).join('\n')
}

/**
 * Project ordered MCP blocks into the core content vocabulary.
 * Text-like runs are newline-coalesced; admitted images split those runs at
 * their original position.
 */
function projectContent(
  mcpContent: JsonValue[],
  toolName: string,
  image: (block: McpContentBlock, index: number) => ContentBlock = block => ({
    type: 'text',
    text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
  }),
): ContentBlock[] {
  const projected: ContentBlock[] = []
  const text: string[] = []
  const flushText = (): void => {
    if (text.length === 0) return
    projected.push({ type: 'text', text: text.splice(0).join('\n') })
  }

  for (const [index, value] of mcpContent.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]')
      continue
    }
    const block = value as unknown as McpContentBlock
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) text.push(block.text)
        break
      case 'image':
        flushText()
        projected.push(image(block, index))
        break
      case 'resource_link':
        if (block.name === undefined || block.uri === undefined) {
          text.push('[resource link unavailable: the MCP block is missing its name or URI]')
        } else {
          text.push(`Resource link: ${block.name} (${block.uri})`)
        }
        break
      case 'audio':
        text.push(`[audio result unsupported: ${block.mimeType ?? 'unknown media type'}; raw audio data remains available to programmatic callers]`)
        break
      case 'resource':
        text.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]')
        break
      default:
        text.push(`[unsupported MCP content type: ${block.type}]`)
    }
  }
  flushText()
  return projected.length > 0
    ? projected
    : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }]
}
