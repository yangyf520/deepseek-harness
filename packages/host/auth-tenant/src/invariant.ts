/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-auth-tenant`.
 *
 * The tenant service owns no independent event relationship: mounting enables
 * fixed per-user isolation, and bindings are process-local.
 *
 * @module @deepseek-ai/dsh-host-auth-tenant/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-auth-tenant'

/** Cordis companion plugin name. */
export const name = 'auth-tenant-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: mounting owns the only relationship. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
