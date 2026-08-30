/** Tenant guards: `/api` RPC overlays, sandbox policy, and subprocess argv containment. */

import type { Context } from '@deepseek-ai/cordis'
import { mkdir } from 'node:fs/promises'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-agent'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialsApi, DownloadsApi, EventsApi, GoalsApi, HostFrame, MuxFrame, RpcError, RpcId, RpcResponse,
  SessionsApi, SettingsApi, SettingsNamespaceView, SubagentsApi,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-credentials'
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'
import { activeTenantId, currentTenantId } from './principal.ts'
import {
  describeTenantCredential,
  GLOBAL_SETTINGS_NAMESPACES,
  isGlobalCredentialRef,
  mutateTenantSettingsSection,
  patchTenantSettingsSection,
  readTenantCredential,
  readTenantSettingsSection,
  readTenantSettingsSectionSync,
  replaceTenantSettingsSection,
  setTenantCredential,
  unsetTenantCredential,
} from './tenant-files.ts'
import { assertTenantArgvPaths, tenantIsolationFor, withTenantIsolation } from './tenant-access.ts'

function rpcOk<T>(rpcId: RpcId, value: T): RpcResponse<T> {
  return { rpcId, result: { ok: true, value } }
}

function rpcErr<T>(rpcId: RpcId, error: RpcError): RpcResponse<T> {
  return { rpcId, result: { ok: false, error } }
}

function sessionForbidden<T>(rpcId: RpcId, sessionId: SessionId): RpcResponse<T> {
  return rpcErr(rpcId, {
    code: 'session-not-found',
    message: 'session not found',
    details: { sessionId },
  })
}

export interface SessionGuardHost {
  ownsAgentSession(tenantId: string, agentSessionId: SessionId): boolean
  rememberHeader(header: SessionHeader): void
  workspaceDir(tenantId: string): string
}

function payloadId(payload: unknown, key: string): SessionId | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const id = Reflect.get(payload, key)
  return typeof id === 'string' ? id as SessionId : undefined
}

/** Reject when any payload session id is outside the authenticated tenant. */
function denyForeign(
  host: SessionGuardHost,
  rpcId: RpcId,
  payload: unknown,
  keys: readonly string[],
): RpcResponse<never> | undefined {
  const tenantId = currentTenantId()
  if (tenantId === undefined) return undefined
  for (const key of keys) {
    const sid = payloadId(payload, key)
    if (sid !== undefined && !host.ownsAgentSession(tenantId, sid)) {
      return sessionForbidden(rpcId, sid)
    }
  }
  return undefined
}

function filterOwned<T>(
  host: SessionGuardHost,
  tenantId: string,
  items: T[],
  sessionIdOf: (item: T) => SessionId,
): T[] {
  return items.filter(item => host.ownsAgentSession(tenantId, sessionIdOf(item)))
}

function mapOwnedItems<V extends { items: { sessionId: SessionId }[] }>(
  host: SessionGuardHost,
  tenantId: string,
  rpcId: RpcId,
  value: V,
): RpcResponse<V> {
  return rpcOk(rpcId, { ...value, items: filterOwned(host, tenantId, value.items, item => item.sessionId) })
}

function filterOwnedItemsRpc<V extends { items: { sessionId: SessionId }[] }>(
  host: SessionGuardHost,
  out: RpcResponse<V>,
): RpcResponse<V> {
  const tenantId = currentTenantId()
  if (!out.result.ok || tenantId === undefined) return out
  return mapOwnedItems(host, tenantId, out.rpcId, out.result.value)
}

function filterOwnedEntriesRpc<V extends { entries: { id: SessionId }[] }>(
  host: SessionGuardHost,
  out: RpcResponse<V>,
): RpcResponse<V> {
  const tenantId = currentTenantId()
  if (!out.result.ok || tenantId === undefined) return out
  const value = out.result.value
  return rpcOk(out.rpcId, {
    ...value,
    entries: filterOwned(host, tenantId, value.entries, entry => entry.id),
  })
}

function denyForeignSessionDownload(host: SessionGuardHost, sessionId: SessionId): Response | undefined {
  const tenantId = currentTenantId()
  if (tenantId !== undefined && !host.ownsAgentSession(tenantId, sessionId)) {
    return new Response('not found', { status: 404 })
  }
  return undefined
}

