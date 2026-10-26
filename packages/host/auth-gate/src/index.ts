/**
 * auth-gate host plugin: OAuth identity resolution and HTTP gate.
 * Reuses the framework's browser-auth for SPA access; this plugin only
 * resolves "who is the user" via OAuth and sets an identity cookie.
 */

import { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/* ── Identity types ─────────────────────────────────────────────────────── */

/** Authenticated user derived from OAuth provider. */
export interface AuthUser {
  provider: string
  userId: string
  displayName?: string
  englishName?: string
  avatarUrl?: string
  tenantId?: string
  role?: 'admin' | 'member'
}

/** Browser principal carrying the authenticated user. */
export interface AuthPrincipal {
  user: AuthUser
}

export const IDENTITY_COOKIE = 'dsh-identity'

/** Derive role from SUPER_ADMIN_USERS env — server-authoritative, never from cookie. */
export function resolveRole(user: AuthUser): 'admin' | 'member' {
  const allowlist = process.env.SUPER_ADMIN_USERS
    ?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) ?? []
  if (allowlist.length === 0) return 'member'
  const keys = [user.userId, user.englishName]
    .map(v => v?.trim().toLowerCase()).filter((v): v is string => v !== undefined)
  return keys.some(key => allowlist.includes(key)) ? 'admin' : 'member'
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.split(':')[0]
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://x').pathname
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookie = req.headers.cookie
  if (!cookie) return {}
  return Object.fromEntries(
    cookie.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=')
      return [k, v.join('=')]
    }),
  )
}

function setIdentityCookie(res: ServerResponse, user: AuthUser): void {
  // Strip role and tenantId — always re-derived server-side from SUPER_ADMIN_USERS.
  const { role: _r, tenantId: _t, ...safe } = user
  const json = Buffer.from(JSON.stringify(safe)).toString('base64url')
  res.setHeader('set-cookie', `${IDENTITY_COOKIE}=${json}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`)
}

/** Read the authenticated user from the identity cookie, if present. */
export function userFromCookie(req: IncomingMessage): AuthUser | undefined {
  const raw = parseCookies(req)[IDENTITY_COOKIE]
  if (!raw) return undefined
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString()) as AuthUser
  } catch {
    return undefined
  }
}

/* ── OAuth presets ──────────────────────────────────────────────────────── */

interface OAuth2Preset {
  authorizeUrl: string
  tokenUrl: string
  userinfoUrl: string
  scope: string
  claims: { userId: string; displayName?: string; englishName?: string; avatar?: string }
}

const OAUTH2_PRESETS = {
  feishu: {
    authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    tokenUrl: 'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    userinfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info',
    scope: 'contact:user.base:readonly',
    claims: { userId: 'open_id', displayName: 'name', englishName: 'en_name', avatar: 'avatar_url' },
  },
  dingtalk: {
    authorizeUrl: 'https://login.dingtalk.com/oauth2/auth',
    tokenUrl: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
    userinfoUrl: 'https://api.dingtalk.com/v1.0/contact/users/me',
    scope: 'openid',
    claims: { userId: 'unionId', displayName: 'nick', avatar: 'avatarUrl' },
  },
  wecom: {
    authorizeUrl: 'https://open.weixin.qq.com/connect/oauth2/authorize',
    tokenUrl: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
    userinfoUrl: 'https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo',
    scope: 'snsapi_base',
    claims: { userId: 'UserId', displayName: 'Name', avatar: 'Avatar' },
  },
  'wechat-scan': {
    authorizeUrl: 'https://open.weixin.qq.com/connect/qrconnect',
    tokenUrl: 'https://api.weixin.qq.com/sns/oauth2/access_token',
    userinfoUrl: 'https://api.weixin.qq.com/sns/userinfo',
    scope: 'snsapi_login',
    claims: { userId: 'openid', displayName: 'nickname', avatar: 'headimgurl' },
  },
} as const satisfies Record<string, OAuth2Preset>

export type BuiltinPreset = keyof typeof OAUTH2_PRESETS

export interface ChannelConfig {
  preset: BuiltinPreset
  enabled: boolean
  appId: string
  appSecretRef: string
  redirectUri: string
}

