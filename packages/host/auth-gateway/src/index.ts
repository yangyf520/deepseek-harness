/**
 * Multi-user auth gateway: cookie session, per-user home, worker, reverse-proxy.
 * Login providers call `ctx.auth.establish` after proving identity.
 * @module @deepseek-ai/dsh-host-auth-gateway
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Multi-user auth gateway. */
    auth: Auth
  }
}

/** Filesystem-safe identity key unique within an issuer. */
export type AuthSubject = Branded<'AuthSubject'>

/** Proven identity from a login provider. */
export interface AuthPrincipal {
  /** Login issuer id (e.g. `lark`). */
  issuer: string
  /** Filesystem-safe subject unique within the issuer. */
  subject: AuthSubject
  /** Optional profile fields persisted under the user home. */
  profile?: Readonly<Record<string, string>>
}

/**
 * Gateway face for login providers: register a login path and establish a session.
 */
export interface Auth {
  /**
   * Register a browser login path for unauthenticated redirects.
   * @param issuer - issuer id.
   * @param loginPath - absolute path such as `/auth/lark/login`.
   * @returns disposer.
   */
  registerLogin(issuer: string, loginPath: string): () => void
  /**
   * Persist profile and set the auth cookie; caller owns status and redirect.
   * @param principal - issuer + subject + optional profile.
   * @param res - response that receives `Set-Cookie`.
   */
  establish(principal: AuthPrincipal, res: ServerResponse): Promise<void>
}

/** Plugin config. */
export interface Config {
  cookieSecretEnv: string
  homeRoot: string
  /** Test hook or OS confinement wrapper. */
  workerCommand?: string[]
  workerReadyTimeoutMs: number
}

const AUTH_COOKIE = 'dsh_auth'
const PROFILE_FILE = 'profile.json'
const ISSUER_RE = /^[a-z][a-z0-9-]{0,31}$/
const SUBJECT_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const HOME_MODE = 0o700
const SESSION_TTL_SEC = 86_400
const WORKER_PORT_BASE = 40_000
const WORKER_PORT_SPAN = 20_000
const FS_TIMEOUT_MS = 5_000

interface WorkerHandle {
  port: number
  child: ChildProcess
}

/** Cordis function plugin. */
export const name = 'auth-gateway'
export const inject = ['webServer', 'credentials'] as const
export const Config: z<Config> = z.object({
  cookieSecretEnv: z.string().role('credential-ref').required(),
  homeRoot: z.string().min(1).required(),
  workerCommand: z.array(z.string().min(1)).required(false),
  workerReadyTimeoutMs: z.natural().min(1).max(120_000).default(120_000),
})

/**
 * Brand a filesystem-safe subject at the login-provider edge.
 * @param value - subject string.
 * @returns branded subject.
 */
export function authSubject(value: string): AuthSubject {
  if (!SUBJECT_RE.test(value)) {
    throw new TypeError(`auth-gateway: subject ${JSON.stringify(value)} must match ${String(SUBJECT_RE)}`)
  }
  return value as AuthSubject
}

