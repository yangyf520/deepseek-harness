/**
 * Shared-space requests: member applications, administrator decisions, and the
 * record file that both the tools and the tenant context read.
 *
 * @module @deepseek-ai/dsh-host-auth-tenant/share
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { ADMIN_ROLE, currentTenant, dshHome, sharedDir, tenantUserRoot } from './index.ts'

/** One shared-space record: a request lifecycle entry that becomes the ownership map once approved. */
export interface ShareEntry {
  /** Stable short id the administrator references in decisions. */
  id: string
  /** Absolute path of the requester's directory to publish. */
  space: string
  /** Directory name under the shared root; unique among approved entries. */
  name: string
  /** Requester's tenant id (english name): the write grant key. */
  owner: string
  /** Request lifecycle state. */
  status: 'pending' | 'approved' | 'rejected'
  /** Access mode for non-owner members. */
  mode: 'read-only' | 'read-write'
  /** Tenant ids with administrator standing on the approved space: they keep write access even in read-only mode. */
  admins?: string[]
  /** Request time, epoch milliseconds. */
  createdAt: number
  /** Decision time, epoch milliseconds. */
  decidedAt?: number
  /** Deciding administrator's tenant id. */
  decidedBy?: string
}

/** Approved shared space as the requesting tenant's context carries it. */
export interface ShareRef {
  readonly name: string
  readonly owner: string
  readonly mode: 'read-only' | 'read-write'
  /** Whether the requesting tenant holds administrator standing on this space (owner or listed admin). */
  readonly admin: boolean
}

/** The name the approval gate in the plugin entry matches against. */
export const SHARE_APPROVE_TOOL = 'share_approve'

/** Record file holding every share request: `$DSH_HOME/.shares.json`. */
function sharesFile(): string {
  return join(dshHome(), '.shares.json')
}

/** Structural check for one entry read back from disk. */
function isShareEntry(value: unknown): value is ShareEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.space === 'string'
    && typeof entry.name === 'string' && typeof entry.owner === 'string'
    && (entry.status === 'pending' || entry.status === 'approved' || entry.status === 'rejected')
    && (entry.mode === undefined || entry.mode === 'read-only' || entry.mode === 'read-write')
    && (entry.admins === undefined
      || (Array.isArray(entry.admins) && entry.admins.every(admin => typeof admin === 'string')))
}

/**
 * Read every share record.
 * @returns the recorded entries; a missing file (first run) or unreadable content resolves to none.
 */
export function shareEntries(): readonly ShareEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sharesFile(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isShareEntry) : []
  } catch {
    // A missing (first run) or corrupt record file means nothing was recorded; context building must never fail on it.
    return []
  }
}

/**
 * List approved shared spaces as the requesting tenant sees them.
 * @param tenantId - requesting tenant, whose administrator standing each ref reflects.
 * @returns `{ name, owner, mode, admin }` refs for the request tenant context.
 */
export function approvedShares(tenantId: string): readonly ShareRef[] {
  return shareEntries()
    .filter(entry => entry.status === 'approved')
    .map(entry => ({
      name: entry.name,
      owner: entry.owner,
      mode: entry.mode ?? 'read-write',
      admin: entry.owner === tenantId || entry.admins?.includes(tenantId) === true,
    }))
}

/** Atomically replace the record file: owner-only mode, written via a temporary sibling. */
function writeShareEntries(entries: readonly ShareEntry[]): void {
  const file = sharesFile()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

/** Apply one mutation to a recorded entry and persist the result. */
function updateEntry(id: string, mutate: (entry: ShareEntry) => void): void {
  const entries = [...shareEntries()]
  const entry = entries.find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error(`share record "${id}" no longer exists`)
  mutate(entry)
  writeShareEntries(entries)
}

/** Check whether `target` sits strictly below `root`. */
function isStrictlyUnder(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..')
}

/** Reject target names that would escape the shared root. */
function assertShareName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`invalid shared space name "${name}": use a single directory name`)
  }
}

/** Names reserved because every tenant has a default directory with that name. */
const RESERVED_SHARE_NAMES = new Set(['workspace'])

