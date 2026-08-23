/**
 * Lark login gateway: OAuth, cookie session, per-user worker, reverse-proxy.
 * @module @deepseek-ai/dsh-host-auth-lark
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * Auth subject: Feishu `en_name` (company AD account).
 * Used as cookie identity, worker key, and `homeRoot/lark/<subject>/`.
 */
export type Subject = Branded<'AuthSubject'>

/** Lark fields from `user_info`, persisted per user and returned by `/auth/me`. */
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

const PROFILE_FILE = 'profile.json'

/** Plugin config. */
export interface Config {
  appId: string
  appSecretEnv: string
  cookieSecretEnv: string
  redirectUri: string
  homeRoot: string
  /** Test hook only. */
  workerCommand?: string[]
  workerReadyTimeoutMs: number
}

const LARK_AUTHORIZE = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
const LARK_TOKEN = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const LARK_USER_INFO = 'https://open.feishu.cn/open-apis/authen/v1/user_info'
const AUTH_COOKIE = 'dsh_auth'
const STATE_COOKIE = 'dsh_auth_state'
const ISSUER = 'lark'
/** AD / Feishu `en_name`: filesystem-safe, unique within the tenant. */
const AD_ACCOUNT = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const HOME_MODE = 0o700
const SESSION_TTL_SEC = 86_400
const WORKER_PORT_BASE = 40_000
const WORKER_PORT_SPAN = 20_000
const OAUTH_FETCH_TIMEOUT_MS = 30_000
const FS_TIMEOUT_MS = 5_000

interface WorkerHandle {
  port: number
  child: ChildProcess
}

/** Cordis function plugin: Lark OAuth gateway. */
export const name = 'auth-lark'
export const inject = ['webServer', 'credentials'] as const
export const Config: z<Config> = z.object({
  appId: z.string().min(1).required(),
  appSecretEnv: z.string().role('credential-ref').required(),
  cookieSecretEnv: z.string().role('credential-ref').required(),
  redirectUri: z.string().min(1).required(),
  homeRoot: z.string().min(1).required(),
  workerCommand: z.array(z.string().min(1)).required(false),
  workerReadyTimeoutMs: z.natural().min(1).max(120_000).default(120_000),
})