type GuardedMethod = (request: { rpcId: RpcId; payload: unknown }, ...rest: never[]) => Promise<{ rpcId: RpcId }>

function patchGuardedMethods<O extends object>(
  object: O,
  guard: (fn: GuardedMethod, keys?: readonly string[]) => GuardedMethod,
  keys: readonly (keyof O)[],
  payloadKeys?: readonly string[],
): void {
  for (const key of keys) {
    const orig = object[key]
    if (typeof orig !== 'function') continue
    Reflect.set(object, key, guard(orig.bind(object) as GuardedMethod, payloadKeys))
  }
}

/** Load cold session headers once so ownership survives process restart. */
export async function seedHeadersFromPersistence(ctx: Context, host: SessionGuardHost): Promise<void> {
  const persistence = ctx.get('sessionPersistence') as { list(): Promise<SessionHeader[]> } | undefined
  if (persistence === undefined) return
  for (const header of await persistence.list()) host.rememberHeader(header)
}

function patchSessions(
  sessions: SessionsApi,
  host: SessionGuardHost,
  extra?: { subagents?: SubagentsApi; goals?: GoalsApi; downloads?: DownloadsApi },
): void {
  const guard = <P extends { rpcId: RpcId; payload: unknown }, R extends { rpcId: RpcId }>(
    fn: (r: P, ...rest: never[]) => Promise<R>,
    keys: readonly string[] = ['sessionId'],
  ) =>
    async (request: P, ...rest: never[]): Promise<R> => {
      const denied = denyForeign(host, request.rpcId, request.payload, keys)
      if (denied !== undefined) return denied as unknown as R
      return fn(request, ...rest)
    }

  const list = sessions.list.bind(sessions)
  sessions.list = async req => filterOwnedItemsRpc(host, await list(req))

  const search = sessions.search.bind(sessions)
  sessions.search = async (req, signal) => filterOwnedItemsRpc(host, await search(req, signal))

  if (sessions.create !== undefined) {
    const create = sessions.create.bind(sessions)
    sessions.create = async (req) => {
      const tenantId = currentTenantId()
      if (tenantId === undefined) return create(req)
      const cwd = host.workspaceDir(tenantId)
      await mkdir(cwd, { recursive: true })
      const { workspaceId: _workspaceId, ...payload } = req.payload
      void _workspaceId
      const out = await create({
        ...req,
        payload: { ...payload, cwd },
      })
      if (out.result.ok) {
        host.rememberHeader({
          id: out.result.value.sessionId,
          version: SESSION_FORMAT_VERSION,
          createdAt: Date.now(),
          tenantId,
        })
      }
      return out
    }
  }

  patchGuardedMethods(sessions, guard, [
    'history', 'models', 'selectModel', 'rename', 'fork', 'prompt', 'attachment', 'updateQueue', 'cancel',
  ])

  const goals = extra?.goals
  if (goals !== undefined) {
    patchGuardedMethods(goals, guard, ['create', 'edit', 'pause', 'resume', 'complete', 'clear'])
  }

  const subagents = extra?.subagents
  if (subagents !== undefined) {
    const listSub = subagents.list.bind(subagents)
    subagents.list = async (req, signal) => {
      const denied = denyForeign(host, req.rpcId, req.payload, ['parentSessionId'])
      if (denied !== undefined) return denied
      return filterOwnedEntriesRpc(host, await listSub(req, signal))
    }
    patchGuardedMethods(subagents, guard, ['history', 'prompt', 'interrupt'], ['parentSessionId', 'childSessionId'])
  }

  const downloads = extra?.downloads
  if (downloads !== undefined) {
    const sessionLog = downloads.sessionLog.bind(downloads)
    downloads.sessionLog = async (request, signal) => {
      const denied = denyForeignSessionDownload(host, request.sessionId)
      if (denied !== undefined) return denied
      return sessionLog(request, signal)
    }
  }
}

function allowsMuxFrame(host: SessionGuardHost, tenantId: string, frame: MuxFrame): boolean {
  if (frame.type === 'stream/error') return true
  return host.ownsAgentSession(tenantId, frame.sessionId)
}

