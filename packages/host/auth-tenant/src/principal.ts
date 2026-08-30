/** Request-scoped authenticated principal for `/api` and agent credential resolution. */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthPrincipal } from '@deepseek-ai/dsh-host-auth-gate'

export const principalAls = new AsyncLocalStorage<AuthPrincipal | undefined>()

/** Read the principal for the current `/api` request, if any. */
export function currentPrincipal(): AuthPrincipal | undefined {
  return principalAls.getStore()
}

/** Run `fn` under `principal` for downstream guards and credential routing. */
export function runWithPrincipal<T>(principal: AuthPrincipal | undefined, fn: () => T): T {
  return principalAls.run(principal, fn)
}

/** Async variant of {@link runWithPrincipal} for tests and callers returning promises. */
export async function runWithPrincipalAsync<T>(
  principal: AuthPrincipal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return principalAls.run(principal, async () => fn())
}

/** Tenant id for the active `/api` request, if any. */
export function currentTenantId(): string | undefined {
  return currentPrincipal()?.user.tenantId
}

/** Tenant id from the `/api` principal or the active agent initiator session. */
export function activeTenantId(ctx: Context): string | undefined {
  const fromPrincipal = currentTenantId()
  if (fromPrincipal !== undefined) return fromPrincipal
  const agents = ctx.get('agents') as { requireInitiator(): { session: { header: { tenantId?: string } } } } | undefined
  if (agents === undefined) return undefined
  try {
    return agents.requireInitiator().session.header.tenantId
  } catch {
    return undefined
  }
}