/**
 * Provide `ctx.auth`, cookie routes, per-user workers, and reverse-proxy.
 * @param ctx - Cordis context with `webServer` and `credentials`.
 * @param config - validated plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if ('agents' in ctx && (ctx as { agents?: unknown }).agents !== undefined) {
    throw new Error('auth-gateway: mount on `dsh --profile lark-gateway`, not `dsh web`')
  }
  if (!isAbsolute(config.homeRoot)) {
    throw new Error(`auth-gateway: homeRoot must be absolute: ${config.homeRoot}`)
  }

  const homeRoot = resolve(config.homeRoot)
  const cookieSecretRef = credentialRef(config.cookieSecretEnv)
  if (!(await ctx.credentials.describe(cookieSecretRef)).configured) {
    throw new Error(`auth-gateway: credential ${config.cookieSecretEnv} is not configured`)
  }
  const resolveSecret = async () => (await ctx.credentials.resolve(cookieSecretRef))?.value

  const workers = new Map<string, WorkerHandle>()
  const profiles = new Map<string, Record<string, string>>()
  const logins = new Map<string, string>()

  const keyOf = (issuer: string, subject: AuthSubject) => `${issuer}/${subject}`

  const actor = async (req: IncomingMessage): Promise<AuthPrincipal | undefined> => {
    const token = cookie(req, AUTH_COOKIE)
    if (token === undefined) return undefined
    const secret = await resolveSecret()
    if (secret === undefined) return undefined
    return verifyTicket(secret, token, Math.floor(Date.now() / 1000))
  }

  const workerFor = async (principal: AuthPrincipal): Promise<WorkerHandle> => {
    const key = keyOf(principal.issuer, principal.subject)
    const existing = workers.get(key)
    if (existing !== undefined && existing.child.exitCode === null && existing.child.signalCode === null) {
      return existing
    }
    const taken = new Set([...workers.values()].map(worker => worker.port))
    let port = WORKER_PORT_BASE + (Math.abs(hash(key)) % WORKER_PORT_SPAN)
    while (taken.has(port)) port++
    if (port > 65_535) throw new Error('auth-gateway: worker port exhausted')
    const { dshHome, workspaceDir } = await ensureHome(homeRoot, principal.issuer, principal.subject)
    const command = config.workerCommand !== undefined && config.workerCommand.length > 0
      ? config.workerCommand
      : [...dshBinArgv(), '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
    const handle = await startWorker(command, dshHome, workspaceDir, principal, port, config.workerReadyTimeoutMs)
    workers.set(key, handle)
    return handle
  }

  const proxyUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const principal = await actor(req)
    if (principal === undefined) {
      socket.destroy()
      return
    }
    let worker: WorkerHandle
    try {
      worker = await workerFor(principal)
    } catch {
      socket.destroy()
      return
    }
    const upstream = connect(worker.port, '127.0.0.1')
    upstream.on('error', () => { socket.destroy() })
    upstream.once('connect', () => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
      for (const [header, value] of Object.entries(req.headers)) {
        if (value === undefined) continue
        lines.push(`${header}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      lines.push('', '')
      upstream.write(lines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
  }

  class AuthService extends Service implements Auth {
    constructor() {
      super(ctx, 'auth')
    }

    registerLogin(issuer: string, loginPath: string): () => void {
      if (!ISSUER_RE.test(issuer)) {
        throw new TypeError(`auth-gateway: issuer ${JSON.stringify(issuer)} must match ${String(ISSUER_RE)}`)
      }
      if (!loginPath.startsWith('/') || loginPath.includes('://')) {
        throw new Error(`auth-gateway: loginPath must be an absolute path: ${loginPath}`)
      }
      if (logins.has(issuer)) {
        throw new Error(`auth-gateway: duplicate login issuer ${JSON.stringify(issuer)}`)
      }
      logins.set(issuer, loginPath)
      return () => { logins.delete(issuer) }
    }

    async establish(principal: AuthPrincipal, res: ServerResponse): Promise<void> {
      if (!ISSUER_RE.test(principal.issuer)) {
        throw new TypeError(`auth-gateway: issuer ${JSON.stringify(principal.issuer)} must match ${String(ISSUER_RE)}`)
      }
      authSubject(principal.subject)
      const key = keyOf(principal.issuer, principal.subject)
      const profile = { ...(principal.profile ?? {}) }
      profiles.set(key, profile)
      const secret = await resolveSecret()
      if (secret === undefined) throw new Error('auth-gateway: cookie secret unavailable')
      const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC
      setCookie(res, AUTH_COOKIE, signTicket(secret, principal.issuer, principal.subject, exp), SESSION_TTL_SEC)
      void saveProfile(homeRoot, principal.issuer, principal.subject, profile).catch((error: unknown) => {
        console.error('auth-gateway: profile persist failed', error)
      })
    }
  }

  new AuthService()

  ctx.effect(() => {
    const exact = (
      path: string,
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
    ) => ctx.webServer.register({ kind: 'exact', path, handler })

    const dispose = [
      exact('/auth/logout', (_req, res) => {
        setCookie(res, AUTH_COOKIE, '', 0)
        res.writeHead(204)
        res.end()
      }),
      exact('/auth/me', async (req, res) => {
        const principal = await actor(req)
        if (principal === undefined) {
          res.writeHead(401)
          res.end()
          return
        }
        const profile = profiles.get(keyOf(principal.issuer, principal.subject))
          ?? await loadProfile(homeRoot, principal.issuer, principal.subject)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ issuer: principal.issuer, subject: principal.subject, ...profile }))
      }),
      ctx.webServer.registerFallback(async (req, res) => {
        const principal = await actor(req)
        if (principal === undefined) {
          const login = logins.values().next()
          if (login.done === true) {
            res.writeHead(503)
            res.end()
            return
          }
          res.writeHead(302, { location: login.value })
          res.end()
          return
        }
        try {
          proxyHttp(req, res, (await workerFor(principal)).port)
        } catch (error) {
          console.error('auth-gateway: worker start failed', error)
          res.writeHead(503)
          res.end()
        }
      }),
      ctx.webServer.registerUpgrade({
        path: '/api/events.mux',
        handler: (req, socket, head) => proxyUpgrade(req, socket, head),
      }),
      ctx.webServer.registerUpgrade({
        path: '/api/events.host',
        handler: (req, socket, head) => proxyUpgrade(req, socket, head),
      }),
    ]
    return () => {
      for (const drop of dispose) drop()
      for (const worker of workers.values()) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM')
      }
      workers.clear()
    }
  }, 'auth-gateway routes')

  process.stderr.write(`dsh auth-gateway: http://127.0.0.1:${String(ctx.webServer.port)}\n`)
}

function signTicket(secret: string, issuer: string, subject: AuthSubject, expUnix: number): string {
  const payload = `v1|${issuer}|${subject}|${String(expUnix)}`
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}

function verifyTicket(secret: string, token: string, nowUnix: number): AuthPrincipal | undefined {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return undefined
  const payload = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1), 'hex')
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'), 'hex')
  if (sig.length === 0 || sig.length !== expected.length || !timingSafeEqual(sig, expected)) return undefined
  const parts = payload.split('|')
  if (parts.length !== 4 || parts[0] !== 'v1') return undefined
  const issuer = parts[1] ?? ''
  const subjectRaw = parts[2] ?? ''
  const expUnix = Number(parts[3])
  if (!ISSUER_RE.test(issuer) || !Number.isInteger(expUnix) || expUnix <= nowUnix) return undefined
  try {
    return { issuer, subject: authSubject(subjectRaw) }
  } catch {
    return undefined
  }
}

async function saveProfile(
  homeRoot: string,
  issuer: string,
  subject: AuthSubject,
  profile: Record<string, string>,
): Promise<void> {
  const home = join(homeRoot, issuer, subject)
  await fsWithTimeout('saveProfile', async () => {
    await mkdir(home, { recursive: true, mode: HOME_MODE })
    await writeFile(join(home, PROFILE_FILE), `${JSON.stringify(profile)}\n`, { mode: HOME_MODE })
  })
}

async function loadProfile(homeRoot: string, issuer: string, subject: AuthSubject): Promise<Record<string, string>> {
  try {
    const raw = await fsWithTimeout('loadProfile', () =>
      readFile(join(homeRoot, issuer, subject, PROFILE_FILE), 'utf8'))
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) out[key] = value
    }
    return out
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
        timer = setTimeout(() => {
          reject(new Error(`auth-gateway: ${label} timed out after ${String(FS_TIMEOUT_MS)}ms`))
        }, FS_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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

async function ensureHome(
  homeRoot: string,
  issuer: string,
  subject: AuthSubject,
): Promise<{ dshHome: string; workspaceDir: string }> {
  const home = join(homeRoot, issuer, subject)
  const workspaceDir = join(home, 'projects')
  const dshHome = join(home, '.dsh')
  await fsWithTimeout('ensureHome', async () => {
    await mkdir(workspaceDir, { recursive: true, mode: HOME_MODE })
    await mkdir(dshHome, { recursive: true, mode: HOME_MODE })
    await chmod(home, HOME_MODE)
    await chmod(dshHome, HOME_MODE)
    const patch = join(dshHome, 'cordis.patch.yml')
    try {
      await writeFile(patch, [
        '# @deepseek-ai/dsh-host-auth-gateway',
        '- id: sandbox-policy',
        '  config:',
        '    mode: workspace-write',
        `    workspaceRoot: ${JSON.stringify(workspaceDir)}`,
        '',
      ].join('\n'), { flag: 'wx', mode: HOME_MODE })
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
    }
  })
  return { dshHome, workspaceDir }
}

function hash(value: string): number {
  let out = 0
  for (let i = 0; i < value.length; i++) out = Math.imul(31, out) + value.charCodeAt(i) | 0
  return out
}

function dshBinArgv(): string[] {
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
    if (candidate === undefined || !existsSync(join(candidate, 'package.json'))) continue
    const built = join(candidate, 'lib/bin.js')
    if (existsSync(built)) return [process.execPath, built]
    const src = join(candidate, 'src/bin.ts')
    if (existsSync(src)) return [process.execPath, '--import', 'tsx/esm', src]
    throw new Error(`auth-gateway: dsh CLI missing under ${candidate}`)
  }
  const binAt = process.argv.findIndex(arg => /(?:^|\/)bin\.(?:js|ts)$/.test(arg))
  if (binAt > 0) {
    const prefix = process.argv.slice(0, binAt + 1).map((arg) => {
      if (!/(?:^|\/)bin\.(?:js|ts)$/.test(arg)) return arg
      return isAbsolute(arg) ? arg : resolve(process.cwd(), arg)
    })
    if (prefix[0] !== undefined) return prefix
  }
  throw new Error('auth-gateway: run pnpm run build first')
}

async function startWorker(
  command: readonly string[],
  dshHome: string,
  workspaceDir: string,
  principal: AuthPrincipal,
  port: number,
  timeoutMs: number,
): Promise<WorkerHandle> {
  const [executable, ...args] = command
  if (executable === undefined) throw new Error('auth-gateway: worker command missing executable')
  const child = spawn(executable, args, {
    cwd: workspaceDir,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_CWD: workspaceDir,
      DSH_AUTH_ISSUER: principal.issuer,
      DSH_AUTH_SUBJECT: principal.subject,
      DSH_WORKER_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })
  try {
    await waitForTcp(port, child, timeoutMs)
    if (child.exitCode !== null) {
      const text = Buffer.concat(stderrChunks).toString('utf8').trim()
      throw new Error(`worker exited with ${String(child.exitCode)}${text.length === 0 ? '' : `; stderr: ${text.slice(0, 2000)}`}`)
    }
    return { port, child }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (error instanceof Error && !error.message.includes('stderr:')) {
      const text = Buffer.concat(stderrChunks).toString('utf8').trim()
      if (text.length > 0) error.message += `; stderr: ${text.slice(0, 2000)}`
    }
    throw error
  }
}

async function waitForTcp(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`worker exited with ${String(child.exitCode)}`)
    try {
      await new Promise<void>((resolveConnect, reject) => {
        const probe = connect({ port, host: '127.0.0.1' }, () => {
          probe.end()
          resolveConnect()
        })
        probe.on('error', reject)
      })
      return
    } catch {
      await new Promise((resolveWait) => { setTimeout(resolveWait, 50) })
    }
  }
  throw new Error(`worker did not listen on 127.0.0.1:${String(port)} within ${String(timeoutMs)}ms`)
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number): void {
  const headers = { ...req.headers }
  // Keep the browser-facing Host (e.g. gateway :3080) so worker /api trust checks match Origin.
  if (headers.host === undefined) headers.host = `127.0.0.1:${String(port)}`
  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port,
      path: req.url,
      method: req.method,
      headers,
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