function filterHostFrame(host: SessionGuardHost, tenantId: string, frame: HostFrame): HostFrame | undefined {
  switch (frame.type) {
    case 'host/session-added':
    case 'host/session-removed':
    case 'host/session-status':
    case 'host/agent-error':
      return host.ownsAgentSession(tenantId, frame.sessionId) ? frame : undefined
    case 'host/archived-sessions-changed':
      return { ...frame, archivedSessionIds: filterOwned(host, tenantId, frame.archivedSessionIds, id => id) }
    default:
      return frame
  }
}

async function* filterTenantMux(
  host: SessionGuardHost,
  source: AsyncIterable<{ rpcId: RpcId; payload: MuxFrame }>,
): AsyncGenerator<{ rpcId: RpcId; payload: MuxFrame }> {
  for await (const envelope of source) {
    const tenantId = currentTenantId()
    if (tenantId === undefined || allowsMuxFrame(host, tenantId, envelope.payload)) {
      yield envelope
    }
  }
}

async function* filterTenantHost(
  host: SessionGuardHost,
  source: AsyncIterable<{ rpcId: RpcId; payload: HostFrame }>,
): AsyncGenerator<{ rpcId: RpcId; payload: HostFrame }> {
  for await (const envelope of source) {
    const tenantId = currentTenantId()
    if (tenantId === undefined) {
      yield envelope
      continue
    }
    const filtered = filterHostFrame(host, tenantId, envelope.payload)
    if (filtered !== undefined) yield { ...envelope, payload: filtered }
  }
}

/** Drop or trim event frames for sessions outside the active tenant. */
export function patchEvents(events: EventsApi, host: SessionGuardHost): void {
  const mux = events.mux.bind(events)
  events.mux = (request, signal) => filterTenantMux(host, mux(request, signal))

  const hostStream = events.host.bind(events)
  events.host = (request, signal) => filterTenantHost(host, hostStream(request, signal))
}

export function patchAgentCreate(ctx: Context): void {
  ctx.inject(['agents'], (sctx) => {
    const create = sctx.agents.create.bind(sctx.agents)
    sctx.agents.create = async (options) => {
      const tenantId = currentTenantId()
      if (tenantId !== undefined) {
        options = {
          ...options,
          meta: { ...options.meta, tenantId },
        }
      }
      return create(options)
    }
  })
}

async function routeCredentialRef<T>(
  ctx: Context,
  ref: string,
  onTenant: (tenantId: string) => Promise<T>,
  onGlobal: () => Promise<T>,
): Promise<T> {
  const tenantId = activeTenantId(ctx)
  if (tenantId !== undefined && !isGlobalCredentialRef(ref)) return onTenant(tenantId)
  return onGlobal()
}

function patchCredentialsService(ctx: Context): void {
  ctx.inject(['credentials'], (sctx) => {
    const credentials = sctx.credentials as CredentialProvider
    const resolve = credentials.resolve.bind(credentials)
    credentials.resolve = ref => routeCredentialRef(
      sctx,
      ref,
      async (tenantId) => {
        const value = await readTenantCredential(tenantId, ref)
        return value === undefined ? resolve(ref) : { value, source: 'file' }
      },
      () => resolve(ref),
    )

    const describe = credentials.describe.bind(credentials)
    credentials.describe = ref => routeCredentialRef(
      sctx,
      ref,
      tenantId => describeTenantCredential(tenantId, ref),
      () => describe(ref),
    )

    const set = credentials.set.bind(credentials)
    credentials.set = (ref, value) => routeCredentialRef(
      sctx,
      ref,
      tenantId => setTenantCredential(tenantId, ref, value),
      () => set(ref, value),
    )

    const unset = credentials.unset.bind(credentials)
    credentials.unset = ref => routeCredentialRef(
      sctx,
      ref,
      tenantId => unsetTenantCredential(tenantId, ref),
      () => unset(ref),
    )
  })
}

