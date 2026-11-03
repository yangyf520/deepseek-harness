/**
 * Egress authorization callback handler: serves a success page that auto-closes
 * the browser window after the user completes OAuth authorization on the gateway.
 *
 * @module
 */

import { createServer, type Server } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'

/** Localhost callback server for egress authorization completion. */
export interface EgressCallbackServer {
  /** The callback URL (e.g., `http://127.0.0.1:PORT/mcp-egress-callback`). */
  callbackUrl: string
  /** Stop the server and release the port. */
  dispose: () => Promise<void>
}

/** HTML page served after successful egress authorization. */
function buildSuccessPage(locale: 'zh_CN' | 'en'): string {
  const nonce = randomBytes(16).toString('base64url')
  const message = locale === 'zh_CN'
    ? '授权成功！此窗口将自动关闭。'
    : 'Authorization successful! This window will close automatically.'
  return `<!doctype html>
<html lang="${locale === 'zh_CN' ? 'zh-CN' : 'en'}">
<meta charset="utf-8">
<title>${message}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'">
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  .check { color: #22c55e; font-size: 3rem; margin-bottom: 1rem; }
  p { color: #333; margin: 0.5rem 0; }
</style>
<body>
  <div class="card">
    <div class="check">✓</div>
    <p>${message}</p>
    <p style="color: #666; font-size: 0.875rem; margin-top: 1rem;">
      ${locale === 'zh_CN' ? '如果窗口没有自动关闭，请手动关闭。' : 'If the window does not close automatically, please close it manually.'}
    </p>
  </div>
  <script nonce="${nonce}">
    // Attempt to close the window after a brief delay
    setTimeout(function() {
      window.close();
      // If close() was blocked (e.g., not opened by script), show a message
      setTimeout(function() {
        if (!window.closed) {
          document.querySelector('p:last-child').style.display = 'block';
        }
      }, 500);
    }, 1500);
  </script>
</body>
</html>`
}

/**
 * Start a local HTTP server to handle egress authorization callbacks.
 * The server serves a success page that attempts to auto-close the browser window.
 *
 * @param ctx - Cordis context for logging.
 * @param preferredPort - Preferred port (0 for random).
 * @returns Callback server handle with URL and dispose function.
 */
export async function startEgressCallbackServer(
  ctx: Context,
  preferredPort = 0,
): Promise<EgressCallbackServer> {
  const label = 'mcp-client(egress-callback)'

  const server: Server = createServer((req, res) => {
    // Detect locale from Accept-Language header
    const acceptLang = req.headers['accept-language'] ?? ''
    const locale = acceptLang.startsWith('zh') ? 'zh_CN' : 'en'

    ctx.logger.info(`${label}: received callback from ${req.url}`)

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(buildSuccessPage(locale))
  })

  // Start listening on localhost
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(preferredPort, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error(`${label}: failed to bind callback server`)
  }

  const callbackUrl = `http://127.0.0.1:${address.port}/mcp-egress-callback`
  ctx.logger.info(`${label}: listening on ${callbackUrl}`)

  return {
    callbackUrl,
    dispose: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Force close after 5 seconds
        setTimeout(() => resolve(), 5000).unref()
      })
      ctx.logger.info(`${label}: server disposed`)
    },
  }
}

/**
 * Modify an egress authorization URL to redirect to our local callback server.
 * Replaces or adds the redirect_uri parameter.
 *
 * @param authUrl - Original authorization URL from gateway error.
 * @param callbackUrl - Local callback URL to redirect to after authorization.
 * @returns Modified authorization URL with local redirect_uri.
 */
export function rewriteAuthRedirectUri(authUrl: string, callbackUrl: string): string {
  try {
    const url = new URL(authUrl)
    url.searchParams.set('redirect_uri', callbackUrl)
    // Also try common alternative parameter names
    url.searchParams.set('redirect_uri', callbackUrl)
    url.searchParams.set('return_to', callbackUrl)
    url.searchParams.set('callback', callbackUrl)
    return url.toString()
  } catch {
    // If URL parsing fails, append redirect_uri as query parameter
    const separator = authUrl.includes('?') ? '&' : '?'
    return `${authUrl}${separator}redirect_uri=${encodeURIComponent(callbackUrl)}`
  }
}
