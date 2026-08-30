/**
 * auth-gate host: OAuth routes, cookie sessions, login gate, auth-channels settings.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { isLoopbackHostname } from '@deepseek-ai/dsh-client-connection/src/loopback-hostname.ts'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/* Session service */

/** Authenticated browser user established by OAuth login. */
export interface AuthUser {
  provider: string
  userId: string
  displayName?: string
  englishName?: string
  avatarUrl?: string
  tenantId?: string
}

export const SESSION_COOKIE = 'auth-sid'

/** Browser principal derived from an auth cookie session. */
export interface AuthPrincipal {
  authSid: string
  user: AuthUser
}

/** Cookie-backed login session registry. */
export class AuthGate extends Service {
  private readonly sessions = new Map<string, AuthUser>()

  constructor(ctx: Context) {
    super(ctx, 'authGate')
  }

  createSession(user: AuthUser): string {
    const authSid = randomBytes(32).toString('hex')
    this.sessions.set(authSid, user)
    return authSid
  }

  deleteSession(authSid: string): void {
    this.sessions.delete(authSid)
  }

  userFromRequest(req: IncomingMessage): AuthUser | undefined {
    return this.sessionFromRequest(req)?.user
  }

  principalFromRequest(req: IncomingMessage): AuthPrincipal | undefined {
    return this.sessionFromRequest(req)
  }

  private sessionFromRequest(req: IncomingMessage): AuthPrincipal | undefined {
    const authSid = parseCookies(req)[SESSION_COOKIE]
    if (authSid === undefined) return undefined
    const user = this.sessions.get(authSid)
    return user === undefined ? undefined : { authSid, user }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    authGate: AuthGate
  }
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookie = req.headers.cookie
  if (!cookie) return {}
  return Object.fromEntries(
    cookie.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=')
      return [k, v.join('=')]
    }),
  )
}

/* OAuth presets */

