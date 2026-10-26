/**
 * Token auto-renewal: re-runs the Keycloak login chain to obtain a fresh
 * gateway token when the current one expires (401).
 *
 * The flow:
 * 1. GET gateway /api/auth/auth/keycloak → follow redirects to Keycloak
 * 2. Extract login form action URL from HTML
 * 3. POST username/password → follow redirects → capture session cookie
 * 4. GET /api/auth/csrf-token with session cookie
 * 5. POST /api/tokens/generate with CSRF token → return fresh JWT
 *
 * @module
 */

/** Credentials for automated Keycloak login. */
export interface KeycloakCredentials {
  /** Keycloak username. */
  username: string
  /** Keycloak password. */
  password: string
}

/** Configuration needed to renew a gateway token. */
export interface TokenRenewalConfig {
  /** Gateway base URL (e.g. https://mcp-test.sensetime-inc.com). */
  gatewayUrl: string
  /** Keycloak credentials for automated login. */
  credentials: KeycloakCredentials
}

/**
 * Extract the login form action URL from Keycloak's HTML response.
 * The HTML contains `&amp;` which must be decoded to `&`.
 */
function extractFormAction(html: string): string {
  const match = html.match(/<form[^>]*\saction="([^"]+)"/i)
  const action = match?.[1]
  if (!action) throw new Error('token-renewal: could not find login form action in Keycloak HTML')
  return action.replace(/&amp;/g, '&')
}

/**
 * Extract all cookies from a Response as a `name=value; ...` header string.
 * Accumulates cookies across manual redirect hops.
 */
function cookiesFromResponse(resp: Response): string[] {
  return (resp.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).filter((c): c is string => !!c)
}

/**
 * Follow redirects manually, accumulating cookies from every hop.
 * Node fetch() with `redirect: 'follow'` discards intermediate Set-Cookie
 * headers; the gateway's `oauth2_temp_session` is set on a mid-chain hop.
 */
async function fetchWithCookieJar(url: string, maxHops = 10): Promise<{ response: Response; allCookiePairs: string[] }> {
  const allCookiePairs: string[] = []
  let current = url
  for (let i = 0; i < maxHops; i++) {
    const resp = await fetch(current, { redirect: 'manual' })
    allCookiePairs.push(...cookiesFromResponse(resp))
    if (resp.status === 301 || resp.status === 302 || resp.status === 303 || resp.status === 307) {
      const loc = resp.headers.get('Location')
      if (loc) {
        current = new URL(loc, url).href
        continue
      }
    }
    return { response: resp, allCookiePairs }
  }
  throw new Error('token-renewal: too many redirects')
}

/**
 * Renew a gateway token by re-running the full Keycloak login chain.
 *
 * @param config - Gateway URL and Keycloak credentials.
 * @returns A fresh JWT access token.
 */
export async function renewGatewayToken(config: TokenRenewalConfig): Promise<string> {
  const { gatewayUrl, credentials } = config
  const base = gatewayUrl.replace(/\/+$/, '')

  // Step 1: Follow the auth redirect chain to Keycloak login page.
  // Manual redirect following to capture cookies from every hop (oauth2_temp_session
  // is set on an intermediate redirect, lost by fetch's built-in follow).
  const { response: authResp, allCookiePairs: jar } = await fetchWithCookieJar(`${base}/api/auth/auth/keycloak`)
  const loginHtml = await authResp.text()

  // Step 2: Extract the form action URL (Keycloak login endpoint).
  const actionUrl = extractFormAction(loginHtml)

  // Step 3: POST credentials with accumulated cookies, DO NOT follow redirects.
  const body = new URLSearchParams({
    username: credentials.username,
    password: credentials.password,
  })
  const loginResp = await fetch(actionUrl, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': jar.join('; '),
    },
  })
  if (loginResp.status !== 302 && loginResp.status !== 303) {
    const respText = await loginResp.text()
    if (respText.includes('Invalid username or password')) {
      throw new Error('token-renewal: invalid credentials')
    }
    throw new Error(`token-renewal: Keycloak login failed: ${loginResp.status}`)
  }

  // Capture any new cookies from the POST response (KEYCLOAK_SESSION etc.)
  jar.push(...cookiesFromResponse(loginResp))

  // Step 4: GET the callback Location with ALL cookies (critical: oauth2_temp_session
  // must be present or the gateway returns 400).
  const location = loginResp.headers.get('Location')
  if (!location) {
    throw new Error('token-renewal: no Location header after login POST')
  }
  const callbackResp = await fetch(location, {
    redirect: 'manual',
    headers: { 'Cookie': jar.join('; ') },
  })
  if (callbackResp.status !== 200 && callbackResp.status !== 302) {
    throw new Error(`token-renewal: callback failed: ${callbackResp.status}`)
  }
  // Capture mcp_gateway_session from the callback response
  jar.push(...cookiesFromResponse(callbackResp))

  // Step 4: Get CSRF token using the session cookie.
  const sessionCookie = jar.find(c => c.startsWith('mcp_gateway_session='))?.split('=')[1]
  if (!sessionCookie) {
    throw new Error('token-renewal: no mcp_gateway_session cookie after login — credentials may be invalid')
  }
  const csrfResp = await fetch(`${base}/api/auth/csrf-token`, {
    headers: { Cookie: `mcp_gateway_session=${sessionCookie}` },
  })
  if (!csrfResp.ok) {
    throw new Error(`token-renewal: CSRF token fetch failed: ${csrfResp.status}`)
  }
  const csrfDoc = await csrfResp.json() as { csrf_token?: string }
  const csrfToken = csrfDoc.csrf_token
  if (!csrfToken) {
    throw new Error('token-renewal: no csrf_token in response')
  }

  // Step 5: Generate a fresh gateway token.
  const tokenResp = await fetch(`${base}/api/tokens/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: `mcp_gateway_session=${sessionCookie}`,
    },
    body: JSON.stringify({ expires_in_hours: 24 }),
  })
  if (!tokenResp.ok) {
    throw new Error(`token-renewal: token generation failed: ${tokenResp.status}`)
  }
  const tokenDoc = await tokenResp.json() as { tokens?: { access_token?: string } }
  const accessToken = tokenDoc.tokens?.access_token
  if (!accessToken) {
    throw new Error('token-renewal: no access_token in generate response')
  }

  return accessToken
}
