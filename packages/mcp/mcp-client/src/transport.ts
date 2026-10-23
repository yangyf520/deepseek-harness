/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { StdioConfig, StreamableHttpConfig } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Options for creating a transport, beyond what the plugin config provides.
 * Used by the connection supervisor to inject per-connection capabilities
 * such as dynamic headers for token renewal.
 */
export interface TransportExtras {
  /** Returns current headers; called per-request to pick up renewed tokens. */
  headersProvider?: () => Record<string, string>
}

/**
 * Wrap fetch to normalize MCP session ID header casing.
 * The gateway returns `Mcp-Session-Id` (mixed case) but the SDK looks for
 * `mcp-session-id` (lowercase). While HTTP headers are case-insensitive per
 * spec, some fetch implementations may not handle this correctly.
 */
function createSessionIdNormalizingFetch(): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    // Create a new Headers object with normalized casing for MCP headers
    const normalizedHeaders = new Headers()
    response.headers.forEach((value, key) => {
      normalizedHeaders.set(key.toLowerCase(), value)
    })
    // Return a new Response with normalized headers
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: normalizedHeaders,
    })
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param extras - Optional per-connection overrides (e.g. authProvider).
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: StdioConfig | StreamableHttpConfig, extras?: TransportExtras): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      const httpOpts: StreamableHTTPClientTransportOptions = {
        requestInit: extras?.headersProvider
          ? { get headers() { return extras.headersProvider?.() ?? {} } }
          : { headers: config.headers },
        // Use fetch wrapper to normalize MCP session ID header casing
        fetch: createSessionIdNormalizingFetch(),
      }
      return new StreamableHTTPClientTransport(new URL(config.url), httpOpts)
    }
  }
}
