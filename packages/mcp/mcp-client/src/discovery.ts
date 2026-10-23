/**
 * Gateway virtual-server discovery: polls the gateway's control-plane API to
 * find available virtual servers, automatically creates connections for new
 * ones and disposes connections for removed ones.
 *
 * One watcher manages N supervised connections (one per discovered virtual
 * server); each connection reuses the existing reconnect supervisor and tool
 * bridge from `connection.ts`. The watcher itself polls on a fixed interval
 * with exponential backoff on errors.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { startConnection, resolveReconnectPolicy } from './connection.ts'
import type { ConnectionHandle, ReconnectConfig } from './connection.ts'
import { renewGatewayToken } from './token-renewal.ts'
import type { KeycloakCredentials, TokenRenewalConfig } from './token-renewal.ts'
import { registerServerContext } from './server-context.ts'
import type { StreamableHttpConfig } from './index.ts'

/** Default interval between discovery polls (ms). */
const DEFAULT_POLL_INTERVAL_MS = 60_000

/** Default endpoint path for listing virtual servers on the gateway. */
const DEFAULT_DISCOVERY_ENDPOINT = '/api/virtual-servers'

/** Default timeout for the initial discovery poll (ms). */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

/** Configuration for gateway virtual-server auto-discovery. */
export interface WatchDiscoveryConfig {
  /** Gateway base URL (e.g. `https://mcp-gateway.example.com`). */
  gatewayUrl: string
  /** Keycloak credentials for gateway authentication and token renewal. */
  credentials: KeycloakCredentials
  /** Polling interval in milliseconds (default 60000). */
  pollIntervalMs?: number
  /**
   * Gateway API endpoint that returns the virtual server list.
   * Absolute path (e.g. `/api/virtual-servers`) or full URL.
   * Default: `/api/virtual-servers`.
   */
  discoveryEndpoint?: string
  /**
   * When non-empty, only virtual servers whose `path` segment matches one of
   * these strings are connected; empty or omitted means all enabled servers.
   */
  serverFilter?: string[]
  /**
   * Maximum time (ms) to wait for the first discovery poll before continuing
   * in the background. Default 30000.
   */
  startupTimeoutMs?: number
}

/** Configuration for the gateway discovery watcher. */
export interface GatewayWatcherConfig {
  /** Discovery polling config. */
  watchDiscovery: WatchDiscoveryConfig
  /** Per-connection tool call timeout (ms). */
  toolCallTimeoutMs: number
  /** Per-connection fail-on-startup-error flag. */
  failOnStartupError: boolean
  /** Per-connection reconnect policy. */
  reconnect: ReconnectConfig | undefined
}

/** Handle returned by the watcher; call `dispose` to stop all managed connections. */
export interface GatewayWatcherHandle {
  /** Settles after the first discovery poll completes (success or failure). */
  ready: Promise<void>
  /** Stop polling, dispose every managed connection, release all namespaces. */
  dispose(): Promise<void>
}

/** One entry from `GET /api/virtual-servers`. */
interface VirtualServerEntry {
  path: string
  server_name?: string
  description?: string
  is_enabled?: boolean
  tool_mappings?: Array<{ tool_name: string; alias?: string | null }>
}

/**
 * Start the gateway discovery watcher. The watcher authenticates with the
 * gateway, polls for virtual servers, and manages one supervised connection
 * per discovered server.
 *
 * @param ctx - Cordis context for tool registration and logging.
 * @param watcherConfig - Discovery and per-connection parameters.
 * @returns A handle whose `ready` settles after the first poll and whose
 *   `dispose` tears down every managed connection.
 */
