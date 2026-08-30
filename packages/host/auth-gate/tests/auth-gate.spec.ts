/**
 * Integration test for auth-gate: Loader composition with webserver + settings
 * file + credentials stub, covering login redirect (state), landing page,
 * callback cookie establishment, and /auth/me.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthGate from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class StubCredentials extends Service {
  constructor(ctx: Context, private readonly values: Record<string, string>) {
    super(ctx, 'credentials')
  }

  async resolve(ref: CredentialRef): Promise<{ value: string; source: 'file' } | undefined> {
    const value = this.values[ref]
    return value === undefined ? undefined : { value, source: 'file' }
  }
}

function channelYaml(extra: Record<string, Record<string, string | boolean>> = {}): string {
  const lines = [
    'auth-channels:',
    '  feishu:',
    '    preset: feishu',
    '    enabled: true',
    '    appId: cli_test',
    '    appSecretRef: TEST_SECRET',
    '    redirectUri: https://example.com/auth/callback/feishu',
  ]
  for (const [id, channel] of Object.entries(extra)) {
    lines.push(`  ${id}:`)
    for (const [key, value] of Object.entries(channel)) {
      lines.push(typeof value === 'boolean'
        ? `    ${key}: ${value ? 'true' : 'false'}`
        : `    ${key}: ${JSON.stringify(value)}`)
    }
  }
  return lines.join('\n') + '\n'
}

async function loadComposition(
  port = 0,
  extraChannels: Record<string, Record<string, string | boolean>> = {},
): Promise<{ ctx: Context; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-auth-gate-'))
  const settingsPath = join(root, 'settings.yaml')
  const configPath = join(root, 'cordis.yml')
  await writeFile(settingsPath, channelYaml(extraChannels))
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    watch: false',
    '',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(port)}`,
    '',
    "- name: '@deepseek-ai/dsh-host-auth-gate'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-auth-gate', AuthGate],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.plugin(StubCredentials, { TEST_SECRET: 'sk-test' })
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()

  const server = context.get('webServer') as { port: number }
  return { ctx: context, port: server.port }
}

describe('auth-gate', () => {
  it('redirects /auth straight to the sole enabled channel authorize URL', async () => {
    const { port } = await loadComposition()
    const res = await fetch(`http://127.0.0.1:${port}/auth`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('accounts.feishu.cn/open-apis/authen/v1/authorize')
    expect(location).toContain('client_id=cli_test')
  })

  it('serves the login chooser when multiple channels are enabled', async () => {
    const { port } = await loadComposition(0, {
      dingtalk: {
        preset: 'dingtalk',
        enabled: true,
        appId: 'ding_test',
        appSecretRef: 'TEST_SECRET',
        redirectUri: 'https://example.com/auth/callback/dingtalk',
      },
    })
    const res = await fetch(`http://127.0.0.1:${port}/auth`, {
      headers: { 'accept-language': 'zh-CN' },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('使用飞书登录')
    expect(html).toContain('/auth/login/feishu')
    expect(html).toContain('使用钉钉登录')
  })

  it('serves English copy when Accept-Language prefers en', async () => {
    const { port } = await loadComposition(0, {
      dingtalk: {
        preset: 'dingtalk',
        enabled: true,
        appId: 'ding_test',
        appSecretRef: 'TEST_SECRET',
        redirectUri: 'https://example.com/auth/callback/dingtalk',
      },
    })
    const res = await fetch(`http://127.0.0.1:${port}/auth`, {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    })
    const html = await res.text()
    expect(html).toContain('Sign in with Feishu')
    expect(html).toContain('Sign in with DingTalk')
  })

  it('redirects to Feishu OAuth authorize page with a state on /auth/login/feishu', async () => {
    const { port } = await loadComposition()
    const res = await fetch(`http://127.0.0.1:${port}/auth/login/feishu`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('accounts.feishu.cn')
    expect(location).toContain('client_id=cli_test')
    expect(location).toContain('redirect_uri=https%3A%2F%2Fexample.com')
    expect(new URL(location).searchParams.get('state')).toMatch(
      /^[0-9a-f-]{36}$/i,
    )
  })

  it('returns 404 for unknown channel', async () => {
    const { port } = await loadComposition()
    const res = await fetch(`http://127.0.0.1:${port}/auth/login/unknown`)
    expect(res.status).toBe(404)
  })

  it('returns 401 for /auth/me without cookie', async () => {
    const { port } = await loadComposition()
    const res = await fetch(`http://127.0.0.1:${port}/auth/me`)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('not authenticated')
  })

  it('exchanges code via credentials-resolved secret and sets the session cookie', async () => {
    const { port } = await loadComposition()
    const login = await fetch(`http://127.0.0.1:${port}/auth/login/feishu`, { redirect: 'manual' })
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state')
    expect(state).toBeTruthy()
    if (state === null) return

    const realFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(`http://127.0.0.1:${port}/`)) {
        return realFetch(input, init)
      }
      if (url.includes('/oauth/token') || url.includes('/token')) {
        expect(init?.headers).toMatchObject({
          'content-type': 'application/json; charset=utf-8',
        })
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>
        expect(body.client_secret).toBe('sk-test')
        expect(body.client_id).toBe('cli_test')
        expect(body.code).toBe('abc')
        return new Response(JSON.stringify({ code: 0, access_token: 'tok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('user_info')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { open_id: 'ou_test', name: 'Tester', en_name: 'Tester EN', avatar_url: 'https://example.com/a.png' },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const callback = await fetch(
      `http://127.0.0.1:${port}/auth/callback/feishu?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/')
    const setCookie = callback.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('auth-sid=')

    const sid = /auth-sid=([^;]+)/.exec(setCookie)?.[1]
    expect(sid).toBeTruthy()
    const me = await fetch(`http://127.0.0.1:${port}/auth/me`, {
      headers: { cookie: `auth-sid=${sid}` },
    })
    expect(me.status).toBe(200)
    await expect(me.json()).resolves.toMatchObject({
      provider: 'feishu',
      userId: 'ou_test',
      displayName: 'Tester',
      englishName: 'Tester EN',
    })
    expect(credentialRef('TEST_SECRET')).toBe('TEST_SECRET')
  })

  it('rejects callback with a forged state', async () => {
    const { port } = await loadComposition()
    const res = await fetch(
      `http://127.0.0.1:${port}/auth/callback/feishu?code=abc&state=forged`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(400)
  })

  it('redirects anonymous browsers to /auth when a channel is configured', async () => {
    const { port } = await loadComposition()
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth')
  })

  it('returns 401 for anonymous /api when a channel is configured', async () => {
    const { port } = await loadComposition()
    const res = await fetch(`http://127.0.0.1:${port}/api/anything`)
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'authentication required' })
  })
})

describe('effectiveRedirectUri', () => {
  it('rewrites loopback host to match the request Host header', () => {
    const req = { headers: { host: 'localhost:3080' } }
    expect(AuthGate.effectiveRedirectUri('http://127.0.0.1:3080/auth/callback/feishu', req))
      .toBe('http://localhost:3080/auth/callback/feishu')
  })

  it('keeps non-loopback redirect URIs unchanged', () => {
    const req = { headers: { host: 'localhost:3080' } }
    expect(AuthGate.effectiveRedirectUri('https://app.example.com/auth/callback/feishu', req))
      .toBe('https://app.example.com/auth/callback/feishu')
  })
})
