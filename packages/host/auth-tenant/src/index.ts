/**
 * auth-tenant host: multi-tenant isolation, session filtering, shared-space role guards.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  approvedShares,
  installShareTools,
  SHARE_APPROVE_TOOL,
  type ShareRef,
} from './share.ts'

/* ── Auth types (locally defined to avoid build-time dependency on auth-gate) ─ */

/** Role discriminant for tenant authorization. */
export const ADMIN_ROLE = 'admin' as const

/** Authenticated browser user (mirrors auth-gate's AuthUser). */
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

/** Identity cookie name (matches auth-gate). */
const IDENTITY_COOKIE = 'dsh-identity'

/** Parse cookies from request header. */
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

/** Read the authenticated user from the identity cookie. */
function userFromCookie(req: IncomingMessage): AuthUser | undefined {
  const raw = parseCookies(req)[IDENTITY_COOKIE]
  if (!raw) return undefined
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString()) as AuthUser
  } catch {
    return undefined
  }
}

/* ── Tenant context ─────────────────────────────────────────────────────── */

/** Per-request tenant context propagated through AsyncLocalStorage. */
export interface TenantContext {
  tenantId: string
  /** Tenant picker root: $DSH_HOME/users/<tenantId>/, the visibility prefix for tenant data. */
  userRoot: string
  /** Shared-space root: $DSH_HOME/shared/, readable by every tenant. */
  sharedRoot: string
  /** Approved shared spaces, for cwd fencing and list visibility. */
  shares: readonly ShareRef[]
  role: 'admin' | 'member'
  user: AuthUser
}

// Shared via globalThis to avoid circular dependencies between auth-tenant and session-controller.
const GLOBAL_KEY = '__dshTenantAls'
function getOrCreateAls(): AsyncLocalStorage<TenantContext> {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as AsyncLocalStorage<TenantContext> | undefined
  if (existing) return existing
  const als = new AsyncLocalStorage<TenantContext>()
  ;(globalThis as Record<string, unknown>)[GLOBAL_KEY] = als
  return als
}
const tenantAls = getOrCreateAls()

/** Read the current request's tenant context, if any. */
export function currentTenant(): TenantContext | undefined {
  return tenantAls.getStore()
}

/**
 * Check if the current tenant is an administrator of the specified shared space.
 * @param spaceName - shared space name to check.
 * @param tenant - tenant context; if undefined, returns false.
 * @returns true if the tenant is a super admin or a space admin of the specified space.
 */
export function isSpaceAdmin(spaceName: string, tenant?: TenantContext): boolean {
  if (!tenant) return false
  if (tenant.role === 'admin') return true
  return tenant.shares.some(s => s.name === spaceName && s.admin === true)
}

/**
 * Check if a path is visible to the current tenant.
 * Private workspace paths (under userRoot) are always visible.
 * Shared space paths are only visible to super admins and space admins.
 * @param spacePath - absolute path to check.
 * @param tenant - tenant context; if undefined, returns true (single-user mode).
 * @returns true if the path is visible to the tenant.
 */
export function isSpaceVisible(spacePath: string, tenant?: TenantContext): boolean {
  if (!tenant) return true
  const root = tenant.userRoot
  const shared = tenant.sharedRoot
  if (spacePath.startsWith(root + '/') || spacePath === root) return true
  if (!shared || !spacePath.startsWith(shared + '/')) return false
  const spaceName = spacePath.slice(shared.length + 1).split('/')[0] ?? ''
  return isSpaceAdmin(spaceName, tenant)
}

/* ── Tenant root resolution ─────────────────────────────────────────────── */

/** Compute the tenant's picker root: $DSH_HOME/users/<tenantId>/ */
export function tenantUserRoot(tenantId: string): string {
  return join(dshHome(), 'users', tenantId)
}

/** Compute the shared directory: $DSH_HOME/shared/ */
export function sharedDir(): string {
  return join(dshHome(), 'shared')
}

