/**
 * Feishu / Lark OAuth login provider for {@link @deepseek-ai/dsh-host-auth-gateway}.
 * Proves identity and calls `ctx.auth.establish`; does not own workers or proxy.
 * @module @deepseek-ai/dsh-host-auth-lark
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { authSubject, type AuthSubject } from '@deepseek-ai/dsh-host-auth-gateway'
import type {} from '@deepseek-ai/dsh-host-auth-gateway'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Lark fields from `user_info`, passed to the gateway as profile strings. */
export interface UserProfile {
  /** Feishu `name` (display name). */
  name?: string
  /** Feishu `en_name` (same value as `subject` when present). */
  enName?: string
  /** Feishu `open_id` (opaque; kept for support, not used as home key). */
  openId?: string
  /** Feishu `avatar_url`. */
  avatarUrl?: string
  /** Feishu `union_id`. */
  unionId?: string
  /** Feishu `email` when the app has `contact:user.email:readonly`. */
  email?: string
  /** Feishu `mobile` when the app has `contact:user.phone:readonly`. */
  mobile?: string
}

/** Plugin config. */
export interface Config {
  appId: string
  appSecretEnv: string
  redirectUri: string
}

const LARK_AUTHORIZE = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
const LARK_TOKEN = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const LARK_USER_INFO = 'https://open.feishu.cn/open-apis/authen/v1/user_info'
const STATE_COOKIE = 'dsh_auth_state'
const ISSUER = 'lark'
/** AD / Feishu `en_name`: filesystem-safe, unique within the tenant. */
const AD_ACCOUNT = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const OAUTH_FETCH_TIMEOUT_MS = 30_000

/** Cordis function plugin: Feishu OAuth login provider. */
export const name = 'auth-lark'
export const inject = ['webServer', 'credentials', 'auth'] as const
export const Config: z<Config> = z.object({
  appId: z.string().min(1).required(),
  appSecretEnv: z.string().role('credential-ref').required(),
  redirectUri: z.string().min(1).required(),
})

