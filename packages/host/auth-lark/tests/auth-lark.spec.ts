/**
 * Gateway isolation and OAuth failure paths (auth-gateway + auth-lark).
 */

import { connect } from 'node:net'
import { once } from 'node:events'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as AuthGateway from '@deepseek-ai/dsh-host-auth-gateway'
import * as AuthLark from '../src/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'
import { apply as applyGatewayInvariant } from '../../auth-gateway/src/invariant.ts'

const LARK_TOKEN = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const LARK_USER_INFO = 'https://open.feishu.cn/open-apis/authen/v1/user_info'
const AUTH_COOKIE = 'dsh_auth'
const STATE_COOKIE = 'dsh_auth_state'
const secrets = { LARK_APP_SECRET: 'app-secret', LARK_AUTH_COOKIE_SECRET: 'cookie-secret' }

const FAKE_WORKER = `
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
const home = process.env.DSH_HOME
const workspace = process.env.DSH_CWD ?? ''
const subject = process.env.DSH_AUTH_SUBJECT ?? ''
const port = Number(process.env.DSH_WORKER_PORT)
if (!home || !Number.isInteger(port) || port <= 0) process.exit(2)
mkdirSync(home, { recursive: true })
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('subject=' + subject + ' workspace=' + workspace + ' path=' + (req.url ?? ''))
})
server.on('upgrade', (_req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n')
  socket.write('subject=' + subject)
  socket.end()
})
server.listen(port, '127.0.0.1')
`

let root: string | undefined
let context: Context | undefined
let homeRoot: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, homeRoot]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
  root = undefined
  homeRoot = undefined
  delete process.env.LARK_APP_SECRET
  delete process.env.LARK_AUTH_COOKIE_SECRET
})