function effectivePreset(channel: ChannelConfig): OAuth2Preset {
  return OAUTH2_PRESETS[channel.preset]
}

const PROVIDER_LABELS: Record<string, string> = {
  feishu: '飞书 Feishu', dingtalk: '钉钉 DingTalk', wecom: '企业微信 WeCom', 'wechat-scan': '微信扫码 WeChat',
}

/** True when at least one channel is fully configured. */
function gateActive(channels: Record<string, ChannelConfig>): boolean {
  for (const channel of Object.values(channels)) {
    if (channel.enabled === false) continue
    if (channel.appId && channel.appSecretRef && channel.redirectUri) return true
  }
  return false
}

function enabledChannels(channels: Record<string, ChannelConfig>): [string, ChannelConfig][] {
  return Object.entries(channels).filter(([, c]) =>
    c.enabled !== false && Boolean(c.appId && c.appSecretRef && c.redirectUri))
}

/* ── OAuth flow ─────────────────────────────────────────────────────────── */

export function effectiveRedirectUri(
  configured: string,
  req: { headers: { host?: string | string[] | undefined } },
): string {
  const hostHeader = req.headers.host
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  if (!host) return configured
  try {
    const redirect = new URL(configured)
    const request = new URL(`http://${host}`)
    if (!isLoopbackHostname(redirect.hostname)) return configured
    redirect.hostname = request.hostname
    redirect.port = request.port
    return redirect.toString()
  } catch {
    return configured
  }
}

interface CredentialsResolve {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
}

async function resolveAppSecret(ctx: Context, refName: string): Promise<string> {
  if (refName === '__env_oauth_secret__' || refName === '__env_lark_secret__') {
    const secret = process.env.OAUTH_APP_SECRET ?? process.env.LARK_APP_SECRET
    if (!secret) throw new Error('OAUTH_APP_SECRET env is not set')
    return secret
  }
  const credentials = ctx.get('credentials') as CredentialsResolve | undefined
  if (!credentials) throw new Error('ctx.credentials is required to resolve appSecretRef')
  const resolved = await credentials.resolve(credentialRef(refName))
  if (!resolved) throw new Error(`credential "${refName}" is not configured`)
  return resolved.value
}

const STATE_TTL_MS = 10 * 60 * 1000
const pendingStates = new Map<string, { channelId: string; expiresAt: number; redirectUri: string }>()

function pruneExpiredStates(): void {
  const now = Date.now()
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt <= now) pendingStates.delete(state)
  }
}

function channelIdFromPath(pathname: string, prefix: string): string {
  if (!pathname.startsWith(prefix)) return ''
  return pathname.slice(prefix.length).split('/').filter(Boolean)[0] ?? ''
}

async function exchangeCode(
  channel: ChannelConfig, preset: OAuth2Preset, code: string, secret: string, redirectUri: string,
): Promise<string> {
  if (channel.preset === 'wecom') {
    const url = new URL(preset.tokenUrl)
    url.searchParams.set('corpid', channel.appId)
    url.searchParams.set('corpsecret', secret)
    const res = await fetch(url.toString())
    const data = await res.json() as Record<string, string>
    return data.access_token ?? ''
  }
  const payload = {
    grant_type: 'authorization_code', client_id: channel.appId,
    client_secret: secret, code, redirect_uri: redirectUri,
  }
  const useJson = channel.preset === 'feishu' || channel.preset === 'dingtalk'
  const res = await fetch(preset.tokenUrl, {
    method: 'POST',
    body: useJson ? JSON.stringify(payload) : new URLSearchParams(payload),
    headers: { 'content-type': useJson ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' },
  })
  const data = await res.json() as Record<string, unknown>
  const errCode = data.code
  if (typeof errCode === 'number' && errCode !== 0) {
    throw new Error(`token exchange failed: ${String(data.error_description ?? data.error ?? data.msg ?? '')}`)
  }
  const token = data.access_token ?? data.user_access_token
  if (typeof token !== 'string' || !token) throw new Error('token exchange returned no access_token')
  return token
}

async function fetchUserInfo(preset: OAuth2Preset, token: string): Promise<Record<string, string>> {
  const res = await fetch(preset.userinfoUrl, { headers: { authorization: `Bearer ${token}` } })
  const data = await res.json() as Record<string, unknown>
  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`userinfo failed: ${String(data.msg ?? data.error ?? '')}`)
  }
  const nested = data.data
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, string>
  return data as Record<string, string>
}

