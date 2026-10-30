/**
 * auth-tenant host: multi-tenant isolation, session filtering, shared-space role guards.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
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
import {
  userFromCookie,
  resolveRole,
  type AuthUser,
  type AuthPrincipal,
} from '@deepseek-ai/dsh-host-auth-gate'

/* ── Re-export auth types for consumers that depend on auth-tenant ───── */

export type { AuthUser, AuthPrincipal } from '@deepseek-ai/dsh-host-auth-gate'

/* ── Tenant context ─────────────────────────────────────────────────────── */

/** Role discriminant for tenant authorization. */
export const ADMIN_ROLE = 'admin' as const

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

/** Request-scoped tenant context; this module is its only reader and writer. */
const tenantAls = new AsyncLocalStorage<TenantContext>()

/**
 * Read the current request's tenant context, if any.
 * @returns The current tenant context, or undefined outside a tenant request.
 */
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
  return tenant.shares.some(s => s.name === spaceName && s.admin)
}

/**
 * Check if a path is visible to the current tenant.
 * Private workspace paths (under userRoot) are always visible.
 * Approved shared spaces are readable by every tenant; an unapproved name is not.
 * @param spacePath - absolute path to check.
 * @param tenant - tenant context; if undefined, returns true (single-user mode).
 * @returns true if the path is visible to the tenant.
 */
export function isSpaceVisible(spacePath: string, tenant?: TenantContext): boolean {
  if (!tenant) return true
  const target = resolve(spacePath)
  const root = resolve(tenant.userRoot)
  if (target === root || isUnder(target, root)) return true
  if (!tenant.sharedRoot) return false
  const shared = resolve(tenant.sharedRoot)
  if (!isUnder(target, shared)) return false
  const spaceName = relative(shared, target).split(sep)[0] ?? ''
  return tenant.shares.some(share => share.name === spaceName)
}

/* ── Tenant root resolution ─────────────────────────────────────────────── */

/**
 * Compute the tenant's picker root: $DSH_HOME/users/<tenantId>/.
 * @param tenantId - Tenant identifier used as the user-root directory name.
 * @returns The tenant's absolute user root.
 */
export function tenantUserRoot(tenantId: string): string {
  return dshHomePath('users', tenantId)
}

/**
 * Compute the shared directory: $DSH_HOME/shared/.
 * @returns The absolute shared-space root.
 */
export function sharedDir(): string {
  return dshHomePath('shared')
}

/**
 * Read the DSH home directory holding credentials and all tenant data.
 * @returns The resolved DSH home directory.
 */
export function dshHome(): string {
  return resolveDshHome()
}

/** Check whether `target` is `root` itself or under it. */
function isUnder(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve a path through symlinks, so a link inside a granted root cannot name a
 * denied target.
 * @param path - path as the caller supplied it.
 * @returns the physical path when it resolves, otherwise the lexical one.
 */
function canonicalTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // A missing path or a link loop keeps its lexical form; the read that
    // follows fails on the same condition.
    return resolve(path)
  }
}

