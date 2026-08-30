/**
 * Unit test for auth-tenant: tenant resolution, durable ownership, credentials routing.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { AuthGate, type AuthPrincipal } from '@deepseek-ai/dsh-host-auth-gate'
import { RpcId, type EventsApi, type RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'
import { AuthTenant, tenantSlugFromUser } from '../src/index.ts'
import { runWithPrincipalAsync } from '../src/principal.ts'
import { setTenantCredential, applySettingsPathOps, mutateTenantSettingsSection, readTenantSettingsSection } from '../src/tenant-files.ts'

function rpcOk<T>(rpcId: RpcId, value: T): RpcResponse<T> {
  return { rpcId, result: { ok: true, value } }
}

const stubWebServer = {
  registerHttpGate: () => () => {},
  registerUpgradeGate: () => () => {},
  register: () => () => {},
  registerUpgrade: () => () => {},
  registerFallback: () => () => {},
  collectIndexInjections: () => [],
  renderIndex: (html: string) => html,
  port: 0,
  host: '127.0.0.1',
}

const defaultCredentialsApi = {
  describe: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { credentials: {} }),
  set: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, {}),
  unset: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, {}),
}

const defaultSettingsApi = {
  describe: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { writable: true, hasDocument: true, namespaces: [] }),
  openDocument: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, undefined as never),
  update: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { ns: 'permission', user: {}, revision: 0, writable: true }),
  replace: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { ns: 'permission', user: {}, revision: 0, writable: true }),
  mutate: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { ns: 'permission', user: {}, revision: 0, writable: true }),
}

function stubApiProxy(ctx: Context, overrides: Record<string, unknown> = {}): void {
  ctx.provide('apiProxy', {
    sessions: {
      list: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { items: [] }),
      search: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { items: [], hasMore: false }),
      history: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { events: [], hasMore: false }),
    },
    credentials: defaultCredentialsApi,
    settings: defaultSettingsApi,
    events: {
      mux: async function* () {
        yield { rpcId: RpcId('mux-1'), payload: { type: 'session/subscribed', sessionId: SessionId('session-agent-1'), lastSeq: 0 } }
        yield { rpcId: RpcId('mux-2'), payload: { type: 'session/subscribed', sessionId: SessionId('session-other-1'), lastSeq: 0 } }
      },
      host: async function* () {
        yield { rpcId: RpcId('host-1'), payload: { type: 'host/session-added', sessionId: SessionId('session-agent-1'), blank: true } }
        yield { rpcId: RpcId('host-2'), payload: { type: 'host/session-removed', sessionId: SessionId('session-other-1') } }
      },
    },
    ...overrides,
  })
}

function stubHost(
  ctx: Context,
  apiOverrides: Record<string, unknown> = {},
  coldHeaders: SessionHeader[] = [{
    version: SESSION_FORMAT_VERSION,
    id: SessionId('session-cold-1'),
    createdAt: 1,
    tenantId: 'bob',
  }],
): void {
  ctx.provide('webServer', stubWebServer)
  stubApiProxy(ctx, apiOverrides)
  ctx.provide('sessionPersistence', { list: async () => coldHeaders })
  void ctx.plugin(AuthGate)
}

async function bootTenant(
  apiOverrides: Record<string, unknown> = {},
  coldHeaders?: SessionHeader[],
): Promise<{ ctx: Context; tenant: AuthTenant }> {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'auth-tenant-'))
  const ctx = new Context()
  stubHost(ctx, apiOverrides, coldHeaders)
  await ctx.plugin(AuthTenant)
  return { ctx, tenant: ctx.authTenant }
}

describe('auth-tenant', () => {
  it('uses englishName slug for per-user tenants', async () => {
    const { tenant } = await bootTenant()
    expect(tenant.resolve({ userId: 'ou_1', englishName: 'Alice Wang' })).toBe('alice-wang')
    expect(tenantSlugFromUser('Alice Wang', 'ou_1')).toBe('alice-wang')
    expect(tenantSlugFromUser(undefined, 'ou_fallback')).toBe('ou_fallback')
  })

  it('filters session.list to owned sessions under an authenticated tenant', async () => {
    const owned = SessionId('session-owned')
    const foreign = SessionId('session-foreign')
    const { ctx } = await bootTenant({
      sessions: {
        list: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, {
          items: [
            { sessionId: owned, title: 'mine', blank: false },
            { sessionId: foreign, title: 'theirs', blank: false },
          ],
        }),
        search: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { items: [], hasMore: false }),
        history: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { events: [], hasMore: false }),
      },
      events: { mux: async function* () {}, host: async function* () {} },
    }, [])
    ctx.authTenant.rememberHeader({
      version: SESSION_FORMAT_VERSION,
      id: owned,
      createdAt: 1,
      tenantId: 'bob',
    })
    const principal = {
      authSid: 'auth-list',
      user: { provider: 'feishu', userId: 'ou_1', englishName: 'Bob', tenantId: 'bob' },
    }
    const out = await runWithPrincipalAsync(principal, async () =>
      ctx.get('apiProxy')!.sessions.list({ rpcId: RpcId('list-1'), payload: {} }))
    expect(out.result.ok).toBe(true)
    if (!out.result.ok) return
    expect(out.result.value.items.map(item => item.sessionId)).toEqual([owned])
  })

  it('rejects goal mutations and subagent reads for foreign sessions', async () => {
    const ownedParent = SessionId('session-owned')
    const foreignParent = SessionId('session-foreign')
    const ownedChild = SessionId('child-owned')
    const foreignChild = SessionId('child-foreign')
    const { ctx } = await bootTenant({
      sessions: {
        list: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { items: [] }),
        search: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { items: [], hasMore: false }),
      },
      goals: {
        create: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { ref: { id: 'goal-1' as never, revision: 1 } }),
        edit: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { ref: { id: 'goal-1' as never, revision: 2 } }),
        pause: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { ref: { id: 'goal-1' as never, revision: 3 } }),
        resume: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { ref: { id: 'goal-1' as never, revision: 4 } }),
        complete: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { ref: { id: 'goal-1' as never, revision: 5 } }),
        clear: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { cleared: true as const }),
      },
      subagents: {
        list: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, {
          entries: [
            { kind: 'child', id: ownedChild, activity: 'inactive', hasChildren: false, mode: 'one-shot' },
            { kind: 'child', id: foreignChild, activity: 'inactive', hasChildren: false, mode: 'one-shot' },
          ],
          parentAvailable: true,
        }),
        history: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { events: [], hasMore: false }),
        prompt: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { messageId: 'msg-1' as never }),
        interrupt: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { accepted: true as const }),
      },
      downloads: {
        sessionLog: async () => new Response('zip-bytes', { status: 200 }),
      },
      events: { mux: async function* () {}, host: async function* () {} },
    }, [])
    ctx.authTenant.rememberHeader({
      version: SESSION_FORMAT_VERSION,
      id: ownedParent,
      createdAt: 1,
      tenantId: 'bob',
    })
    ctx.authTenant.rememberHeader({
      version: SESSION_FORMAT_VERSION,
      id: ownedChild,
      createdAt: 1,
      tenantId: 'bob',
    })
    const principal = {
      authSid: 'auth-p0',
      user: { provider: 'feishu', userId: 'ou_1', englishName: 'Bob', tenantId: 'bob' },
    }
    const sessionError = (sessionId: SessionId) => ({
      ok: false,
      error: { code: 'session-not-found', message: 'session not found', details: { sessionId } },
    })
    await runWithPrincipalAsync(principal, async () => {
      const api = ctx.get('apiProxy')!
      expect((await api.goals!.create({
        rpcId: RpcId('goal-create'),
        payload: { sessionId: foreignParent, objective: 'x' },
      })).result).toEqual(sessionError(foreignParent))
      const listOwned = await api.subagents!.list({
        rpcId: RpcId('sub-list-owned'),
        payload: { parentSessionId: ownedParent },
      })
      expect(listOwned.result.ok).toBe(true)
      if (listOwned.result.ok) {
        expect(listOwned.result.value.entries.map(entry => entry.id)).toEqual([ownedChild])
      }
      expect((await api.subagents!.list({
        rpcId: RpcId('sub-list-foreign'),
        payload: { parentSessionId: foreignParent },
      })).result).toEqual(sessionError(foreignParent))
      expect((await api.subagents!.history({
        rpcId: RpcId('sub-hist'),
        payload: { parentSessionId: ownedParent, childSessionId: foreignChild, mode: 'one-shot' },
      })).result).toEqual(sessionError(foreignChild))
      const exportResponse = await api.downloads!.sessionLog(
        { sessionId: foreignParent },
        new AbortController().signal,
      )
      expect(exportResponse.status).toBe(404)
      const ownedExport = await api.downloads!.sessionLog(
        { sessionId: ownedParent },
        new AbortController().signal,
      )
      expect(ownedExport.status).toBe(200)
    })
  })

  it('rejects session.history for sessions outside the authenticated tenant', async () => {
    const { ctx, tenant } = await bootTenant()
    const foreign = SessionId('session-foreign')
    expect(tenant.ownsAgentSession('bob', foreign)).toBe(false)
    const principal = {
      authSid: 'auth-history',
      user: { provider: 'feishu', userId: 'ou_1', englishName: 'Bob', tenantId: 'bob' },
    }
    const out = await runWithPrincipalAsync(principal, async () =>
      ctx.get('apiProxy')!.sessions.history({ rpcId: RpcId('hist-1'), payload: { sessionId: foreign } }))
    expect(out).toEqual({
      rpcId: RpcId('hist-1'),
      result: {
        ok: false,
        error: { code: 'session-not-found', message: 'session not found', details: { sessionId: foreign } },
      },
    })
  })

  it('binds auth principal and tracks session ownership from headers', async () => {
    const { tenant } = await bootTenant()
    const principal: AuthPrincipal = {
      authSid: 'auth-1',
      user: { provider: 'feishu', userId: 'ou_1', englishName: 'Bob' },
    }
    expect(tenant.bindAuthPrincipal(principal)).toBe('bob')
    expect(principal.user.tenantId).toBe('bob')
    tenant.rememberHeader({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-agent-1'),
      createdAt: 1,
      tenantId: 'bob',
    })
    expect(tenant.ownsAgentSession('bob', SessionId('session-agent-1'))).toBe(true)
    expect(tenant.ownsAgentSession('alice', SessionId('session-agent-1'))).toBe(false)
    expect(tenant.workspaceDir('bob')).toContain('/users/bob/workspace')
  })

  it('restores ownership from persisted session headers after restart', async () => {
    const { tenant } = await bootTenant()
    await vi.waitFor(() => {
      expect(tenant.ownsAgentSession('bob', SessionId('session-cold-1'))).toBe(true)
    })
    expect(tenant.ownsAgentSession('alice', SessionId('session-cold-1'))).toBe(false)
  })

  it('stores tenant credentials outside the global document', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auth-tenant-cred-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    await setTenantCredential('alice', 'DEEPSEEK_API_KEY', 'sk-tenant')
    const text = await readFile(join(home, 'users', 'alice', '.credentials.yaml'), 'utf8')
    expect(text).toContain('DEEPSEEK_API_KEY')
    expect(text).toContain('sk-tenant')
    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
    else process.env.DSH_HOME = prevHome
  })

  it('applies tenant settings mutate ops in-plugin without touching shared ui-settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auth-tenant-settings-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    expect(applySettingsPathOps({}, [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }]))
      .toEqual({ defaultPreset: 'read-only' })
    await mutateTenantSettingsSection('alice', 'permission', [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }])
    expect(await readTenantSettingsSection('alice', 'permission')).toEqual({ defaultPreset: 'workspace-write' })
    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
    else process.env.DSH_HOME = prevHome
  })

  it('patchEvents drops foreign session mux frames', async () => {
    const host = {
      ownsAgentSession: (tenantId: string, sid: SessionId) =>
        tenantId === 'bob' && sid === SessionId('session-agent-1'),
      rememberHeader: () => {},
      workspaceDir: () => '/tmp',
    }
    const events: Pick<EventsApi, 'mux' | 'host'> = {
      mux: async function* () {
        yield { rpcId: RpcId('1'), payload: { type: 'session/subscribed' as const, sessionId: SessionId('session-agent-1'), lastSeq: 0 } }
        yield { rpcId: RpcId('2'), payload: { type: 'session/subscribed' as const, sessionId: SessionId('session-other-1'), lastSeq: 0 } }
      },
      host: async function* () {},
    }
    const { patchEvents } = await import('../src/guards-api.ts')
    patchEvents(events as EventsApi, host)
    const principal = {
      authSid: 'auth-1',
      user: { provider: 'feishu', userId: 'ou_1', tenantId: 'bob' },
    }
    const ids = await runWithPrincipalAsync(principal, async () => {
      const out: string[] = []
      for await (const frame of events.mux({ rpcId: RpcId('mux'), payload: {} }, new AbortController().signal)) {
        if (frame.payload.type === 'session/subscribed') out.push(frame.payload.sessionId)
      }
      return out
    })
    expect(ids).toEqual(['session-agent-1'])
  })

  it('overlays tenant settings through ctx.settings.get at runtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auth-tenant-settings-get-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const ctx = new Context()
    class MemorySettings extends SettingsProvider {
      override readonly writable = true
      protected override load() {
        return Promise.resolve({ permission: { defaultPreset: 'read-only' } })
      }
      protected override persist() {
        return Promise.resolve()
      }
    }
    const schema = z.object({ defaultPreset: z.union(['read-only', 'workspace-write'] as const) })
    const ns = settingsNamespace('permission')
    await ctx.plugin(MemorySettings)
    ctx.provide('webServer', {
      registerHttpGate: () => () => {},
      registerUpgradeGate: () => () => {},
      register: () => () => {},
      registerUpgrade: () => () => {},
      registerFallback: () => () => {},
      collectIndexInjections: () => [],
      renderIndex: (html: string) => html,
      port: 0,
      host: '127.0.0.1',
    })
    ctx.provide('apiProxy', {
      sessions: {
        list: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { items: [] }),
        search: async (request: { rpcId: RpcId }) => rpcOk(request.rpcId, { items: [], hasMore: false }),
      },
    })
    ctx.provide('sessionPersistence', { list: async () => [] })
    void ctx.plugin(AuthGate)
    await ctx.plugin(AuthTenant)
    ctx.settings.register(ns, schema)
    expect(ctx.settings.get(ns)).toEqual({ defaultPreset: 'read-only' })
    await mutateTenantSettingsSection('alice', 'permission', [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }])
    const principal = {
      authSid: 'auth-2',
      user: { provider: 'feishu', userId: 'ou_2', englishName: 'Alice', tenantId: 'alice' },
    }
    expect(await runWithPrincipalAsync(principal, async () => ctx.settings.get(ns))).toEqual({ defaultPreset: 'workspace-write' })
    expect(ctx.settings.get(ns)).toEqual({ defaultPreset: 'read-only' })
    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
    else process.env.DSH_HOME = prevHome
  })

  it('blocks cross-tenant ctx.fs reads under $DSH_HOME/users/', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auth-tenant-fs-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    await mkdir(join(home, 'users', 'alice'), { recursive: true })
    await mkdir(join(home, 'users', 'bob'), { recursive: true })
    await writeFile(join(home, 'users', 'alice', 'mine.txt'), 'alice-secret', 'utf8')
    await writeFile(join(home, 'users', 'bob', 'theirs.txt'), 'bob-secret', 'utf8')

    const ctx = new Context()
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: home })
    await ctx.plugin(SandboxedFileSystem, { cwd: home })
    stubHost(ctx)
    await ctx.plugin(AuthTenant)

    const aliceTarget = await ctx.fs.resolve(join(home, 'users', 'alice', 'mine.txt'))
    const bobTarget = await ctx.fs.resolve(join(home, 'users', 'bob', 'theirs.txt'))
    const principal = {
      authSid: 'auth-fs',
      user: { provider: 'feishu', userId: 'ou_alice', englishName: 'Alice', tenantId: 'alice' },
    }

    await runWithPrincipalAsync(principal, async () => {
      expect(await ctx.fs.readText(aliceTarget)).toBe('alice-secret')
      await expect(ctx.fs.readText(bobTarget)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })
    expect(await ctx.fs.readText(bobTarget)).toBe('bob-secret')

    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
    else process.env.DSH_HOME = prevHome
  })

  it('blocks cross-tenant ctx.fs writes even when sandbox mode is danger-full-access', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auth-tenant-fs-write-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    await mkdir(join(home, 'users', 'alice'), { recursive: true })
    await mkdir(join(home, 'users', 'bob'), { recursive: true })
    await writeFile(join(home, 'users', 'bob', 'theirs.txt'), 'bob-secret', 'utf8')

    const ctx = new Context()
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: home })
    await ctx.plugin(SandboxedFileSystem, { cwd: home })
    stubHost(ctx)
    await ctx.plugin(AuthTenant)

    const bobTarget = await ctx.fs.resolve(join(home, 'users', 'bob', 'theirs.txt'))
    const principal = {
      authSid: 'auth-fs-write',
      user: { provider: 'feishu', userId: 'ou_alice', englishName: 'Alice', tenantId: 'alice' },
    }

    await runWithPrincipalAsync(principal, async () => {
      await expect(ctx.fs.writeText(
        bobTarget,
        'pwned',
        undefined,
        undefined,
        { mode: 'danger-full-access', workspaceRoot: join(home, 'users', 'alice') },
      )).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    })
    expect(await ctx.fs.readText(bobTarget)).toBe('bob-secret')

    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
    else process.env.DSH_HOME = prevHome
  })

  it('resolves tenant from the active agent initiator when no /api principal is set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auth-tenant-fs-agent-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    await mkdir(join(home, 'users', 'alice'), { recursive: true })
    await mkdir(join(home, 'users', 'bob'), { recursive: true })
    await writeFile(join(home, 'users', 'bob', 'theirs.txt'), 'bob-secret', 'utf8')

    const ctx = new Context()
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: home })
    await ctx.plugin(SandboxedFileSystem, { cwd: home })
    stubHost(ctx)
    await ctx.plugin(AuthTenant)
    ctx.provide('agents', {
      requireInitiator: () => ({
        session: { header: { tenantId: 'alice' } },
      }),
    })

    const bobTarget = await ctx.fs.resolve(join(home, 'users', 'bob', 'theirs.txt'))
    await expect(ctx.fs.readText(bobTarget)).rejects.toBeInstanceOf(FsError)

    if (prevHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
    else process.env.DSH_HOME = prevHome
  })
})