function patchCredentialsApi(credentials: CredentialsApi): void {
  const describe = credentials.describe.bind(credentials)
  credentials.describe = async (request) => {
    const tenantId = currentTenantId()
    if (tenantId === undefined) return describe(request)
    const entries = await Promise.all(request.payload.refs.map(async (ref) => {
      if (isGlobalCredentialRef(ref)) {
        const row = await describe({ ...request, payload: { refs: [ref] } })
        if (!row.result.ok) return [ref, { configured: false, writable: false }] as const
        const info = row.result.value.credentials[ref]
        return [ref, info ?? { configured: false, writable: false }] as const
      }
      const info = await describeTenantCredential(tenantId, ref)
      return [ref, {
        configured: info.configured,
        ...info.source === undefined ? {} : { source: info.source },
        writable: info.writable,
      }] as const
    }))
    return rpcOk(request.rpcId, { credentials: Object.fromEntries(entries) })
  }

  const set = credentials.set.bind(credentials)
  credentials.set = async (request) => {
    const tenantId = currentTenantId()
    const { ref, value } = request.payload
    if (tenantId === undefined || isGlobalCredentialRef(ref)) return set(request)
    try {
      await setTenantCredential(tenantId, ref, value)
    } catch (error: unknown) {
      return rpcErr(request.rpcId, {
        code: 'credential-rejected',
        message: error instanceof Error ? error.message : String(error),
        details: { ref },
      })
    }
    return rpcOk(request.rpcId, {})
  }

  const unset = credentials.unset.bind(credentials)
  credentials.unset = async (request) => {
    const tenantId = currentTenantId()
    const { ref } = request.payload
    if (tenantId === undefined || isGlobalCredentialRef(ref)) return unset(request)
    await unsetTenantCredential(tenantId, ref)
    return rpcOk(request.rpcId, {})
  }
}

function isGlobalNamespace(ns: string): boolean {
  return GLOBAL_SETTINGS_NAMESPACES.has(ns)
}

function overlayNamespace(view: SettingsNamespaceView, tenantUser: Record<string, unknown> | undefined): SettingsNamespaceView {
  if (tenantUser === undefined) {
    return { ...view, user: undefined }
  }
  return { ...view, user: tenantUser }
}

async function afterTenantWrite(
  settings: SettingsApi,
  rpcId: RpcId,
  ns: string,
): Promise<Awaited<ReturnType<SettingsApi['update']>>> {
  const described = await settings.describe({ rpcId, payload: {} })
  if (!described.result.ok) {
    return rpcErr(rpcId, described.result.error)
  }
  const view = described.result.value.namespaces.find(row => row.ns === ns)
  if (view === undefined) {
    return rpcErr(rpcId, {
      code: 'internal',
      message: `settings namespace "${ns}" missing after tenant write`,
      details: {},
    })
  }
  return rpcOk(rpcId, view)
}

function settingsRejected(rpcId: RpcId, ns: string, error: unknown): RpcResponse<SettingsNamespaceView> {
  return rpcErr(rpcId, {
    code: 'settings-rejected',
    message: error instanceof Error ? error.message : String(error),
    details: { ns },
  })
}

type SettingsWriteRequest = {
  rpcId: Parameters<SettingsApi['update']>[0]['rpcId']
  payload: { ns: string }
}

type SettingsWriteResult = Awaited<ReturnType<SettingsApi['update']>>

function patchTenantSettingsWrite<R extends SettingsWriteRequest>(
  settings: SettingsApi,
  orig: (request: R) => Promise<SettingsWriteResult>,
  write: (tenantId: string, request: R) => Promise<void>,
): (request: R) => Promise<SettingsWriteResult> {
  return async (request: R) => {
    const tenantId = currentTenantId()
    if (tenantId === undefined || isGlobalNamespace(request.payload.ns)) return orig(request)
    try {
      await write(tenantId, request)
    } catch (error: unknown) {
      return settingsRejected(request.rpcId, request.payload.ns, error)
    }
    return afterTenantWrite(settings, request.rpcId, request.payload.ns)
  }
}