describe('gateway', () => {
  it('registers invariant companions', async () => {
    const ctx = new Context()
    const registered: string[] = []
    ctx.invariants = {
      register(name: string, install: () => void) {
        install()
        registered.push(name)
        return () => undefined
      },
    } as never
    await applyInvariant(ctx)
    await applyGatewayInvariant(ctx)
    expect(registered).toEqual([
      '@deepseek-ai/dsh-host-auth-lark',
      '@deepseek-ai/dsh-host-auth-gateway',
    ])
  })

  it('rejects Host profiles that already expose ctx.agents', async () => {
    Object.assign(process.env, secrets)
    const ctx = new Context()
    ctx.webServer = { port: 3080 } as never
    ctx.credentials = {
      describe: async () => ({ configured: true }),
      resolve: async () => ({ value: 'secret' }),
    } as never
    ctx.agents = { list: () => [] } as never
    await expect(AuthGateway.apply(ctx, {
      cookieSecretEnv: 'LARK_AUTH_COOKIE_SECRET',
      homeRoot: '/tmp/users',
      workerReadyTimeoutMs: 30_000,
    })).rejects.toThrow(/lark-gateway/)
  })

  it('isolates workers per AD en_name and proxies HTTP and WebSocket', async () => {
    Object.assign(process.env, secrets)
    const gw = await loadGateway()
    const a = await loginAs(gw.webServer.port, 'ou_aaa111', { name: 'Yang', enName: 'yangyufeng' })
    const b = await loginAs(gw.webServer.port, 'ou_bbb222', { name: 'Bob', enName: 'bob' })
    expect(a.me).toEqual({
      issuer: 'lark',
      subject: 'yangyufeng',
      name: 'Yang',
      enName: 'yangyufeng',
      openId: 'ou_aaa111',
      avatarUrl: 'https://example.test/avatar-ou_aaa111',
      unionId: 'on_aaa111',
    })
    expect(b.me).toEqual({
      issuer: 'lark',
      subject: 'bob',
      name: 'Bob',
      enName: 'bob',
      openId: 'ou_bbb222',
      avatarUrl: 'https://example.test/avatar-ou_bbb222',
      unionId: 'on_bbb222',
    })
    expect(a.body).toContain('subject=yangyufeng')
    expect(b.body).toContain('subject=bob')
    expect(a.body).toContain('/lark/yangyufeng/projects')
    expect(b.body).toContain('/lark/bob/projects')
    expect(a.body).not.toContain('/lark/bob/')
    expect(b.body).not.toContain('/lark/yangyufeng/')
    const again = await loginAs(gw.webServer.port, 'ou_bbb222', { name: 'Bob', enName: 'bob' })
    expect(again.body).toContain('subject=bob')
  })

  it('returns profile from memory when disk persist fails', async () => {
    Object.assign(process.env, secrets)
    const gwRoot = await mkdtemp(join(tmpdir(), 'dsh-auth-ro-'))
    const readOnlyHome = join(gwRoot, 'users')
    await mkdir(readOnlyHome)
    await chmod(readOnlyHome, 0o500)
    homeRoot = readOnlyHome
    const gw = await loadGateway({ homeRoot: readOnlyHome })
    stubLark('ou_mem777', { name: 'Mem User', enName: 'mem' })
    const login = await fetch(`http://127.0.0.1:${String(gw.webServer.port)}/auth/lark/login`, { redirect: 'manual' })
    const state = cookieValue(login.headers.getSetCookie(), STATE_COOKIE)
    const callbackRes = await fetch(
      `http://127.0.0.1:${String(gw.webServer.port)}/auth/lark/callback?code=ou_mem777&state=${state}`,
      { headers: { cookie: `${STATE_COOKIE}=${state}` }, redirect: 'manual' },
    )
    expect(callbackRes.status).toBe(302)
    const cookie = `${AUTH_COOKIE}=${cookieValue(callbackRes.headers.getSetCookie(), AUTH_COOKIE)}`
    const me = await (await fetch(`http://127.0.0.1:${String(gw.webServer.port)}/auth/me`, { headers: { cookie } })).json() as Record<string, string>
    expect(me).toEqual({
      issuer: 'lark',
      subject: 'mem',
      name: 'Mem User',
      enName: 'mem',
      openId: 'ou_mem777',
      avatarUrl: 'https://example.test/avatar-ou_mem777',
      unionId: 'on_mem777',
    })
    await chmod(readOnlyHome, 0o700)
    await rm(gwRoot, { recursive: true, force: true })
    homeRoot = undefined
  })

  it('fails load and worker start loudly', async () => {
    await expect(loadGateway({ envSecrets: false })).rejects.toThrow(/not configured/)
    Object.assign(process.env, secrets)
    await expect(loadGateway({ homeRoot: 'relative/path' })).rejects.toThrow(/homeRoot must be absolute/)
    await expect(loadGateway({ redirectUri: 'not-a-url' })).rejects.toThrow(/redirectUri must be absolute/)

    process.env.LARK_APP_SECRET = secrets.LARK_APP_SECRET
    delete process.env.LARK_AUTH_COOKIE_SECRET
    await expect(loadGateway({ envSecrets: false })).rejects.toThrow(/LARK_AUTH_COOKIE_SECRET/)

    Object.assign(process.env, secrets)
    const dying = await loadGateway({ workerCommand: [process.execPath, '-e', 'process.exit(1)'] })
    stubLark('ou_die444')
    const dyingCb = await callback(dying.webServer.port, 'ou_die444')
    expect(dyingCb.status).toBe(302)
    const dyingCookie = `${AUTH_COOKIE}=${cookieValue(dyingCb.headers.getSetCookie(), AUTH_COOKIE)}`
    expect((await fetch(`http://127.0.0.1:${String(dying.webServer.port)}/`, { headers: { cookie: dyingCookie } })).status)
      .toBe(503)
    await dying.fiber.dispose()
    context = undefined

    const hang = await loadGateway({
      workerCommand: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      workerReadyTimeoutMs: 200,
    })
    stubLark('ou_hang555')
    const hangCb = await callback(hang.webServer.port, 'ou_hang555')
    expect(hangCb.status).toBe(302)
    const hangCookie = `${AUTH_COOKIE}=${cookieValue(hangCb.headers.getSetCookie(), AUTH_COOKIE)}`
    expect((await fetch(`http://127.0.0.1:${String(hang.webServer.port)}/`, { headers: { cookie: hangCookie } })).status)
      .toBe(503)
    await hang.fiber.dispose()
    context = undefined

    Object.assign(process.env, secrets)
    const oauth = await loadGateway()
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = String(input instanceof Request ? input.url : input)
      if (href.startsWith(LARK_TOKEN)) {
        return new Response(JSON.stringify(null), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      if (href.startsWith('http://127.0.0.1')) return realFetch(input, init)
      throw new Error(`unexpected fetch ${href}`)
    }))
    expect((await callback(oauth.webServer.port, 'ou_oauth1')).status).toBe(502)

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = String(input instanceof Request ? input.url : input)
      if (href.startsWith(LARK_TOKEN)) {
        return new Response(JSON.stringify({ code: 0, access_token: 'tok' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.startsWith(LARK_USER_INFO)) {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.startsWith('http://127.0.0.1')) return realFetch(input, init)
      throw new Error(`unexpected fetch ${href}`)
    }))
    expect((await callback(oauth.webServer.port, 'ou_oauth2')).status).toBe(502)

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = String(input instanceof Request ? input.url : input)
      if (href.startsWith(LARK_TOKEN)) {
        return new Response(JSON.stringify({ code: 20003, error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (href.startsWith('http://127.0.0.1')) return realFetch(input, init)
      throw new Error(`unexpected fetch ${href}`)
    }))
    expect((await callback(oauth.webServer.port, 'ou_oauth3')).status).toBe(502)

    vi.unstubAllGlobals()

    expect((await fetch(`http://127.0.0.1:${String(oauth.webServer.port)}/auth/me`, {
      headers: { cookie: '=bad; other=1' },
    })).status).toBe(401)

    await oauth.fiber.dispose()
    context = undefined

    const deadPortWorker = [
      process.execPath,
      '-e',
      "import { createServer } from 'node:http'; const p = Number(process.env.DSH_WORKER_PORT); createServer((q,r)=>{r.end('ok')}).listen(p,'127.0.0.1',()=>{}); setTimeout(()=>process.exit(0),150)",
    ]
    const dead = await loadGateway({ workerCommand: deadPortWorker, workerReadyTimeoutMs: 2000 })
    const d = await loginAs(dead.webServer.port, 'ou_dead666')
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    expect((await fetch(`http://127.0.0.1:${String(dead.webServer.port)}/`, { headers: { cookie: d.cookie } })).status)
      .toBe(200)
    const up = connect(dead.webServer.port, '127.0.0.1')
    await once(up, 'connect')
    up.write(`GET /api/events.host HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${d.cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
    await Promise.race([once(up, 'close'), once(up, 'error'), new Promise((resolve) => { setTimeout(resolve, 500) })])
    up.destroy()
  }, 20_000)
})

async function loginAs(
  port: number,
  openId: string,
  user?: Partial<{ name: string; enName: string; avatarUrl: string; unionId: string; email: string; mobile: string }>,
): Promise<{ cookie: string; me: Record<string, string>; body: string }> {
  stubLark(openId, user)
  const login = await fetch(`http://127.0.0.1:${String(port)}/auth/lark/login`, { redirect: 'manual' })
  const state = cookieValue(login.headers.getSetCookie(), STATE_COOKIE)
  const callbackRes = await fetch(
    `http://127.0.0.1:${String(port)}/auth/lark/callback?code=${openId}&state=${state}`,
    { headers: { cookie: `${STATE_COOKIE}=${state}` }, redirect: 'manual' },
  )
  expect(callbackRes.status).toBe(302)
  const cookie = `${AUTH_COOKIE}=${cookieValue(callbackRes.headers.getSetCookie(), AUTH_COOKIE)}`
  const me = await (await fetch(`http://127.0.0.1:${String(port)}/auth/me`, { headers: { cookie } })).json() as Record<string, string>
  const body = await (await fetch(`http://127.0.0.1:${String(port)}/`, { headers: { cookie } })).text()
  return { cookie, me, body }
}

async function callback(port: number, openId: string): Promise<Response> {
  const login = await fetch(`http://127.0.0.1:${String(port)}/auth/lark/login`, { redirect: 'manual' })
  const state = cookieValue(login.headers.getSetCookie(), STATE_COOKIE)
  return fetch(
    `http://127.0.0.1:${String(port)}/auth/lark/callback?code=${openId}&state=${state}`,
    { headers: { cookie: `${STATE_COOKIE}=${state}` }, redirect: 'manual' },
  )
}

function stubLark(
  openId: string,
  user?: Partial<{ name: string; enName: string; avatarUrl: string; unionId: string; email: string; mobile: string }>,
): void {
  const name = user?.name ?? `user-${openId}`
  const enName = user?.enName ?? name
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input instanceof Request ? input.url : input)
    if (href.startsWith(LARK_TOKEN)) {
      return new Response(JSON.stringify({ code: 0, access_token: 'tok' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.startsWith(LARK_USER_INFO)) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          open_id: openId,
          name,
          en_name: enName,
          avatar_url: user?.avatarUrl ?? `https://example.test/avatar-${openId}`,
          union_id: user?.unionId ?? `on_${openId.slice(3)}`,
          ...(user?.email === undefined ? {} : { email: user.email }),
          ...(user?.mobile === undefined ? {} : { mobile: user.mobile }),
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.startsWith('http://127.0.0.1')) return realFetch(input, init)
    throw new Error(`unexpected fetch ${href}`)
  }))
}

function cookieValue(setCookie: string[], name: string): string {
  const line = setCookie.find(entry => entry.startsWith(`${name}=`))
  if (line === undefined) throw new Error(`missing ${name}`)
  return line.slice(name.length + 1).split(';')[0] ?? ''
}

async function loadGateway(options?: {
  envSecrets?: boolean
  homeRoot?: string
  redirectUri?: string
  workerCommand?: string[]
  workerReadyTimeoutMs?: number
}): Promise<Context> {
  if (options?.envSecrets !== false) Object.assign(process.env, secrets)
  root = await mkdtemp(join(tmpdir(), 'dsh-auth-loader-'))
  const resolvedHome = options?.homeRoot ?? await mkdtemp(join(tmpdir(), 'dsh-auth-users-'))
  if (options?.homeRoot === undefined) homeRoot = resolvedHome
  const workerPath = join(root, 'fake-worker.mjs')
  await writeFile(workerPath, FAKE_WORKER)
  const worker = options?.workerCommand ?? [process.execPath, workerPath]
  const ready = options?.workerReadyTimeoutMs ?? 30_000
  await writeFile(join(root, 'cordis.yml'), [
    '- name: \'@deepseek-ai/dsh-host-webserver\'',
    '  config:',
    '    host: \'127.0.0.1\'',
    '    port: 0',
    '- name: \'@deepseek-ai/dsh-credentials-local\'',
    '  config:',
    `    dshHome: ${JSON.stringify(join(root, 'cred-home'))}`,
    '    watch: false',
    '- name: \'@deepseek-ai/dsh-host-auth-gateway\'',
    '  config:',
    '    cookieSecretEnv: LARK_AUTH_COOKIE_SECRET',
    `    homeRoot: ${JSON.stringify(resolvedHome)}`,
    `    workerReadyTimeoutMs: ${String(ready)}`,
    '    workerCommand:',
    ...worker.map(part => `      - ${JSON.stringify(part)}`),
    '- name: \'@deepseek-ai/dsh-host-auth-lark\'',
    '  config:',
    '    appId: cli_test',
    '    appSecretEnv: LARK_APP_SECRET',
    `    redirectUri: ${JSON.stringify(options?.redirectUri ?? 'http://127.0.0.1:3080/auth/lark/callback')}`,
    '',
  ].join('\n'))
  await mkdir(join(root, 'cred-home'), { recursive: true })

  context = new Context()
  context.baseUrl = `${pathToFileURL(root).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-host-auth-gateway', AuthGateway],
    ['@deepseek-ai/dsh-host-auth-lark', AuthLark],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(root, 'cordis.yml')).href },
  })
  await context.loader.await()
  return context
}