/**
 * Mount OAuth routes, per-user workers, and the reverse-proxy.
 * @param ctx - Cordis context with `webServer` and `credentials`.
 * @param config - validated plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if ('agents' in ctx && (ctx as { agents?: unknown }).agents !== undefined) {
    throw new Error('auth-lark: mount on `dsh --profile lark-gateway`, not `dsh web`')
  }
  if (!isAbsolute(config.homeRoot)) {
    throw new Error(`auth-lark: homeRoot must be absolute: ${config.homeRoot}`)
  }
  try {
    new URL(config.redirectUri)
  } catch {
    throw new Error(`auth-lark: redirectUri must be absolute: ${config.redirectUri}`)
  }

  const homeRoot = resolve(config.homeRoot)
  const appSecretRef = credentialRef(config.appSecretEnv)
  const cookieSecretRef = credentialRef(config.cookieSecretEnv)
  const [appSecret, cookieSecret] = await Promise.all([
    ctx.credentials.describe(appSecretRef),
    ctx.credentials.describe(cookieSecretRef),
  ])
  if (!appSecret.configured) {
    throw new Error(`auth-lark: credential ${config.appSecretEnv} is not configured`)
  }
  if (!cookieSecret.configured) {
    throw new Error(`auth-lark: credential ${config.cookieSecretEnv} is not configured`)
  }

  const workers = new Map<string, WorkerHandle>()
  /** Profiles from the latest successful login; survives until process exit. */
  const profiles = new Map<string, UserProfile>()
  const resolveSecret = async (ref: typeof appSecretRef) =>
    (await ctx.credentials.resolve(ref))?.value

  ctx.effect(() => {
    const exact = (
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
    ) => ctx.webServer.register({ kind: 'exact', path, handler })

    const dispose = [
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
          const appSecretValue = await resolveSecret(appSecretRef)
          if (appSecretValue === undefined) {
            empty(res, 500)
            return
          }
          let subject: Subject
          let profile: UserProfile
          try {
            ;({ subject, profile } = await redeemProfile(config.appId, appSecretValue, code, config.redirectUri))
          } catch (oauthError) {
            console.error('auth-lark: OAuth failed', oauthError)
            empty(res, 502)
            return
          }
          profiles.set(subject, profile)
          console.error(`auth-lark: login ${subject}${profile.name === undefined ? '' : ` (${profile.name})`}`)
          const cookieSecretValue = await resolveSecret(cookieSecretRef)
          if (cookieSecretValue === undefined) {
            empty(res, 500)
            return
          }
          const now = Math.floor(Date.now() / 1000)
          setCookie(res, AUTH_COOKIE, signTicket(cookieSecretValue, subject, now + SESSION_TTL_SEC), SESSION_TTL_SEC)
          res.writeHead(302, { location: '/' })
          res.end()
          void saveProfile(homeRoot, subject, profile).catch((error: unknown) => {
            console.error('auth-lark: profile persist failed', error)
          })
        } catch (error) {
          console.error('auth-lark: callback failed', error)
          if (!res.headersSent) empty(res, 500)
        }
      }),
      exact('/auth/logout', (_req, res) => {
        setCookie(res, AUTH_COOKIE, '', 0)
        empty(res, 204)
      }),
      exact('/auth/me', async (req, res) => {
        const subject = await actor(req, cookieSecretRef, resolveSecret)
        if (subject === undefined) {
          empty(res, 401)
          return
        }
        const profile = profiles.get(subject) ?? await loadProfile(homeRoot, subject)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ issuer: ISSUER, subject, ...profile }))
      }),
      ctx.webServer.registerFallback(async (req, res) => {
        const subject = await actor(req, cookieSecretRef, resolveSecret)
        if (subject === undefined) {
          res.writeHead(302, { location: '/auth/lark/login' })
          res.end()
          return
        }
        let worker: WorkerHandle | undefined
        try {
          worker = await workerFor(subject, homeRoot, config, workers)
        } catch (error) {
          console.error('auth-lark: worker start failed', error)
          empty(res, 503)
          return
        }
        proxyHttp(req, res, worker.port)
      }),
      ctx.webServer.registerUpgrade({
        path: '/api/events.mux',
        handler: (req, socket, head) =>
          proxyUpgrade(req, socket, head, homeRoot, config, workers, cookieSecretRef, resolveSecret),
      }),
      ctx.webServer.registerUpgrade({
        path: '/api/events.host',
        handler: (req, socket, head) =>
          proxyUpgrade(req, socket, head, homeRoot, config, workers, cookieSecretRef, resolveSecret),
      }),
    ]
    return () => {
      for (const drop of dispose) drop()
      for (const worker of workers.values()) stopWorker(worker.child)
      workers.clear()
    }
  }, 'auth-lark routes')

  process.stderr.write(`dsh lark-gateway: http://127.0.0.1:${String(ctx.webServer.port)} (Feishu login)\n`)
}

function subjectOf(adAccount: string): Subject {
  if (!AD_ACCOUNT.test(adAccount)) {
    throw new TypeError(`Lark en_name (AD account) ${JSON.stringify(adAccount)} must match ${String(AD_ACCOUNT)}`)
  }
  return adAccount as Subject
}

function signTicket(secret: string, subject: Subject, expUnix: number): string {
  const payload = `v1|${ISSUER}|${subject}|${String(expUnix)}`
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}

function verifyTicket(secret: string, token: string, nowUnix: number): Subject | undefined {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return undefined
  const payload = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1), 'hex')
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'), 'hex')
  if (sig.length === 0 || sig.length !== expected.length || !timingSafeEqual(sig, expected)) return undefined
  const parts = payload.split('|')
  if (parts.length !== 4 || parts[0] !== 'v1' || parts[1] !== ISSUER) return undefined
  const expUnix = Number(parts[3])
  if (!Number.isInteger(expUnix) || expUnix <= nowUnix) return undefined
  try {
    return subjectOf(parts[2] ?? '')
  } catch {
    return undefined
  }
}