function patchSettingsApi(settings: SettingsApi): void {
  const describe = settings.describe.bind(settings)
  settings.describe = async (request) => {
    const tenantId = currentTenantId()
    const out = await describe(request)
    if (!out.result.ok || tenantId === undefined) return out
    const value = out.result.value
    const namespaces = await Promise.all(value.namespaces.map(async (view) => {
      if (isGlobalNamespace(view.ns)) return view
      const tenantUser = await readTenantSettingsSection(tenantId, view.ns)
      return overlayNamespace(view, tenantUser)
    }))
    return rpcOk(out.rpcId, { ...value, namespaces })
  }

  const update = settings.update.bind(settings)
  settings.update = patchTenantSettingsWrite(settings, update, async (tenantId, request) => {
    await patchTenantSettingsSection(tenantId, request.payload.ns, request.payload.patch as Record<string, unknown>)
  })

  const replace = settings.replace.bind(settings)
  settings.replace = patchTenantSettingsWrite(settings, replace, async (tenantId, request) => {
    await replaceTenantSettingsSection(tenantId, request.payload.ns, request.payload.section as Record<string, unknown>)
  })

  const mutate = settings.mutate.bind(settings)
  settings.mutate = patchTenantSettingsWrite(settings, mutate, async (tenantId, request) => {
    await mutateTenantSettingsSection(tenantId, request.payload.ns, request.payload.ops)
  })
}

type SettingsRegistration = {
  schema: z<unknown>
  base?: unknown
  validate?: (value: unknown) => void
}

type SettingsInternals = {
  get(ns: SettingsNamespace): unknown
  registrations: Map<SettingsNamespace, SettingsRegistration>
  resolve(
    schema: z<unknown>,
    base: unknown,
    section: Record<string, unknown> | undefined,
    validate?: (value: unknown) => void,
  ): unknown
}

/** Route `ctx.settings.get()` through tenant `settings.yaml` user layers. */
function patchSettingsService(ctx: Context): void {
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings as unknown as SettingsInternals
    const get = settings.get.bind(settings)
    settings.get = (ns: SettingsNamespace) => {
      const tenantId = activeTenantId(sctx)
      if (tenantId === undefined || GLOBAL_SETTINGS_NAMESPACES.has(String(ns))) return get(ns)
      const tenantUser = readTenantSettingsSectionSync(tenantId, String(ns))
      if (tenantUser === undefined) return get(ns)
      const registration = settings.registrations.get(ns)
      if (registration === undefined) return get(ns)
      return settings.resolve(registration.schema, registration.base, tenantUser, registration.validate)
    }
  })
}

/** Patch apiProxy RPC faces for tenant-scoped sessions, settings, and credentials. */
export function patchApiAccess(
  proxy: {
    sessions: SessionsApi
    credentials: CredentialsApi
    settings: SettingsApi
    events: EventsApi
    subagents?: SubagentsApi
    goals?: GoalsApi
    downloads?: DownloadsApi
  },
  host: SessionGuardHost,
): void {
  patchSessions(proxy.sessions, host, {
    ...(proxy.subagents === undefined ? {} : { subagents: proxy.subagents }),
    ...(proxy.goals === undefined ? {} : { goals: proxy.goals }),
    ...(proxy.downloads === undefined ? {} : { downloads: proxy.downloads }),
  })
  patchCredentialsApi(proxy.credentials)
  patchSettingsApi(proxy.settings)
  patchEvents(proxy.events, host)
}

/** Patch settings/credentials services and agent session metadata. */
export function patchApiServices(ctx: Context): void {
  patchAgentCreate(ctx)
  patchCredentialsService(ctx)
  patchSettingsService(ctx)
}

/** Stamp `tenantIsolation` on every `ctx.sandboxPolicy.resolve()` result. */
export function patchSandboxPolicyResolve(ctx: Context): void {
  ctx.inject(['sandboxPolicy'], (sctx) => {
    const resolve = sctx.sandboxPolicy.resolve.bind(sctx.sandboxPolicy)
    sctx.sandboxPolicy.resolve = (request) => {
      const policy = resolve(request)
      return withTenantIsolation(policy, tenantIsolationFor(sctx))
    }
  })
}

/** Reject subprocess argv paths that cross tenant boundaries under `$DSH_HOME/users/`. */
export function patchSubprocessSpawn(ctx: Context): void {
  ctx.inject(['subprocess'], (sctx) => {
    const subprocess = sctx.subprocess as SubprocessRuntime
    const spawn = subprocess.spawn.bind(subprocess)
    subprocess.spawn = (spec) => {
      const isolation = tenantIsolationFor(sctx)
      if (isolation !== undefined) assertTenantArgvPaths(isolation, spec.argv, spec.cwd)
      return spawn(spec)
    }
  })
}