interface OAuth2Preset {
  authorizeUrl: string
  tokenUrl: string
  userinfoUrl: string
  scope: string
  claims: {
    userId: string
    displayName?: string
    englishName?: string
    avatar?: string
  }
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

type HostLocaleId = 'zh' | 'en'

const PROVIDER_ZH = { feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信', 'wechat-scan': '微信扫码' } as const
const PROVIDER_EN: Record<keyof typeof PROVIDER_ZH, string> = {
  feishu: 'Feishu', dingtalk: 'DingTalk', wecom: 'WeCom', 'wechat-scan': 'WeChat scan',
}
const LOGIN_ZH = {
  htmlLang: 'zh-CN', documentTitle: '登录 — DeepSeek Harness', heading: '欢迎使用 DeepSeek',
  subtitle: '使用以下方式登录', loginWith: '使用{provider}登录',
  empty: '暂无可用登录渠道。请管理员在设置 → 登录渠道中配置。',
} as const
const LOGIN_EN: Record<keyof typeof LOGIN_ZH, string> = {
  htmlLang: 'en', documentTitle: 'Sign in — DeepSeek Harness', heading: 'Welcome to DeepSeek',
  subtitle: 'Sign in with', loginWith: 'Sign in with {provider}',
  empty: 'No login channels are available. Ask an administrator to configure Settings → Login channels.',
}

function resolveHostLocale(req: IncomingMessage): HostLocaleId {
  for (const part of (req.headers['accept-language'] ?? '').split(',')) {
    const tag = part.trim().split(';')[0]?.toLowerCase() ?? ''
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
  }
  return 'en'
}

function renderLoginPage(channels: readonly { id: string }[], locale: HostLocaleId): string {
  const copy = locale === 'zh' ? LOGIN_ZH : LOGIN_EN
  const labels = locale === 'zh' ? PROVIDER_ZH : PROVIDER_EN
  const esc = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const buttons = channels.length === 0
    ? `<p class="empty">${esc(copy.empty)}</p>`
    : channels.map((c) => {
      const label = esc(c.id in labels ? labels[c.id as keyof typeof PROVIDER_ZH] : c.id)
      return `<a class="btn" href="/auth/login/${encodeURIComponent(c.id)}">${copy.loginWith.replace('{provider}', label)}</a>`
    }).join('\n')
  return `<!DOCTYPE html>
<html lang="${copy.htmlLang}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(copy.documentTitle)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;background:#0b0d10;color:#e8eaed}
.card{width:min(360px,calc(100vw - 32px));padding:28px 24px;border:1px solid #2a2f36;border-radius:12px;background:#14181d}
h1{margin:0 0 8px;font-size:20px;font-weight:600}p{margin:0 0 20px;color:#9aa0a6}
.btn{display:block;text-align:center;text-decoration:none;color:#0b0d10;background:#e8eaed;border-radius:8px;padding:10px 12px;margin:0 0 10px;font-weight:500}
.empty{margin:0;color:#9aa0a6}</style></head><body><main class="card"><h1>${esc(copy.heading)}</h1><p>${esc(copy.subtitle)}</p>${buttons}</main></body></html>`
}

export const AUTH_CHANNELS_NS = settingsNamespace('auth-channels')

export const AUTH_CHANNELS_SCHEMA: z<Record<string, ChannelConfig>> = z.dict(
  z.object({
    preset: z.union(['feishu', 'dingtalk', 'wecom', 'wechat-scan'] as const),
    enabled: z.boolean().default(true),
    appId: z.string().required(),
    appSecretRef: z.string().role('credential-ref').required(),
    redirectUri: z.string().required(),
  }),
)

const STATE_TTL_MS = 10 * 60 * 1000
const pendingStates = new Map<string, { channelId: string; expiresAt: number; redirectUri: string }>()

function setSessionCookie(res: ServerResponse, sessionId: string): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`)
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function gateAllows(ctx: Context, req: IncomingMessage, channels: Record<string, ChannelConfig>): boolean {
  if (!gateActive(channels)) return true
  const pathname = pathnameOf(req)
  if (pathname === '/auth' || pathname.startsWith('/auth/')) return true
  return ctx.authGate.userFromRequest(req) !== undefined
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://x').pathname
}

function channelIdFromPath(pathname: string, prefix: string): string {
  if (!pathname.startsWith(prefix)) return ''
  const rest = pathname.slice(prefix.length)
  return rest.split('/').filter(Boolean)[0] ?? ''
}

/** Credentials service face used only for secret resolution. */
interface CredentialsResolve {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
}

async function resolveAppSecret(ctx: Context, refName: string): Promise<string> {
  const credentials = ctx.get('credentials') as CredentialsResolve | undefined
  if (credentials === undefined) {
    throw new Error('auth-gate: ctx.credentials is required to resolve appSecretRef')
  }
  const ref = credentialRef(refName)
  const resolved = await credentials.resolve(ref)
  if (resolved === undefined) {
    throw new Error(`auth-gate: credential "${refName}" is not configured`)
  }
  return resolved.value
}

export function effectiveRedirectUri(
  configured: string,
  req: { headers: { host?: string | string[] | undefined } },
): string {
  const hostHeader = req.headers.host
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  if (host === undefined || host === '') return configured
  try {
    const redirect = new URL(configured)
    const request = new URL(`http://${host}`)
    if (!isLoopbackHostname(redirect.hostname) || !isLoopbackHostname(request.hostname)) {
      return configured
    }
    redirect.hostname = request.hostname
    redirect.port = request.port
    return redirect.toString()
  } catch {
    return configured
  }
}

