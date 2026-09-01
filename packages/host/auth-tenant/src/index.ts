/** auth-tenant: per-user session guards, workspace cwd pinning, tenant credentials/settings. */

import { mkdir } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AuthPrincipal } from '@deepseek-ai/dsh-host-auth-gate'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  patchApiAccess,
  patchApiServices,
  patchSandboxPolicyResolve,
  patchSubprocessSpawn,
  seedHeadersFromPersistence,
} from './guards-api.ts'
import { tenantWorkspaceDir } from './tenant-files.ts'

/** Tenant directory slug from login profile (`englishName`, else `userId`). */
export function tenantSlugFromUser(englishName: string | undefined, userId: string): string {
  const slug = (englishName ?? userId).trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '')
  return slug || userId
}

/**
 * Workspace picker title: the same lowercase english-name slug as {@link tenantSlugFromUser}
 * (Feishu `en_name` is often ALL CAPS; the picker shows the normalized form).
 */
export function tenantWorkspaceTitle(
  _user: { englishName?: string; displayName?: string },
  tenantId: string,
): string {
  return tenantId
}

export const name = 'auth-tenant'

/**
 * Mounting this plugin enables per-user isolation. No cordis Config — login
 * channels and other UI-owned values stay in settings / the frontend.
 */
export class AuthTenant extends Service {
  private readonly headersById = new Map<SessionId, SessionHeader>()
  private apiProxyPatched = false

  constructor(ctx: Context) {
    super(ctx, 'authTenant')

    ctx.inject(['sessionPersistence'], (sctx) => {
      sctx.effect(() => {
        let cancelled = false
        void seedHeadersFromPersistence(sctx, this).then(() => {
          if (cancelled) return
        })
        return () => { cancelled = true }
      })
    })

    ctx.inject(['apiProxy'], (sctx) => {
      this.patchApiProxy(sctx)
    })

    patchSandboxPolicyResolve(ctx)
    patchSubprocessSpawn(ctx)
    patchApiServices(ctx)

    ctx.inject(['sessions'], (sctx) => {
      sctx.on('session/created', (session) => {
        this.rememberHeader(session.header)
      })
    })
  }

  /** Resolve a login user to a tenant directory id. */
  resolve(user: { englishName?: string; userId: string }): string {
    return tenantSlugFromUser(user.englishName, user.userId)
  }

  bindAuthPrincipal(principal: AuthPrincipal): string {
    const tenantId = this.resolve(principal.user)
    principal.user.tenantId = tenantId
    void this.ensureTenantWorkspace(principal.user, tenantId)
    return tenantId
  }

  /**
   * Ensure the per-tenant workspace directory is registered (title = tenant slug).
   * @returns the registry workspace when available, else `undefined`.
   */
  async ensureTenantWorkspace(
    user: { englishName?: string; displayName?: string },
    tenantId: string,
  ): Promise<{ id: string; path: string; title: string } | undefined> {
    const path = tenantWorkspaceDir(tenantId)
    await mkdir(path, { recursive: true })
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const title = tenantWorkspaceTitle(user, tenantId)
    const workspace = await registry.create(path, title)
    if (workspace.title !== title) await workspace.setTitle(title)
    return { id: workspace.id, path: workspace.path, title: workspace.title }
  }

  rememberHeader(header: SessionHeader): void {
    this.headersById.set(header.id, header)
  }

  ownsAgentSession(tenantId: string, agentSessionId: SessionId): boolean {
    const sessions = this.ctx.get('sessions') as { get(id: SessionId): { header: SessionHeader } | undefined } | undefined
    const headerTenant = sessions?.get(agentSessionId)?.header.tenantId
      ?? this.headersById.get(agentSessionId)?.tenantId
    return headerTenant === tenantId
  }

  workspaceDir(tenantId: string): string {
    return tenantWorkspaceDir(tenantId)
  }

  /** Patch apiProxy RPC faces once (inject or an earlier `provide` in tests). */
  private patchApiProxy(sctx: Context): void {
    if (this.apiProxyPatched) return
    const proxy = sctx.get('apiProxy') as Parameters<typeof patchApiAccess>[0] | undefined
    if (proxy === undefined) return
    this.apiProxyPatched = true
    patchApiAccess(proxy, this)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    authTenant: AuthTenant
  }
}

export function apply(ctx: Context): void {
  void ctx.plugin(AuthTenant)
}