/**
 * Validate one proposed shared-space name: single-directory format plus the
 * reserved-name guard, so a share can never land on a name that reads as
 * "someone's default workspace" instead of describing its content.
 */
function assertUsableShareName(name: string): void {
  assertShareName(name)
  if (RESERVED_SHARE_NAMES.has(name.toLowerCase())) {
    throw new Error(`"${name}" is reserved: every tenant has a default directory with that name; use a name that describes the content`)
  }
}

/** One-line listing of the directory's top level, shown on the request confirmation. */
function directoryOverview(target: string): string {
  const names = readdirSync(target)
  if (names.length === 0) return 'empty directory'
  const shown = names.slice(0, 6).join(', ')
  return `${names.length} top-level entr${names.length === 1 ? 'y' : 'ies'}: ${shown}${names.length > 6 ? ', …' : ''}`
}

/**
 * Register the shared-space request and decision tools on the host.
 * @param ctx - host context; the tools and workspace registries are injected.
 */
export function installShareTools(ctx: Context): void {
  ctx.inject(['tools', 'workspaceRegistry'], (sctx) => {
    sctx.tools.register(defineTool({
      name: 'share_request',
      description: 'Publish one of the user\'s own directories as a shared space so every member can read it. Look at the directory content first and derive a content-specific name for "name" — generic names such as "workspace" are rejected. The request creates a pending record that an administrator must approve; the shared space is created empty and content is copied into it afterwards. Directories containing a .wiki knowledge base cannot be shared wholesale. You will be asked whether other members should have read-only or read-write access.',
      parameters: {
        space: {
          type: 'string',
          required: true,
          description: 'Name or absolute path of the space to publish, under the user\'s own workspace root.',
        },
        name: {
          type: 'string',
          required: true,
          description: 'Shared-space name derived from the directory\'s content, specific enough to tell the spaces apart (for example "2026-Q3-华南销售报表").',
        },
        mode: {
          type: 'string',
          required: true,
          enum: ['read-only', 'read-write'] as const,
          description: 'Access level for non-owner members: "read-only" means others can only view files; "read-write" means others can also create sessions and modify files in this shared space.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute(args) {
        const tenant = currentTenant()
        if (tenant === undefined) {
          throw new Error('share_request requires an authenticated tenant request')
        }
        const target = resolve(tenant.userRoot, args.space)
        if (!isStrictlyUnder(target, tenant.userRoot)) {
          throw new Error(`"${args.space}" is not under the user's own workspace root`)
        }
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          throw new Error(`"${args.space}" is not an existing directory`)
        }
        if (existsSync(join(target, '.wiki'))) {
          throw new Error(`"${args.space}" contains a .wiki knowledge base and cannot be shared wholesale; share a specific project subdirectory instead`)
        }
        assertUsableShareName(args.name)
        const entries = shareEntries()
        const pending = entries.find(entry => entry.status === 'pending' && entry.space === target)
        if (pending !== undefined) {
          return Promise.resolve({
            message: `A pending request for this space already exists (id ${pending.id}); an administrator still needs to decide it.`,
          })
        }
        const taken = entries.find(entry => entry.status !== 'rejected' && entry.name === args.name)
        if (taken !== undefined) {
          throw new Error(`shared/${args.name} is already ${taken.status === 'approved' ? 'an approved shared space' : `pending as request ${taken.id}`}; choose a different name`)
        }
        const entry: ShareEntry = {
          id: randomUUID().slice(0, 8),
          space: target,
          name: args.name,
          owner: tenant.tenantId,
          status: 'pending',
          mode: args.mode,
          createdAt: Date.now(),
        }
        writeShareEntries([...entries, entry])
        return Promise.resolve({
          message: `Shared-space request submitted (id ${entry.id}): ${relative(tenant.userRoot, target)} (${directoryOverview(target)}) -> shared/${entry.name} [${entry.mode}]. Once an administrator approves it, every member can read it and you keep write access; the shared space is created empty — copy the content into it afterwards.`,
        })
      },
    }))
    sctx.tools.register(defineTool({
      name: SHARE_APPROVE_TOOL,
      description: 'Review shared-space requests (administrators only). "list" shows pending requests and approved shared spaces; "approve" creates the shared space of a pending request (pass "name" to override the target directory name when a conflict is reported); "reject" declines a pending request; "reassign" moves an approved shared space to another owner ("name" plus "owner"); "revoke" removes an approved shared space ("name") so it is no longer accessible to members; "add-admin" grants another member administrator standing on an approved shared space ("name" plus "owner") so they keep write access even in read-only mode; "remove-admin" withdraws that standing.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'approve', 'reject', 'reassign', 'revoke', 'add-admin', 'remove-admin'] as const,
          description: 'Decision to take.',
        },
        requestId: { type: 'string', description: 'approve and reject: the pending request id.' },
        name: { type: 'string', description: 'approve: optional target name under shared/; reassign, revoke, add-admin, and remove-admin: the approved shared space name.' },
        owner: { type: 'string', description: 'reassign, add-admin, and remove-admin: the target member\'s tenant id (english name).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const tenant = currentTenant()
        if (tenant === undefined || tenant.role !== ADMIN_ROLE) {
          throw new Error('share_approve is restricted to administrators')
        }
        switch (args.action) {
          case 'list': {
            const entries = shareEntries()
            const pending = entries.filter(entry => entry.status === 'pending')
            const approved = entries.filter(entry => entry.status === 'approved')
            const pendingText = pending.length === 0
              ? 'No pending requests.'
              : `Pending requests:\n${pending.map(entry => `- ${entry.id}: ${entry.space} -> shared/${entry.name} [${entry.mode ?? 'read-write'}] (from ${entry.owner})`).join('\n')}`
            const approvedText = approved.length === 0
              ? 'No approved shared spaces yet.'
              : `Approved shared spaces:\n${approved.map(entry => `- shared/${entry.name} [${entry.mode ?? 'read-write'}] (owner ${entry.owner}${entry.admins?.length ? `, admins: ${entry.admins.join(', ')}` : ''})`).join('\n')}`
            return { message: `${pendingText}\n\n${approvedText}` }
          }
          case 'approve': {
            const requestId = args.requestId?.trim()
            if (requestId === undefined || requestId === '') throw new Error('approve requires "requestId"')
            const entry = shareEntries().find(candidate => candidate.status === 'pending' && candidate.id === requestId)
            if (entry === undefined) throw new Error(`no pending request with id "${requestId}"`)
            const name = (args.name ?? entry.name).trim()
            assertUsableShareName(name)
            const target = join(sharedDir(), name)
            if (existsSync(target)) {
              throw new Error(`shared/${name} already exists; approve again with a different "name"`)
            }
            mkdirSync(sharedDir(), { recursive: true })
            mkdirSync(target)
            try {
              await sctx.workspaceRegistry.create(target)
            } catch (error) {
              // The directory was created moments ago and holds nothing; remove it so a retry is not blocked by the leftover.
              try { rmdirSync(target) } catch { /* the approval retry reports the registry failure; a leftover only forces another name */ }
              throw error
            }
            updateEntry(requestId, (record) => {
              if (record.status !== 'pending') throw new Error(`request "${requestId}" is already ${record.status}`)
              record.status = 'approved'
              record.name = name
              record.decidedAt = Date.now()
              record.decidedBy = tenant.tenantId
            })
            return {
              message: `Approved: shared/${name} [${entry.mode ?? 'read-write'}] is registered and visible to every member; ${entry.owner} and administrators can write in it. The space is empty — the owner copies content into it from a session based there.`,
            }
          }
          case 'reject': {
            const requestId = args.requestId?.trim()
            if (requestId === undefined || requestId === '') throw new Error('reject requires "requestId"')
            updateEntry(requestId, (record) => {
              if (record.status !== 'pending') throw new Error(`request "${requestId}" is already ${record.status}`)
              record.status = 'rejected'
              record.decidedAt = Date.now()
              record.decidedBy = tenant.tenantId
            })
            return { message: `Rejected request ${requestId}.` }
          }
          case 'reassign': {
            const name = args.name?.trim()
            const owner = args.owner?.trim()
            if (name === undefined || name === '') throw new Error('reassign requires "name"')
            if (owner === undefined || owner === '') throw new Error('reassign requires "owner"')
            const entry = shareEntries().find(candidate => candidate.status === 'approved' && candidate.name === name)
            if (entry === undefined) throw new Error(`no approved shared space named "${name}"`)
            if (!existsSync(tenantUserRoot(owner))) {
              throw new Error(`no user directory for "${owner}"; check the english name`)
            }
            updateEntry(entry.id, (record) => {
              record.owner = owner
              record.decidedAt = Date.now()
              record.decidedBy = tenant.tenantId
            })
            return { message: `shared/${name} is now owned by ${owner}.` }
          }
          case 'revoke': {
            const name = args.name?.trim()
            if (name === undefined || name === '') throw new Error('revoke requires "name"')
            const entry = shareEntries().find(candidate => candidate.status === 'approved' && candidate.name === name)
            if (entry === undefined) throw new Error(`no approved shared space named "${name}"`)
            const target = join(sharedDir(), name)
            try {
              const ws = await sctx.workspaceRegistry.resolveByPath(target)
              if (ws !== undefined) {
                await sctx.workspaceRegistry.delete(ws.id)
              }
            } catch {
              // Registry failure does not block the revoke; we still remove the directory.
            }
            if (existsSync(target)) {
              rmSync(target, { recursive: true, force: true })
            }
            updateEntry(entry.id, (record) => {
              record.status = 'rejected'
              record.decidedAt = Date.now()
              record.decidedBy = tenant.tenantId
            })
            return { message: `Revoked: shared/${name} is removed and no longer accessible to members.` }
          }
          case 'add-admin': {
            const name = args.name?.trim()
            const owner = args.owner?.trim()
            if (name === undefined || name === '') throw new Error('add-admin requires "name"')
            if (owner === undefined || owner === '') throw new Error('add-admin requires "owner"')
            const entry = shareEntries().find(candidate => candidate.status === 'approved' && candidate.name === name)
            if (entry === undefined) throw new Error(`no approved shared space named "${name}"`)
            if (!existsSync(tenantUserRoot(owner))) {
              throw new Error(`no user directory for "${owner}"; check the english name`)
            }
            if (entry.owner === owner) {
              return { message: `${owner} owns shared/${name} and is always its administrator.` }
            }
            if (entry.admins?.includes(owner) === true) {
              return { message: `${owner} is already an administrator of shared/${name}.` }
            }
            updateEntry(entry.id, (record) => {
              record.admins = [...record.admins ?? [], owner]
              record.decidedAt = Date.now()
              record.decidedBy = tenant.tenantId
            })
            return { message: `${owner} is now an administrator of shared/${name} and keeps write access even in read-only mode.` }
          }
          case 'remove-admin': {
            const name = args.name?.trim()
            const owner = args.owner?.trim()
            if (name === undefined || name === '') throw new Error('remove-admin requires "name"')
            if (owner === undefined || owner === '') throw new Error('remove-admin requires "owner"')
            const entry = shareEntries().find(candidate => candidate.status === 'approved' && candidate.name === name)
            if (entry === undefined) throw new Error(`no approved shared space named "${name}"`)
            if (entry.admins?.includes(owner) !== true) {
              return {
                message: entry.owner === owner
                  ? `${owner} owns shared/${name} and is always its administrator; ownership is moved with reassign.`
                  : `${owner} is not an administrator of shared/${name}.`,
              }
            }
            updateEntry(entry.id, (record) => {
              const rest = (record.admins ?? []).filter(admin => admin !== owner)
              if (rest.length > 0) record.admins = rest
              else delete record.admins
              record.decidedAt = Date.now()
              record.decidedBy = tenant.tenantId
            })
            return { message: `${owner} is no longer an administrator of shared/${name}.` }
          }
          default:
            throw new Error(`unsupported action "${String(args.action)}"`)
        }
      },
    }))
  })
}