/**
 * Mount Feishu OAuth routes and register this issuer with the auth gateway.
 * @param ctx - Cordis context with `webServer`, `credentials`, and `auth`.
 * @param config - validated plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  try {
    new URL(config.redirectUri)
  } catch {
    throw new Error(`auth-lark: redirectUri must be absolute: ${config.redirectUri}`)
  }

  const appSecretRef = credentialRef(config.appSecretEnv)
  const appSecret = await ctx.credentials.describe(appSecretRef)
  if (!appSecret.configured) {
    throw new Error(`auth-lark: credential ${config.appSecretEnv} is not configured`)
  }

  const resolveSecret = async () => (await ctx.credentials.resolve(appSecretRef))?.value

  ctx.effect(() => {
    const dropLogin = ctx.auth.registerLogin(ISSUER, '/auth/lark/login')
    const exact = (
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
    ) => ctx.webServer.register({ kind: 'exact', path, handler })

    const dispose = [
      dropLogin,
      exact('/auth/lark/login', (_req, res) => {
        const state = randomBytes(32).toString('hex')
        setCookie(res, STATE_COOKIE, state, 600)
        const url = new URL(LARK_AUTHORIZE)
        url.searchParams.set('client_id', config.appId)
        url.searchParams.set('redirect_uri', config.redirectUri)
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('state', state)
        res.writeHead(302, { location: url.href })
        res.end()
      }),
      exact('/auth/lark/callback', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://gateway.invalid')
          const code = url.searchParams.get('code')
          const state = url.searchParams.get('state')
          if (code === null || state === null || state !== cookie(req, STATE_COOKIE)) {
            empty(res, 403)
            return
          }
          setCookie(res, STATE_COOKIE, '', 0)
          const appSecretValue = await resolveSecret()
          if (appSecretValue === undefined) {
            empty(res, 500)
            return
          }
          let subject: AuthSubject
          let profile: UserProfile
          try {
            ;({ subject, profile } = await redeemProfile(config.appId, appSecretValue, code, config.redirectUri))
          } catch (oauthError) {
            console.error('auth-lark: OAuth failed', oauthError)
            empty(res, 502)
            return
          }
          console.error(`auth-lark: login ${subject}${profile.name === undefined ? '' : ` (${profile.name})`}`)
          try {
            await ctx.auth.establish({
              issuer: ISSUER,
              subject,
              profile: profileStrings(profile),
            }, res)
          } catch (error) {
            console.error('auth-lark: establish failed', error)
            empty(res, 500)
            return
          }
          res.writeHead(302, { location: '/' })
          res.end()
        } catch (error) {
          console.error('auth-lark: callback failed', error)
          if (!res.headersSent) empty(res, 500)
        }
      }),
    ]
    return () => {
      for (const drop of dispose) drop()
    }
  }, 'auth-lark routes')
}

function subjectOf(adAccount: string): AuthSubject {
  if (!AD_ACCOUNT.test(adAccount)) {
    throw new TypeError(`Lark en_name (AD account) ${JSON.stringify(adAccount)} must match ${String(AD_ACCOUNT)}`)
  }
  return authSubject(adAccount)
}

async function redeemProfile(
  appId: string,
  appSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ subject: AuthSubject; profile: UserProfile }> {
  const tokenRes = await fetch(LARK_TOKEN, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const tokenJson: unknown = await tokenRes.json()
  const accessToken = oauthField(tokenJson, 'access_token')
  if (!tokenRes.ok || !oauthApiOk(tokenJson) || accessToken === undefined) {
    throw new Error(`Lark token exchange failed: ${oauthErrorSummary(tokenJson)}`)
  }
  const userRes = await fetch(LARK_USER_INFO, {
    redirect: 'error',
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const userJson: unknown = await userRes.json()
  const enName = oauthField(userJson, 'en_name')
  if (!userRes.ok || !oauthApiOk(userJson) || enName === undefined) {
    throw new Error(`Lark user_info failed: ${oauthErrorSummary(userJson)}`)
  }
  return {
    subject: subjectOf(enName),
    profile: profileFromUserInfo(userJson),
  }
}

const PROFILE_FIELDS = [
  ['name', 'name'],
  ['en_name', 'enName'],
  ['open_id', 'openId'],
  ['avatar_url', 'avatarUrl'],
  ['union_id', 'unionId'],
  ['email', 'email'],
  ['mobile', 'mobile'],
] as const satisfies ReadonlyArray<readonly [string, keyof UserProfile]>

function profileFromUserInfo(body: unknown): UserProfile {
  const profile: UserProfile = {}
  for (const [larkKey, profileKey] of PROFILE_FIELDS) {
    const value = oauthField(body, larkKey)
    if (value !== undefined) profile[profileKey] = value
  }
  return profile
}

function profileStrings(profile: UserProfile): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(profile) as (keyof UserProfile)[]) {
    const value = profile[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

function oauthApiOk(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const code = (body as Record<string, unknown>).code
  if (code === undefined) return true
  return code === 0 || code === '0'
}

function oauthErrorSummary(body: unknown): string {
  if (typeof body !== 'object' || body === null) return 'empty response'
  const record = body as Record<string, unknown>
  const parts: string[] = []
  if (record.code !== undefined) parts.push(`code=${String(record.code)}`)
  if (typeof record.msg === 'string') parts.push(record.msg)
  if (typeof record.error === 'string') parts.push(record.error)
  if (typeof record.error_description === 'string') parts.push(record.error_description)
  return parts.length > 0 ? parts.join(' ') : JSON.stringify(body)
}

function oauthField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (typeof record[key] === 'string' && record[key].length > 0) return record[key]
  const data = record.data
  if (typeof data === 'object' && data !== null) {
    const inner = data as Record<string, unknown>
    if (typeof inner[key] === 'string' && inner[key].length > 0) return inner[key]
  }
  return undefined
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined || header.length === 0) return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1)
  }
  return undefined
}

function setCookie(res: ServerResponse, name: string, value: string, maxAgeSec: number): void {
  const line = `${name}=${value}; Path=/; SameSite=Lax; Max-Age=${String(maxAgeSec)}; HttpOnly`
  const prev = res.getHeader('Set-Cookie')
  if (prev === undefined) {
    res.setHeader('Set-Cookie', line)
    return
  }
  const list = Array.isArray(prev) ? prev.map(String) : [String(prev)]
  list.push(line)
  res.setHeader('Set-Cookie', list)
}

function empty(res: ServerResponse, status: number): void {
  res.writeHead(status)
  res.end()
}