/** Model-facing read tools and the argument fields carrying filesystem paths. */
const READ_TOOL_PATH_ARGS: Record<string, readonly string[]> = {
  read: ['file_path'],
  read_image: ['file_path'],
  glob: ['path'],
  grep: ['path'],
  str_replace_editor: ['path'],
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
 * Whether `path` reads tenant-restricted data: outside the caller's own spill
 * directory, under the DSH home, and outside its tenant root and shared directory.
 */
function isTenantReadDenied(path: string, tenant: TenantContext, sessionId: string | undefined): boolean {
  const target = canonicalTarget(path)
  if (isOwnSpill(target, sessionId)) return false
  // Everything outside $DSH_HOME is outside this model's reach too: tenant
  // workspaces live under their own root, so the host's home, SSH keys, and
  // project .env files never become model input.
  if (!isUnder(target, canonicalTarget(dshHome()))) return true
  if (isUnder(target, canonicalTarget(tenant.userRoot))) return false
  if (isUnder(target, canonicalTarget(sharedDir()))) return false
  return true
}

/**
 * Whether `target` is one of this session's own spill files. The spill backend
 * names each session directory after the session id's hash, so another session's
 * overflow stays denied even though the whole tree sits outside $DSH_HOME.
 * The hash mirrors `spill-local`'s `sessionDir`; drift there degrades to denial.
 */
function isOwnSpill(target: string, sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false
  const rel = relative(canonicalTarget(tmpdir()), target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  const [root, owner] = rel.split(sep)
  if (root?.startsWith('dsh-spill-') !== true) return false
  return owner === `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
}

/** Ensure the tenant's per-user root directory exists: $DSH_HOME/users/<tenantId>/. */
function ensureTenantRoot(tenantId: string): string {
  const root = tenantUserRoot(tenantId)
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true })
  }
  return root
}

/* ── AuthTenant service ─────────────────────────────────────────────────── */

/** Tenant isolation service: binds auth principals to tenant contexts. */
export class AuthTenant extends Service {
  /** Set once so a long-lived process reports its unfenced executions a single time. */
  private warnedUnfenced = false

  constructor(ctx: Context) {
    super(ctx, 'authTenant')
  }

  /**
   * Bind an auth principal to a tenant context. Called from auth-gate's OAuth callback.
   * @param principal - Authenticated principal to bind.
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

  /**
   * Whether `path` is visible to the current request.
   * @param path - directory to test.
   * @returns true outside a tenant request and for the tenant's own or shared spaces.
   */
  visible(path: string): boolean {
    const tenant = currentTenant()
    return tenant === undefined || isSpaceVisible(path, tenant)
  }

  /**
   * The current request's root for picking a workspace. A Remote caller browses
   * nothing above it, so the picker cannot walk into another tenant's home.
   * @returns the tenant root, or undefined outside a tenant request.
   */
  pickerRoot(): string | undefined {
    return currentTenant()?.userRoot
  }

  /**
   * The current request's tenant identity for multi-user isolation.
   * @returns the tenant id, or undefined outside a tenant request.
   */
  tenantId(): string | undefined {
    return currentTenant()?.tenantId
  }

  /**
   * Whether one session's cwd is visible to the current request.
   * A missing cwd is outside every tenant scope.
   * @param cwd - the session's working directory.
   * @returns true outside a tenant request and for a cwd inside the tenant's scope.
   */
  sessionVisible(cwd: string | undefined): boolean {
    const tenant = currentTenant()
    if (tenant === undefined) return true
    return cwd !== undefined && isSpaceVisible(cwd, tenant)
  }

  /**
   * Whether the current request may modify `path`: its own roots, or a shared
   * space whose recorded mode is read-write or that it administers.
   * @param path - directory to test.
   * @returns true outside a tenant request and for writable roots.
   */
  writable(path: string): boolean {
    const tenant = currentTenant()
    if (tenant === undefined) return true
    if (!isSpaceVisible(path, tenant)) return false
    const target = resolve(path)
    const root = resolve(tenant.userRoot)
    if (target === root || isUnder(target, root)) return true
    const spaceName = relative(resolve(tenant.sharedRoot), target).split(sep)[0]
    const share = tenant.shares.find(candidate => candidate.name === spaceName)
    return share !== undefined && (share.mode === 'read-write' || share.admin)
  }

  /**
   * The roots a confined subprocess must not read, and the narrower roots it may.
   * A member is denied their whole home directory, so SSH keys, cloud
   * credentials, and project `.env` files never become shell input; the allow
   * list restores their own workspace, the shared spaces they administer, and
   * the secret-free toolchain settings git reads. A system administrator reads
   * deployment state but never another tenant's private root, so only `users/`
   * stays denied there.
   * @returns deny and allow lists; both empty outside a tenant request.
   */
  readRoots(): { allow: readonly string[]; deny: readonly string[] } {
    const tenant = currentTenant()
    if (tenant === undefined) {
      if (!this.warnedUnfenced) {
        this.warnedUnfenced = true
        this.ctx.logger.warn(
          'auth-tenant: executing without a tenant context; file-read fences are not applied',
        )
      }
      return { allow: [], deny: [] }
    }
    const shared = sharedDir()
    const allow = [
      tenant.userRoot,
      ...tenant.shares.map(share => join(shared, share.name)),
    ]
    if (tenant.role === 'admin') return { allow, deny: [dshHomePath('users')] }
    const home = homedir()
    return {
      allow: [
        ...allow,
        // Only what exists: bwrap cannot bind a missing source.
        ...[join(home, '.gitconfig'), join(home, '.config', 'git')].filter(path => existsSync(path)),
      ],
      // A $DSH_HOME outside the home directory would otherwise stay readable
      // to every subprocess the tenant starts.
      deny: isUnder(dshHome(), home) ? [home] : [home, dshHome()],
    }
  }

  /**
   * Whether the current request belongs to a system administrator, who alone
   * may change deployment-wide state: the credentials document is one file
   * shared by every tenant, so a member's write would change how everyone else
   * authenticates.
   * @returns true for a system administrator, and outside a tenant request where
   *   the operator is the only user.
   */
  isSystemAdmin(): boolean {
    const tenant = currentTenant()
    return tenant === undefined || tenant.role === 'admin'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    authTenant: AuthTenant
  }
}

/* ── Plugin entry ───────────────────────────────────────────────────────── */

export function apply(ctx: Context): void {
  ctx.plugin(AuthTenant)

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
        sctx.logger.warn(`auth-tenant: denied MCP tool ${exec.name} for ${tenant.tenantId}`)
        return Promise.resolve({
          kind: 'deny',
          reason: 'External MCP tools are restricted to administrators for this account.',
        })
      }
      if (exec.name === SHARE_APPROVE_TOOL && tenant.role !== ADMIN_ROLE) {
        sctx.logger.warn(`auth-tenant: denied ${exec.name} for ${tenant.tenantId}`)
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
          if (typeof value === 'string'
            && isTenantReadDenied(value, tenant, exec.agent?.session.header.id)) {
            sctx.logger.warn(`auth-tenant: denied ${exec.name} for ${tenant.tenantId}: ${value}`)
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
