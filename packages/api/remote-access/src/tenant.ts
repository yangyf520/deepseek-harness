/**
 * Tenant visibility decisions over the `authTenant` service.
 *
 * Every method reads the service afresh, because the service resolves the
 * caller from the request's own context rather than from construction time.
 * Without that service every decision allows, so a single-user deployment
 * needs no guard. This class only decides: each Remote namespace reports a
 * refusal in its own error code, so nothing here throws.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * The subset of the `authTenant` service these decisions read. The host package
 * provides the full service; an API package cannot depend on it, so this class
 * names only the members it calls.
 */
interface TenantScope {
  /** Whether `path` lies inside the caller's visible roots. */
  visible(path: string): boolean
  /** Whether a session's cwd lies inside the caller's visible roots. */
  sessionVisible(cwd: string | undefined): boolean
  /** Whether the caller may change deployment-wide configuration. */
  isSystemAdmin(): boolean
}

/**
 * Tenant visibility decisions for one Host context.
 *
 * Each decision answers whether a path the request reaches lies inside the
 * caller's roots, so a Remote method names its subject in one of three forms: a
 * path it already resolved, a Session identity, or the deployment-wide role. A
 * new resource kind keeps sharing this class by resolving the path it reaches
 * and calling `visible`; only a kind whose reachability is not a path needs a
 * new method here.
 */
export class TenantGuard {
  /**
   * @param ctx - context that may carry the auth-tenant service.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Whether `path` lies inside the caller's visible roots.
   * @param path - absolute path the request names.
   * @returns true outside a tenant request and inside the caller's roots.
   */
  visible(path: string): boolean {
    return this.scope()?.visible(path) ?? true
  }

  /**
   * Whether a session's cwd lies inside the caller's visible roots.
   * A missing cwd fails inside a tenant request: without it the session's
   * owner cannot be confirmed.
   * @param cwd - the session's working directory.
   * @returns true outside a tenant request.
   */
  sessionVisible(cwd: string | undefined): boolean {
    return this.scope()?.sessionVisible(cwd) ?? true
  }

  /**
   * Whether the caller may see the Session with this identity. The Session's
   * logged cwd answers for it, so a caller that never activates the Session
   * still gets a decision; an unknown Session has no cwd and therefore fails
   * inside a tenant request.
   * @param sessionId - Session the request names.
   * @returns true outside a tenant request.
   */
  sessionVisibleById(sessionId: SessionId): boolean {
    return this.sessionVisible(this.ctx.sessions.get(sessionId)?.header.cwd)
  }

  /**
   * Whether the caller may change deployment-wide configuration.
   * @returns true outside a tenant request, where the operator is the only user.
   */
  isSystemAdmin(): boolean {
    return this.scope()?.isSystemAdmin() ?? true
  }

  private scope(): TenantScope | undefined {
    return this.ctx.reflect.get('authTenant') as TenantScope | undefined
  }
}
