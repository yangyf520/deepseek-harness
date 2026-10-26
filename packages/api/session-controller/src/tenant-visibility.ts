/** Tenant visibility helpers for session-controller, reading the auth-tenant service. */

import type { Context } from '@deepseek-ai/cordis'
import { TenantGuard } from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Assert that `cwd` is visible to the current tenant.
 * No-op in single-user mode.
 * @param ctx - context that may carry the auth-tenant service.
 * @param cwd - directory to validate.
 * @throws RemoteError 'session/cwd-forbidden' when the cwd is outside the tenant's visible scope.
 */
export function assertCwdVisible(ctx: Context, cwd: string): void {
  if (new TenantGuard(ctx).visible(cwd)) return
  throw new RemoteError('session/cwd-forbidden', `cwd "${cwd}" is outside your tenant scope`, { cwd })
}

/**
 * Check whether a session's cwd is visible to the current tenant.
 * The decision lives in the service, so it matches the session-record filter.
 * @param ctx - context that may carry the auth-tenant service.
 * @param cwd - session's working directory.
 * @returns true in single-user mode and for a cwd inside the tenant's scope.
 */
export function isSessionVisibleToTenant(ctx: Context, cwd: string | undefined): boolean {
  return new TenantGuard(ctx).sessionVisible(cwd)
}

/**
 * The stable failure for a session outside the current tenant's scope.
 * @param sessionId - session that failed the visibility check.
 * @returns the Remote failure carrying the session identity.
 */
export function sessionNotVisible(sessionId: SessionId): RemoteError {
  return new RemoteError('session/not-visible', `session "${sessionId}" is outside your tenant scope`, { sessionId })
}