function mapClaims(preset: OAuth2Preset, raw: Record<string, string>): AuthUser {
  const user: AuthUser = { provider: 'oauth2', userId: raw[preset.claims.userId] ?? '' }
  const dn = preset.claims.displayName ? raw[preset.claims.displayName] : undefined
  if (dn !== undefined) user.displayName = dn
  const en = preset.claims.englishName ? raw[preset.claims.englishName] : undefined
  if (en !== undefined) user.englishName = en
  const av = preset.claims.avatar ? raw[preset.claims.avatar] : undefined
  if (av !== undefined) user.avatarUrl = av
  return user
}

/* ── Route handlers ─────────────────────────────────────────────────────── */

/** GET /auth — redirect to sole channel or show minimal login links. */
function landingHandler(channels: Record<string, ChannelConfig>, req: IncomingMessage, res: ServerResponse): void {
  const enabled = enabledChannels(channels)
  if (enabled.length === 0) { res.writeHead(503); res.end('No OAuth channels configured'); return }
  const sole = enabled[0]
  if (enabled.length === 1 && sole !== undefined) {
    beginLogin(channels, sole[0], req, res)
    return
  }
  const links = enabled.map(([id]) =>
    `<a href="/auth/login/${encodeURIComponent(id)}" style="display:block;padding:10px;margin:8px 0;background:#333;color:#fff;text-decoration:none;border-radius:6px;text-align:center">${PROVIDER_LABELS[id] ?? id}</a>`,
  ).join('')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sign in</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui;background:#0b0d10;color:#e8eaed}
.card{width:min(320px,90vw);padding:24px;border:1px solid #333;border-radius:12px;background:#14181d}h1{margin:0 0 16px;font-size:18px}</style>
</head><body><div class="card"><h1>Sign in</h1>${links}</div></body></html>`)
}

/** GET /auth/login/:channel — begin OAuth for a specific channel. */
function loginHandler(channels: Record<string, ChannelConfig>, req: IncomingMessage, res: ServerResponse): void {
  const channelId = channelIdFromPath(pathnameOf(req), '/auth/login/')
  beginLogin(channels, channelId, req, res)
}

function beginLogin(channels: Record<string, ChannelConfig>, channelId: string, req: IncomingMessage, res: ServerResponse): void {
  const channel = channels[channelId]
  if (!channel || channel.enabled === false) { res.writeHead(404); res.end('channel not found'); return }
  pruneExpiredStates()
  const state = randomUUID()
  const redirectUri = effectiveRedirectUri(channel.redirectUri, req)
  pendingStates.set(state, { channelId, expiresAt: Date.now() + STATE_TTL_MS, redirectUri })
  const preset = effectivePreset(channel)
  const url = new URL(preset.authorizeUrl)
  url.searchParams.set('client_id', channel.appId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', preset.scope)
  url.searchParams.set('state', state)
  if (channel.preset === 'wechat-scan') url.searchParams.set('appid', channel.appId)
  res.writeHead(302, { location: url.toString() })
  res.end()
}

/** GET /auth/callback/:channel — OAuth callback, exchanges code for identity. */
async function callbackHandler(
  ctx: Context, channels: Record<string, ChannelConfig>,
  req: IncomingMessage, res: ServerResponse,
  getAuthenticatedUrl: (base: string) => string,
): Promise<void> {
  const channelId = channelIdFromPath(pathnameOf(req), '/auth/callback/')
  const channel = channels[channelId]
  if (!channel || channel.enabled === false) { res.writeHead(404); res.end('channel not found'); return }
  const url = new URL(req.url ?? '', 'http://x')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code) { res.writeHead(400); res.end('missing code'); return }
  pruneExpiredStates()
  const pending = state ? pendingStates.get(state) : undefined
  if (!pending || pending.channelId !== channelId) { res.writeHead(400); res.end('invalid or expired state'); return }
  pendingStates.delete(state as string)
  try {
    const preset = effectivePreset(channel)
    const secret = await resolveAppSecret(ctx, channel.appSecretRef)
    const token = await exchangeCode(channel, preset, code, secret, pending.redirectUri)
    const raw = await fetchUserInfo(preset, token)
    const user = mapClaims(preset, raw)
    if (!user.userId) { res.writeHead(502); res.end('userinfo missing user id'); return }
    user.provider = channelId
    // Set identity cookie (no server-side session needed)
    setIdentityCookie(res, user)
    // Inject identity into globalThis for auth-tenant
    ;(globalThis as Record<string, unknown>).__dshAuthPrincipal__ = { user } as AuthPrincipal
    // Bind to auth-tenant if available
    const authTenant = ctx.get('authTenant') as { bindAuthPrincipal?(p: AuthPrincipal): string | undefined } | undefined
    authTenant?.bindAuthPrincipal?.({ user })
    // Complete browser-auth handshake via launch token
    const origin = new URL(pending.redirectUri).origin
    const launchToken = getAuthenticatedUrl(`${origin}/`).split('?token=')[1] ?? ''
    res.writeHead(303, { location: `${origin}/auth/complete?token=${encodeURIComponent(launchToken)}&redirect=/` })
    res.end()
  } catch (err) {
    res.writeHead(500)
    res.end(`OAuth callback failed: ${String(err)}`)
  }
}

/** GET /auth/complete — bridge to browser-auth token exchange. */
function completeHandler(getAuthenticatedUrl: (base: string) => string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const token = url.searchParams.get('token')
  if (!token) { res.writeHead(400); res.end('missing token'); return }
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  const redirect = host ? getAuthenticatedUrl(`http://${host}/`) : '/'
  res.writeHead(303, { location: redirect, 'cache-control': 'no-store' })
  res.end()
}

/* ── Plugin entry ───────────────────────────────────────────────────────── */

export const name = 'auth-gate'

/**
 * Lightweight OAuth identity plugin.
 * - HTTP gate: checks identity cookie, sets globalThis principal, redirects if missing.
 * - OAuth routes: /auth, /auth/login/:id, /auth/callback/:id, /auth/complete.
 * - No server-side session Map — identity is self-contained in the cookie.
 */
export function apply(ctx: Context): void {
  const channels: Record<string, ChannelConfig> = {}

  // Load channels from env
  const envChannels = process.env.AUTH_CHANNELS
  if (envChannels) {
    try {
      Object.assign(channels, JSON.parse(envChannels) as Record<string, ChannelConfig>)
      ctx.logger.info('auth-gate: loaded %d channel(s) from AUTH_CHANNELS', Object.keys(channels).length)
    } catch (err) {
      ctx.logger.error('auth-gate: failed to parse AUTH_CHANNELS:', err)
    }
  } else {
    const appId = process.env.OAUTH_APP_ID ?? process.env.LARK_APP_ID
    const appSecret = process.env.OAUTH_APP_SECRET ?? process.env.LARK_APP_SECRET
    const preset = (process.env.OAUTH_TYPE ?? process.env.OAUTH_PRESET ?? 'feishu') as ChannelConfig['preset']
    if (appId && appSecret) {
      channels[preset] = { preset, enabled: true, appId, appSecretRef: '__env_oauth_secret__', redirectUri: `http://localhost:3080/auth/callback/${preset}` }
      ctx.logger.info('auth-gate: loaded %s channel from env', preset)
    }
  }

  ctx.inject(['webServer', 'connection'], (sctx) => {
    const conn = sctx.get('connection') as { authenticatedUrl?(base: string): string } | undefined
    const getAuthenticatedUrl = (base: string): string => conn?.authenticatedUrl?.(base) ?? base

    // Lightweight HTTP gate: check identity cookie, no server-side session.
    sctx.on('webserver/request', (req, res, next) => {
      if (!gateActive(channels)) return next()
      const pathname = pathnameOf(req)
      if (pathname === '/auth' || pathname.startsWith('/auth/')) return next()
      if (pathname === '/manifest.webmanifest' || pathname === '/favicon.ico') return next()
      const raw = userFromCookie(req)
      if (raw) {
        raw.role = resolveRole(raw)
        ;(globalThis as Record<string, unknown>).__dshAuthPrincipal__ = { user: raw } as AuthPrincipal
        // If identity cookie is valid but browser-auth cookie is missing (e.g. after server restart),
        // redirect through /auth/complete to re-establish browser-auth's signed cookie.
        // Skip when browser-auth cookie already present (dsh-auth-* prefix) or URL carries token.
        const url = new URL(req.url ?? '/', 'http://x')
        const cookies = req.headers.cookie ?? ''
        const hasBrowserAuth = /dsh-auth-/.test(cookies)
        if (req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('token') && !hasBrowserAuth) {
          const proto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'] : 'http'
          const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host ?? '127.0.0.1:3080'
          const launchUrl = getAuthenticatedUrl(`${proto}://${host}/`)
          const token = launchUrl.split('?token=')[1]
          if (token) {
            res.writeHead(303, { location: `/auth/complete?token=${encodeURIComponent(token)}&redirect=/` })
            res.end()
            return Promise.resolve()
          }
        }
        return next()
      }
      res.writeHead(302, { location: '/auth' })
      res.end()
      return Promise.resolve()
    })

    // WebSocket upgrade gate
    sctx.on('webserver/upgrade', (req, _socket, _head, next) => {
      if (!gateActive(channels)) return next()
      if (userFromCookie(req)) return next()
      _socket.destroy()
      return Promise.resolve()
    })

    // /auth/me — return current user info from identity cookie.
    sctx.webServer.register({ kind: 'exact', path: '/auth/me', handler: (req, res) => {
      const user = userFromCookie(req)
      if (!user) { res.writeHead(401); res.end('not authenticated'); return }
      user.role = resolveRole(user)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(user))
    } })

    // Inject sidebar user-info script into SPA HTML.
    sctx.webServer.tapIndex((html) => {
      const script = '<script>fetch(\'/auth/me\').then(r=>r.ok?r.json():null).then(u=>{if(!u||!u.displayName)return;function tryMount(){if(document.getElementById(\'dsh-user-info\'))return false;var btn=document.querySelector(\'[aria-label*="\u8d26\u53f7"]\');if(!btn)return true;var sa=btn.closest(\'[class*="ettingsArea"]\')||btn.closest(\'[class*="ettings"]\')||btn.parentElement;var d=document.createElement(\'div\');d.id=\'dsh-user-info\';d.style.cssText=\'display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:13px;color:var(--dsw-alias-fg-primary,#e8eaed)\';var img=document.createElement(\'img\');img.src=u.avatarUrl||\'\';img.style.cssText=\'width:28px;height:28px;border-radius:50%;corner-shape:round;object-fit:cover;flex-shrink:0\';img.onerror=function(){this.style.display="none"};var n=document.createElement(\'span\');n.textContent=u.displayName;n.style.cssText=\'overflow:hidden;text-overflow:ellipsis;white-space:nowrap\';d.appendChild(img);d.appendChild(n);sa.parentElement?sa.parentElement.insertBefore(d,sa):sa.appendChild(d);var root=d.closest(\'[class*="_root"]\');if(root){var sync=function(){n.style.display=root.classList.contains(\'ObTanq_collapsed\')?\'none\':\'\'};sync();new MutationObserver(sync).observe(root,{attributes:true,attributeFilter:[\'class\']})}return false}if(!tryMount()){return}var o=new MutationObserver(function(_,obs){if(tryMount())return;obs.disconnect()});o.observe(document.body,{childList:true,subtree:true});setTimeout(function(){o.disconnect()},15000)}).catch(()=>{})</script>'
      return html.replace('</body>', script + '</body>')
    })

    // OAuth routes
    sctx.webServer.register({ kind: 'exact', path: '/auth', handler: (req, res) => landingHandler(channels, req, res) })
    sctx.webServer.register({ kind: 'prefix', path: '/auth/login', handler: (req, res) => loginHandler(channels, req, res) })
    sctx.webServer.register({ kind: 'prefix', path: '/auth/callback', handler: (req, res) => { void callbackHandler(sctx, channels, req, res, getAuthenticatedUrl) } })
    sctx.webServer.register({ kind: 'exact', path: '/auth/complete', handler: (req, res) => completeHandler(getAuthenticatedUrl, req, res) })
  })
}