async function actor(
  req: IncomingMessage,
  cookieSecretRef: ReturnType<typeof credentialRef>,
  resolveSecret: (ref: ReturnType<typeof credentialRef>) => Promise<string | undefined>,
): Promise<Subject | undefined> {
  const token = cookie(req, AUTH_COOKIE)
  if (token === undefined) return undefined
  const secret = await resolveSecret(cookieSecretRef)
  if (secret === undefined) return undefined
  return verifyTicket(secret, token, Math.floor(Date.now() / 1000))
}

async function redeemProfile(
  appId: string,
  appSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ subject: Subject; profile: UserProfile }> {
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

function normalizeProfile(parsed: unknown): UserProfile {
  if (typeof parsed !== 'object' || parsed === null) return {}
  const record = parsed as Record<string, unknown>
  const profile: UserProfile = {}
  for (const [, profileKey] of PROFILE_FIELDS) {
    const value = record[profileKey]
    if (typeof value === 'string' && value.length > 0) profile[profileKey] = value
  }
  return profile
}

async function saveProfile(homeRoot: string, subject: Subject, profile: UserProfile): Promise<void> {
  const home = join(homeRoot, ISSUER, subject)
  await fsWithTimeout('saveProfile', async () => {
    await mkdir(home, { recursive: true, mode: HOME_MODE })
    await writeFile(join(home, PROFILE_FILE), `${JSON.stringify(profile)}\n`, { mode: HOME_MODE })
  })
}

async function loadProfile(homeRoot: string, subject: Subject): Promise<UserProfile> {
  try {
    const raw = await fsWithTimeout('loadProfile', () =>
      readFile(join(homeRoot, ISSUER, subject, PROFILE_FILE), 'utf8'))
    return normalizeProfile(JSON.parse(raw) as unknown)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {}
    if (error instanceof Error && error.message.includes('timed out')) return {}
    throw error
  }
}

async function fsWithTimeout(label: string, work: () => Promise<void>): Promise<void>
async function fsWithTimeout(label: string, work: () => Promise<string>): Promise<string>
async function fsWithTimeout(label: string, work: () => Promise<void | string>): Promise<void | string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(`auth-lark: ${label} timed out after ${String(FS_TIMEOUT_MS)}ms`)) }, FS_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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

async function ensureHome(homeRoot: string, subject: Subject): Promise<string> {
  const home = join(homeRoot, ISSUER, subject)
  const dsh = join(home, '.dsh')
  await fsWithTimeout('ensureHome', async () => {
    await mkdir(join(home, 'projects'), { recursive: true, mode: HOME_MODE })
    await mkdir(dsh, { recursive: true, mode: HOME_MODE })
    await chmod(home, HOME_MODE)
    await chmod(dsh, HOME_MODE)
    const patch = join(dsh, 'cordis.patch.yml')
    try {
      await writeFile(patch, [
        '# @deepseek-ai/dsh-host-auth-lark',
        '- id: sandbox-policy',
        '  config:',
        '    mode: workspace-write',
        `    workspaceRoot: ${JSON.stringify(home)}`,
        '',
      ].join('\n'), { flag: 'wx', mode: HOME_MODE })
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
    }
  })
  return dsh
}

async function workerFor(
  subject: Subject,
  homeRoot: string,
  config: Config,
  workers: Map<string, WorkerHandle>,
): Promise<WorkerHandle> {
  const existing = workers.get(subject)
  if (existing !== undefined && existing.child.exitCode === null && existing.child.signalCode === null) {
    return existing
  }
  const taken = new Set([...workers.values()].map(worker => worker.port))
  let port = WORKER_PORT_BASE + (Math.abs(hash(subject)) % WORKER_PORT_SPAN)
  while (taken.has(port)) port++
  if (port > 65_535) throw new Error('auth-lark: worker port exhausted')
  const dshHome = await ensureHome(homeRoot, subject)
  const command = config.workerCommand !== undefined && config.workerCommand.length > 0
    ? config.workerCommand
    : workerArgv(port)
  const handle = await startWorker(command, dshHome, subject, port, config.workerReadyTimeoutMs)
  workers.set(subject, handle)
  return handle
}