function authorizeUrl(
  channel: ChannelConfig,
  preset: ReturnType<typeof effectivePreset>,
  state: string,
  redirectUri: string,
): string {
  const url = new URL(preset.authorizeUrl)
  url.searchParams.set('client_id', channel.appId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', preset.scope)
  url.searchParams.set('state', state)
  if (channel.preset === 'wechat-scan') {
    url.searchParams.set('appid', channel.appId)
  }
  return url.toString()
}

/**
 * Exchange an authorization code for a user access token.
 * Feishu's open-apis token endpoint requires a JSON body; other presets use
 * form-urlencoded unless noted (WeCom uses query params).
 * @returns the access token string.
 * @throws when the provider returns a non-success payload.
 */
async function exchangeCode(
  channel: ChannelConfig,
  preset: ReturnType<typeof effectivePreset>,
  code: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string> {
  if (channel.preset === 'wecom') {
    const url = new URL(preset.tokenUrl)
    url.searchParams.set('corpid', channel.appId)
    url.searchParams.set('corpsecret', clientSecret)
    const res = await fetch(url.toString())
    const data = await res.json() as Record<string, string>
    return data.access_token ?? ''
  }

  const payload = {
    grant_type: 'authorization_code',
    client_id: channel.appId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  }

  // Feishu open-apis authen/v2 requires JSON; classic OAuth providers use form.
  const useJson = channel.preset === 'feishu' || channel.preset === 'dingtalk'
  const res = await fetch(preset.tokenUrl, {
    method: 'POST',
    body: useJson ? JSON.stringify(payload) : new URLSearchParams(payload),
    headers: {
      'content-type': useJson
        ? 'application/json; charset=utf-8'
        : 'application/x-www-form-urlencoded',
    },
  })
  const data = await res.json() as Record<string, unknown>
  const errCode = data.code
  if (typeof errCode === 'number' && errCode !== 0) {
    throw new Error(
      `token exchange failed: code=${String(errCode)} msg=${String(data.error_description ?? data.error ?? data.msg ?? '')}`,
    )
  }
  const token = data.access_token ?? data.user_access_token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('token exchange returned no access_token')
  }
  return token
}

async function fetchUserInfo(
  preset: ReturnType<typeof effectivePreset>,
  token: string,
): Promise<Record<string, string>> {
  const res = await fetch(preset.userinfoUrl, { headers: { authorization: `Bearer ${token}` } })
  const data = await res.json() as Record<string, unknown>
  const errCode = data.code
  if (typeof errCode === 'number' && errCode !== 0) {
    throw new Error(
      `userinfo failed: code=${String(errCode)} msg=${String(data.msg ?? data.error ?? '')}`,
    )
  }
  // Feishu (and some peers) nest claims under `data`.
  const nested = data.data
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, string>
  }
  return data as Record<string, string>
}

function mapClaims(preset: ReturnType<typeof effectivePreset>, raw: Record<string, string>): AuthUser {
  const user: AuthUser = {
    provider: 'oauth2',
    userId: raw[preset.claims.userId] ?? '',
  }
  if (preset.claims.displayName) {
    const v = raw[preset.claims.displayName]
    if (v !== undefined) user.displayName = v
  }
  if (preset.claims.englishName) {
    const v = raw[preset.claims.englishName]
    if (v !== undefined) user.englishName = v
  }
  if (preset.claims.avatar) {
    const v = raw[preset.claims.avatar]
    if (v !== undefined) user.avatarUrl = v
  }
  return user
}

function pruneExpiredStates(now = Date.now()): void {
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt <= now) pendingStates.delete(state)
  }
}

/* ───────────────────────────────────────────────
 * Route handlers
 * ─────────────────────────────────────────────── */

function enabledChannelLinks(
  channels: Record<string, ChannelConfig>,
): { id: string }[] {
  return Object.entries(channels)
    .filter(([, channel]) => channel.enabled !== false
      && Boolean(channel.appId && channel.appSecretRef && channel.redirectUri))
    .map(([id]) => ({ id }))
}

function beginChannelLogin(
  channels: Record<string, ChannelConfig>,
  channelId: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const channel = channels[channelId]
  if (channel === undefined || channel.enabled === false) {
    res.writeHead(404)
    res.end('channel not found or disabled')
    return
  }
  pruneExpiredStates()
  const state = randomUUID()
  const redirectUri = effectiveRedirectUri(channel.redirectUri, req)
  pendingStates.set(state, { channelId, expiresAt: Date.now() + STATE_TTL_MS, redirectUri })
  const preset = effectivePreset(channel)
  res.writeHead(302, { location: authorizeUrl(channel, preset, state, redirectUri) })
  res.end()
}