export function startGatewayWatcher(
  ctx: Context,
  watcherConfig: GatewayWatcherConfig,
): GatewayWatcherHandle {
  const { watchDiscovery, toolCallTimeoutMs, failOnStartupError, reconnect: reconnectConfig } = watcherConfig
  const gatewayOrigin = new URL(watchDiscovery.gatewayUrl).origin
  const pollIntervalMs = watchDiscovery.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const startupTimeoutMs = watchDiscovery.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const discoveryUrl = resolveDiscoveryUrl(gatewayOrigin, watchDiscovery.discoveryEndpoint)
  const label = 'mcp-client(gateway-discovery)'

  const renewalConfig: TokenRenewalConfig = {
    gatewayUrl: gatewayOrigin,
    credentials: watchDiscovery.credentials,
  }

  const policy = resolveReconnectPolicy(reconnectConfig, `${label}: reconnect`)

  /** Active connections keyed by sanitized server name. */
  const connections = new Map<string, { handle: ConnectionHandle; vsPath: string }>()
  let currentToken: string | undefined
  let disposed = false
  let pollTimer: NodeJS.Timeout | undefined

  /** Acquire or refresh the gateway JWT via the Keycloak login chain. */
  async function ensureToken(): Promise<string> {
    ctx.logger.info(`${label}: acquiring gateway token...`)
    currentToken = await renewGatewayToken(renewalConfig)
    ctx.logger.info(`${label}: gateway token acquired`)
    return currentToken
  }

  /** Fetch enabled virtual servers from the gateway control plane. */
  async function fetchVirtualServers(token: string): Promise<VirtualServerEntry[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    timer.unref()
    try {
      const resp = await fetch(discoveryUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!resp.ok) {
        throw new Error(`${label}: GET ${discoveryUrl} returned ${resp.status}`)
      }
      const data = await resp.json() as VirtualServerEntry[] | Record<string, unknown>
      return extractVirtualServers(data).filter(vs => vs.is_enabled !== false)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Extract the virtual server array from a gateway response.
   * Supports a bare JSON array or an object with a `virtual_servers` key.
   */
  function extractVirtualServers(data: unknown): VirtualServerEntry[] {
    if (Array.isArray(data)) return data as VirtualServerEntry[]
    if (data && typeof data === 'object') {
      const vs = (data as Record<string, unknown>).virtual_servers
      if (Array.isArray(vs)) return vs as VirtualServerEntry[]
    }
    return []
  }

  /** Derive a `serverName`-safe identifier from a virtual server path. */
  function sanitizeServerName(vsPath: string): string {
    const segment = vsPath.replace(/^virtual\//, '').split('/').pop() ?? vsPath
    return segment
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32)
  }

  /** Build a StreamableHttpConfig for one discovered virtual server. */
  function buildVsConfig(vs: VirtualServerEntry, token: string): StreamableHttpConfig {
    const vsPath = vs.path.startsWith('/') ? vs.path : `/${vs.path}`
    // The MCP endpoint is at `{vsPath}/mcp` (e.g. `/virtual/yangyufeng/mcp`).
    const mcpEndpointPath = `${vsPath}/mcp`
    const serverName = sanitizeServerName(vsPath)
    const base: StreamableHttpConfig = {
      transport: 'streamable-http',
      serverName,
      url: `${gatewayOrigin}${mcpEndpointPath}`,
      headers: { authorization: `Bearer ${token}` },
      toolCallTimeoutMs,
      failOnStartupError,
    }
    if (reconnectConfig !== undefined) {
      base.reconnect = reconnectConfig
    }
    return base
  }

  /** Start a connection for one discovered virtual server. */
  function startVsConnection(vs: VirtualServerEntry, token: string): void {
    const vsPath = vs.path
    const serverName = sanitizeServerName(vsPath)

    if (connections.has(serverName)) return

    ctx.logger.info(`${label}: discovered virtual server "${vsPath}", connecting as "${serverName}"...`)

    const vsConfig = buildVsConfig(vs, token)
    const handle = startConnection(ctx, vsConfig, policy, renewalConfig)
    registerServerContext(ctx, serverName, handle)
    connections.set(serverName, { handle, vsPath })

    void handle.ready.then((outcome) => {
      if (outcome.error) {
        ctx.logger.warn(`${label}: virtual server "${serverName}" initial connection failed: ${String(outcome.error)}`)
      } else {
        const toolCount = vs.tool_mappings?.length ?? '?'
        ctx.logger.info(`${label}: virtual server "${serverName}" connected (${toolCount} tools mapped)`)
      }
    })
  }

  /** Dispose the connection for a virtual server that disappeared from the gateway. */
  async function stopVsConnection(serverName: string): Promise<void> {
    const entry = connections.get(serverName)
    if (!entry) return
    ctx.logger.info(`${label}: virtual server "${serverName}" removed from gateway, disconnecting...`)
    connections.delete(serverName)
    await entry.handle.dispose()
  }

  /** One discovery cycle: authenticate, list, diff, connect/disconnect. */
  async function pollOnce(): Promise<void> {
    try {
      const token = await ensureToken()
      const servers = await fetchVirtualServers(token)

      const discovered = new Set<string>()
      for (const vs of servers) {
        const name = sanitizeServerName(vs.path)
        discovered.add(name)
        if (!connections.has(name)) {
          startVsConnection(vs, token)
        }
      }

      for (const existing of [...connections.keys()]) {
        if (!discovered.has(existing)) {
          await stopVsConnection(existing)
        }
      }

      ctx.logger.info(`${label}: poll complete — ${connections.size} virtual server(s) active`)
    } catch (error) {
      ctx.logger.error(`${label}: discovery poll failed: ${String(error)}`)
    }
  }

  // First poll immediately, then on interval. The initial ready promise
  // races with a timeout so a slow auth chain or network hiccup cannot
  // block the host startup forever — the watcher keeps trying in background.
  const ready = Promise.race([
    pollOnce(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ctx.logger.warn(`${label}: initial discovery timed out after ${startupTimeoutMs}ms, continuing in background`)
        resolve()
      }, startupTimeoutMs)
      timer.unref()
    }),
  ])

  const scheduleNext = (): void => {
    if (disposed) return
    pollTimer = setTimeout(() => {
      void pollOnce().finally(scheduleNext)
    }, pollIntervalMs)
    pollTimer.unref()
  }
  void ready.finally(scheduleNext)

  return {
    ready,
    async dispose(): Promise<void> {
      disposed = true
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer)
        pollTimer = undefined
      }
      const pending = [...connections.values()].map(entry => entry.handle.dispose())
      connections.clear()
      await Promise.allSettled(pending)
      ctx.logger.info(`${label}: watcher disposed, all virtual server connections closed`)
    },
  }
}

/**
 * Resolve the discovery URL from the gateway origin and an optional endpoint
 * path. Accepts an absolute path (`/api/servers`) or a bare endpoint name
 * (`servers` → `/api/servers`). Omitted uses the default endpoint.
 */
function resolveDiscoveryUrl(gatewayOrigin: string, endpoint?: string): string {
  const base = gatewayOrigin.replace(/\/+$/, '')
  if (!endpoint) return `${base}${DEFAULT_DISCOVERY_ENDPOINT}`
  const path = endpoint.startsWith('/') ? endpoint : `/api/${endpoint}`
  return `${base}${path}`
}
