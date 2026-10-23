/** Tenant visibility helpers for session-controller, reading auth-tenant globals. */

import type { AsyncLocalStorage } from 'node:async_hooks'

/** Minimal tenant shape consumed by visibility checks. */
interface TenantContext {
  userRoot: string
  sharedRoot: string
}

/** Shape of the permission functions registered by auth-tenant on globalThis. */
interface TenantPermissions {
  isSpaceVisible(spacePath: string, tenant?: TenantContext): boolean
}

/**
 * Assert that `cwd` is visible to the current tenant.
 * No-op in single-user mode (no tenant context or no permissions registered).
 * @param cwd - directory to validate.
 * @throws RemoteError 'session/cwd-forbidden' when the cwd is outside the tenant's visible scope.
 */
export function assertCwdVisible(cwd: string): void {
  const perms = (globalThis as Record<string, unknown>).__dshTenantPermissions as TenantPermissions | undefined
  if (perms === undefined) return
  const als = (globalThis as Record<string, unknown>).__dshTenantAls as AsyncLocalStorage<TenantContext> | undefined
  const tenant = als?.getStore()
  if (tenant === undefined) return
  if (!perms.isSpaceVisible(cwd, tenant)) {
    throw new Error(`session/cwd-forbidden: cwd "${cwd}" is outside your tenant scope`)
  }
}

/**
 * Check whether a session's cwd is visible to the current tenant.
 * Returns true in single-user mode (no tenant context or no permissions registered).
 * @param cwd - session's working directory.
 */
export function isSessionVisibleToTenant(cwd: string | undefined): boolean {
  if (cwd === undefined) return true
  const perms = (globalThis as Record<string, unknown>).__dshTenantPermissions as TenantPermissions | undefined
  if (perms === undefined) return true
  const als = (globalThis as Record<string, unknown>).__dshTenantAls as AsyncLocalStorage<TenantContext> | undefined
  const tenant = als?.getStore()
  if (tenant === undefined) return true
  return perms.isSpaceVisible(cwd, tenant)
}