function hash(value: string): number {
  let out = 0
  for (let i = 0; i < value.length; i++) out = Math.imul(31, out) + value.charCodeAt(i) | 0
  return out
}

function dshBinArgv(): string[] {
  const fromCliDir = resolveCliDir()
  if (fromCliDir !== undefined) return dshBinFromCliDir(fromCliDir)
  const fromProcess = launcherArgvFromProcess()
  if (fromProcess !== undefined) return fromProcess
  throw new Error('auth-lark: run pnpm run build first')
}

function resolveCliDir(): string | undefined {
  for (const candidate of [
    join(process.cwd(), 'apps/cli'),
    (() => {
      try {
        return dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
      } catch {
        return undefined
      }
    })(),
  ]) {
    if (candidate !== undefined && existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function launcherArgvFromProcess(): string[] | undefined {
  const binAt = process.argv.findIndex(arg => /(?:^|\/)bin\.(?:js|ts)$/.test(arg))
  if (binAt <= 0) return undefined
  const prefix = process.argv.slice(0, binAt + 1).map(arg => {
    if (!/(?:^|\/)bin\.(?:js|ts)$/.test(arg)) return arg
    return isAbsolute(arg) ? arg : resolve(process.cwd(), arg)
  })
  return prefix[0] === undefined ? undefined : prefix
}

function dshBinFromCliDir(cliDir: string): string[] {
  const builtBin = join(cliDir, 'lib/bin.js')
  if (existsSync(builtBin)) return [process.execPath, builtBin]
  const srcBin = join(cliDir, 'src/bin.ts')
  if (existsSync(srcBin)) return [process.execPath, '--import', 'tsx/esm', srcBin]
  throw new Error(`auth-lark: dsh CLI missing under ${cliDir}`)
}

function workerArgv(port: number): string[] {
  return [...dshBinArgv(), '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
}

async function startWorker(
  command: readonly string[],
  dshHome: string,
  subject: Subject,
  port: number,
  timeoutMs: number,
): Promise<WorkerHandle> {
  const [executable, ...args] = command
  if (executable === undefined) throw new Error('auth-lark: worker command missing executable')
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: { ...process.env, DSH_HOME: dshHome, DSH_AUTH_SUBJECT: subject, DSH_WORKER_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })
  try {
    await waitForTcp(port, child, timeoutMs)
    if (child.exitCode !== null) {
      throw new Error(`worker exited with ${String(child.exitCode)}${stderrSuffix(stderrChunks)}`)
    }
    return { port, child }
  } catch (error) {
    stopWorker(child)
    if (error instanceof Error && !error.message.includes('stderr:')) {
      error.message += stderrSuffix(stderrChunks)
    }
    throw error
  }
}

async function waitForTcp(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`worker exited with ${String(child.exitCode)}`)
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = connect({ port, host: '127.0.0.1' }, () => {
          probe.end()
          resolve()
        })
        probe.on('error', reject)
      })
      return
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
  }
  throw new Error(`worker did not listen on 127.0.0.1:${String(port)} within ${String(timeoutMs)}ms`)
}

function stderrSuffix(chunks: readonly Buffer[]): string {
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text.length === 0 ? '' : `; stderr: ${text.slice(0, 2000)}`
}

function stopWorker(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number): void {
  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${String(port)}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', () => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502)
    res.end()
  })
  req.pipe(proxyReq)
}

async function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  homeRoot: string,
  config: Config,
  workers: Map<string, WorkerHandle>,
  cookieSecretRef: ReturnType<typeof credentialRef>,
  resolveSecret: (ref: ReturnType<typeof credentialRef>) => Promise<string | undefined>,
): Promise<void> {
  const subject = await actor(req, cookieSecretRef, resolveSecret)
  if (subject === undefined) {
    socket.destroy()
    return
  }
  let worker: WorkerHandle
  try {
    worker = await workerFor(subject, homeRoot, config, workers)
  } catch {
    socket.destroy()
    return
  }
  const upstream = connect(worker.port, '127.0.0.1')
  upstream.on('error', () => { socket.destroy() })
  upstream.once('connect', () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    }
    lines.push('', '')
    upstream.write(lines.join('\r\n'))
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
}
