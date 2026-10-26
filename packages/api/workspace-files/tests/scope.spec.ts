import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceFiles from '../src/index.ts'

const CAPS = {
  maxBytes: 1024,
  maxFileBytes: 1024,
  maxLines: 100,
  maxEntries: 100,
}

function header(id: SessionId, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    origin: 'subagent',
    ...cwd === undefined ? {} : { cwd },
  }
}

describe('Workspace Files Session scope lookup', () => {
  it('answers a Session outside the caller tenant scope as unknown', async () => {
    const id = SessionId('other-tenant')
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: resolve('ignored') } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)

    try {
      ctx.sessions.create(id, { meta: { cwd: resolve('other-workspace'), origin: 'subagent' } })
      ctx.provide('authTenant', {
        visible: () => false,
        sessionVisible: () => false,
        isSystemAdmin: () => false,
      })
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')
      await expect(lookup.resolve(id)).resolves.toBeUndefined()
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })

  it('uses live or stored headers without an Agent and leaves with its plugin', async () => {
    const liveId = SessionId('live-subagent')
    const coldId = SessionId('cold-subagent')
    const fallbackId = SessionId('cold-without-cwd')
    const missingId = SessionId('missing')
    const liveRoot = resolve('live-workspace')
    const coldRoot = resolve('cold-workspace')
    const fallbackRoot = resolve('fallback-workspace')
    const stat = vi.fn(async (id: SessionId) => {
      if (id === coldId) return { header: header(coldId, coldRoot) }
      if (id === fallbackId) return { header: header(fallbackId) }
      return undefined
    })
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: fallbackRoot } as never)
    ctx.provide('sessionPersistence', { stat } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)

    try {
      ctx.sessions.create(liveId, { meta: { cwd: liveRoot, origin: 'subagent' } })
      expect(ctx.get('agents')).toBeUndefined()
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      expect(lookup).toMatchObject({
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        // A method taking a scope reads the scope's Session as its access-control resource.
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      })
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')

      await expect(lookup.resolve(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveRoot })
      expect(stat).not.toHaveBeenCalled()
      await expect(lookup.resolve(coldId)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldRoot })
      await expect(lookup.resolve(fallbackId)).resolves.toEqual({ sessionId: fallbackId, workspaceRoot: fallbackRoot })
      await expect(lookup.resolve(missingId)).resolves.toBeUndefined()
      expect(stat.mock.calls.map(([id]) => id)).toEqual([coldId, fallbackId, missingId])

      await workspaceFiles.dispose()
      expect(ctx.typert.lookups.get('workspaceFileScope')).toBeUndefined()
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })

  it('answers a stored Session by its header inside a tenant request', async () => {
    const inside = resolve('tenant-workspace')
    const outside = resolve('other-workspace')
    const visibleId = SessionId('stored-visible')
    const hiddenId = SessionId('stored-hidden')
    const stat = vi.fn(async (id: SessionId) => id === visibleId
      ? { header: header(visibleId, inside) }
      : { header: header(hiddenId, outside) })
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: resolve('ignored') } as never)
    ctx.provide('sessionPersistence', { stat } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)

    try {
      ctx.provide('authTenant', {
        visible: () => true,
        sessionVisible: (cwd?: string) => cwd === inside,
        isSystemAdmin: () => false,
      })
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')
      await expect(lookup.resolve(visibleId)).resolves.toEqual({ sessionId: visibleId, workspaceRoot: inside })
      await expect(lookup.resolve(hiddenId)).resolves.toBeUndefined()
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })
})