/** The DSH home directory holding credentials and all tenant data. */
export function dshHome(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

/** Check whether `target` is `root` itself or under it. */
function isUnder(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return !rel.startsWith('..') && rel !== ''
}

/** Model-facing read tools and the argument fields carrying filesystem paths. */
const READ_TOOL_PATH_ARGS: Record<string, readonly string[]> = {
  read: ['file_path'],
  read_image: ['file_path'],
  glob: ['path'],
  grep: ['path'],
}

/** MCP tools register under the `mcp__<serverName>__<rawName>` namespace. */
const MCP_TOOL_PREFIX = 'mcp__'

/** Extract the MCP server name from a namespaced tool name. */
function mcpServerOf(toolName: string): string {
  return toolName.slice(MCP_TOOL_PREFIX.length).split('__')[0] ?? ''
}

/** Member-usable MCP server names (comma-separated env), in addition to admins' full access. */
function memberMcpServers(): readonly string[] {
  return process.env.MEMBER_MCP_SERVERS?.split(',').map(s => s.trim()).filter(Boolean) ?? []
}

/**
 * Whether `path` reads tenant-restricted data: under the DSH home but outside
 * the caller's tenant root and the shared directory.
 */
function isTenantReadDenied(path: string, tenant: TenantContext): boolean {
  const target = resolve(path)
  if (!isUnder(target, dshHome())) return false
  if (isUnder(target, tenant.userRoot)) return false
  if (isUnder(target, sharedDir())) return isSharedUploadDenied(target, tenant)
  if (isUnder(target, attachmentsDir())) return isAttachmentReadDenied(target, tenant)
  return true
}

/** Per-tenant attachment visibility: own uploads always visible, shared-space attachments require admin. */
function isAttachmentReadDenied(target: string, tenant: TenantContext): boolean {
  const rel = relative(resolve(attachmentsDir()), target)
  const parts = rel.split('/')
  if (parts[0] === 'users' && parts[1] === tenant.tenantId) return false
  if (parts[0] === 'shared') {
    const spaceName = parts[1] ?? ''
    if (isSpaceAdmin(spaceName, tenant)) return false
  }
  return true
}

/** Per-uploader visibility within shared-space upload directories. */
function isSharedUploadDenied(target: string, tenant: TenantContext): boolean {
  const rel = relative(resolve(sharedDir()), target)
  const parts = rel.split('/')
  const spaceName = parts[0] ?? ''

  if (isSpaceAdmin(spaceName, tenant)) return false

  if (parts.length >= 3 && parts[1] === 'uploads') {
    const fileTenantId = parts[2]
    if (fileTenantId === tenant.tenantId) return false
  }

  return true
}

/** The attachments directory for uploaded files: $DSH_HOME/attachments/. */
function attachmentsDir(): string {
  return join(dshHome(), 'attachments')
}

/** Ensure the tenant's per-user root directory exists: $DSH_HOME/users/<tenantId>/. */
function ensureTenantRoot(tenantId: string): string {
  const root = tenantUserRoot(tenantId)
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true })
  }
  return root
}

/* ── Role resolution ────────────────────────────────────────────────────── */

/** Resolve user role from SUPER_ADMIN_USERS env var. */
function resolveRole(user: AuthUser): 'admin' | 'member' {
  const allowlist = process.env.SUPER_ADMIN_USERS
    ?.split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean) ?? []
  if (allowlist.length === 0) return 'member'
  const keys = [user.userId, user.englishName]
    .map(v => v?.trim().toLowerCase())
    .filter((v): v is string => v !== undefined)
  return keys.some(key => allowlist.includes(key)) ? 'admin' : 'member'
}

/* ── AuthTenant service ─────────────────────────────────────────────────── */

/** Tenant isolation service: binds auth principals to tenant contexts. */
export class AuthTenant extends Service {
  constructor(ctx: Context) {
    super(ctx, 'authTenant')
  }