function landingHandler(
  channels: Record<string, ChannelConfig>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const links = enabledChannelLinks(channels)
  // One usable channel: skip the chooser and start OAuth immediately.
  const sole = links.length === 1 ? links[0] : undefined
  if (sole !== undefined) {
    beginChannelLogin(channels, sole.id, req, res)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(renderLoginPage(links, resolveHostLocale(req)))
}

function loginHandler(
  channels: Record<string, ChannelConfig>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const channelId = channelIdFromPath(pathnameOf(req), '/auth/login/')
  beginChannelLogin(channels, channelId, req, res)
}

async function callbackHandler(
  sctx: Context,
  channels: Record<string, ChannelConfig>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const channelId = channelIdFromPath(pathnameOf(req), '/auth/callback/')
  const channel = channels[channelId]
  if (channel === undefined || channel.enabled === false) {
    res.writeHead(404)
    res.end('channel not found or disabled')
    return
  }
  const url = new URL(req.url ?? '', 'http://x')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code) {
    res.writeHead(400)
    res.end('missing authorization code')
    return
  }
  pruneExpiredStates()
  if (state === null) {
    res.writeHead(400)
    res.end('invalid or expired OAuth state')
    return
  }
  const pending = pendingStates.get(state)
  if (pending === undefined || pending.channelId !== channelId) {
    res.writeHead(400)
    res.end('invalid or expired OAuth state')
    return
  }
  pendingStates.delete(state)
  try {
    const preset = effectivePreset(channel)
    const clientSecret = await resolveAppSecret(sctx, channel.appSecretRef)
    const token = await exchangeCode(channel, preset, code, clientSecret, pending.redirectUri)
    const rawUser = await fetchUserInfo(preset, token)
    const user = mapClaims(preset, rawUser)
    if (!user.userId) {
      res.writeHead(502)
      res.end('userinfo response missing user id claim')
      return
    }
    user.provider = channelId
    const authSid = sctx.authGate.createSession(user)
    const principal = { authSid, user }
    const authTenant = sctx.get('authTenant') as { bindAuthPrincipal(p: AuthPrincipal): string | undefined } | undefined
    authTenant?.bindAuthPrincipal(principal)
    setSessionCookie(res, authSid)
    res.writeHead(302, { location: '/' })
    res.end()
  } catch (err) {
    res.writeHead(500)
    res.end(`OAuth callback failed: ${String(err)}`)
  }
}

function meHandler(ctx: Context, req: IncomingMessage, res: ServerResponse): void {
  const user = ctx.authGate.userFromRequest(req)
  if (user === undefined) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not authenticated' }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(user))
}

function logoutHandler(ctx: Context, req: IncomingMessage, res: ServerResponse): void {
  const authSid = ctx.authGate.principalFromRequest(req)?.authSid
  if (authSid !== undefined) ctx.authGate.deleteSession(authSid)
  clearSessionCookie(res)
  res.writeHead(302, { location: '/auth' })
  res.end()
}

/** True when at least one channel is enabled and fully configured for login. */
function gateActive(channels: Record<string, ChannelConfig>): boolean {
  for (const channel of Object.values(channels)) {
    if (channel.enabled === false) continue
    if (channel.appId && channel.appSecretRef && channel.redirectUri) return true
  }
  return false
}

function refuseUnauthenticated(req: IncomingMessage, res: ServerResponse): void {
  const pathname = pathnameOf(req)
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'authentication required' }))
    return
  }
  res.writeHead(302, { location: '/auth' })
  res.end()
}

/* ───────────────────────────────────────────────
 * Plugin entry
 * ─────────────────────────────────────────────── */

/** Stable Cordis plugin name. */
export const name = 'auth-gate'

/**
 * Register auth routes, the login gate, and the `auth-channels` settings section.
 * Channels are configured only through Settings UI (`auth-channels` namespace).
 * @param ctx - host context; waits for `webServer` before mounting routes.
 */
export function apply(ctx: Context): void {
  const entry: Record<string, ChannelConfig> = {}
  let source: () => Record<string, ChannelConfig> = () => entry

  ctx.plugin(AuthGate)

  installSettingsSection(ctx, AUTH_CHANNELS_NS, AUTH_CHANNELS_SCHEMA, entry, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })

  ctx.inject(['webServer', 'authGate'], (sctx) => {
    sctx.effect(() => sctx.webServer.registerHttpGate((req, res) => {
      if (gateAllows(sctx, req, source())) return true
      refuseUnauthenticated(req, res)
      return false
    }), 'auth-gate: http gate')

    sctx.effect(() => sctx.webServer.registerUpgradeGate((req, socket) => {
      if (gateAllows(sctx, req, source())) return true
      socket.destroy()
      return false
    }), 'auth-gate: upgrade gate')

    sctx.webServer.register({
      kind: 'exact',
      path: '/auth',
      handler: (req, res) => landingHandler(source(), req, res),
    })
    sctx.webServer.register({
      kind: 'prefix',
      path: '/auth/login',
      handler: (req, res) => loginHandler(source(), req, res),
    })
    sctx.webServer.register({
      kind: 'prefix',
      path: '/auth/callback',
      handler: (req, res) => { void callbackHandler(sctx, source(), req, res) },
    })
    sctx.webServer.register({
      kind: 'exact',
      path: '/auth/me',
      handler: (req, res) => meHandler(sctx, req, res),
    })
    sctx.webServer.register({
      kind: 'exact',
      path: '/auth/logout',
      handler: (req, res) => logoutHandler(sctx, req, res),
    })
  })
}