  /**
   * Bind an auth principal to a tenant context. Called from auth-gate's OAuth callback.
   * @returns the tenant root directory path.
   */
  bindAuthPrincipal(principal: AuthPrincipal): string | undefined {
    const { user } = principal
    const tenantId = user.englishName ?? user.userId
    if (!tenantId) return undefined
    user.tenantId = tenantId
    user.role = resolveRole(user)
    return ensureTenantRoot(tenantId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    authTenant: AuthTenant
  }
}

/* ── GlobalThis filter registration ─────────────────────────────────────── */

/**
 * Register session and workspace filter functions on globalThis.
 * The session-controller and workspace-controller read these at call time
 * to filter their output by tenant visibility.
 */
function installGlobalFilters(): void {
  // Session filter: session-controller calls this to filter SessionRecord[]
  ;(globalThis as Record<string, unknown>).__dshSessionFilter = (records: { header: { cwd?: string } }[]) => {
    const tenant = currentTenant()
    if (tenant === undefined) return records
    return records.filter(r => r.header.cwd !== undefined && isSpaceVisible(r.header.cwd, tenant))
  }

  // Workspace filter: workspace-controller calls this to filter WorkspaceView[]
  ;(globalThis as Record<string, unknown>).__dshWorkspaceFilter = (views: { path: string }[]) => {
    const tenant = currentTenant()
    if (tenant === undefined) return views
    return views.filter(v => isSpaceVisible(v.path, tenant))
  }

  // Permission functions: session-controller reads these for cwd fencing and session visibility.
  ;(globalThis as Record<string, unknown>).__dshTenantPermissions = { isSpaceVisible, isSpaceAdmin }
}

/* ── Plugin entry ───────────────────────────────────────────────────────── */

export function apply(ctx: Context): void {
  ctx.plugin(AuthTenant)

  // Install globalThis filters before any request arrives.
  installGlobalFilters()

  // Shared-space tools.
  installShareTools(ctx)

  // Propagate tenant context through the RPC call chain.
  const withTenant = (req: IncomingMessage, next: () => Promise<void>): Promise<void> => {
    const user = userFromCookie(req)
    if (user === undefined) return next()
    // Always re-derive role server-side — cookie never carries authoritative role.
    user.role = resolveRole(user)
    const tenantId = user.englishName ?? user.userId
    if (!tenantId) return next()
    const context: TenantContext = {
      tenantId,
      userRoot: ensureTenantRoot(tenantId),
      sharedRoot: sharedDir(),
      shares: approvedShares(tenantId),
      role: user.role ?? 'member',
      user,
    }
    return tenantAls.run(context, () => next())
  }
  ctx.on('connection/request', (req: IncomingMessage, _res: ServerResponse, next: () => Promise<void>): Promise<void> => withTenant(req, next))
  ctx.on('webserver/upgrade', (req: IncomingMessage, _socket: Duplex, _head: Buffer, next: () => Promise<void>): Promise<void> => withTenant(req, next))

  // System prompt and tool guards.
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.systemPrompt.section({
      name: 'auth-tenant:context',
      order: 100,
      text: () => {
        const tenant = currentTenant()
        if (tenant === undefined) return ''
        const lines = [
          '## Current user context',
          `- Tenant: ${tenant.tenantId}`,
          `- Role: ${tenant.role}`,
          `- Workspace: ${tenant.userRoot}`,
          `- Shared directory: ${sharedDir()} (readable by everyone; each shared space has a mode — read-write lets members create sessions and modify files, read-only restricts them to viewing, while a space's owner and administrators can always write)`,
        ]
        lines.push('')
        lines.push(tenant.role === 'member'
          ? 'You may publish one of your own spaces with the share_request tool; an administrator must approve the request.'
          : 'You review shared-space requests with the share_approve tool; its add-admin and remove-admin actions manage who administers an approved space.')
        return lines.join('\n')
      },
      interpolate: false,
    })

    // Tool guards via tools/pre-execute.
    sctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      const tenant = currentTenant()
      if (tenant === undefined) return next()
      if (exec.name.startsWith(MCP_TOOL_PREFIX) && tenant.role !== ADMIN_ROLE
        && !memberMcpServers().includes(mcpServerOf(exec.name))) {
        return Promise.resolve({
          kind: 'deny',
          reason: 'External MCP tools are restricted to administrators for this account.',
        })
      }
      if (exec.name === SHARE_APPROVE_TOOL && tenant.role !== ADMIN_ROLE) {
        return Promise.resolve({
          kind: 'deny',
          reason: 'Shared-space approval is restricted to administrators for this account.',
        })
      }
      const pathArgs = READ_TOOL_PATH_ARGS[exec.name]
      if (pathArgs !== undefined) {
        const args = exec.arguments as Record<string, unknown> | undefined
        for (const field of pathArgs) {
          const value = args?.[field]
          if (typeof value === 'string' && isTenantReadDenied(value, tenant)) {
            return Promise.resolve({
              kind: 'deny',
              reason: `Reading "${value}" is not permitted: it is outside your workspace and the shared directory.`,
            })
          }
        }
      }
      return next()
    })
  })
}
