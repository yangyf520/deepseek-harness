/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-auth-gate`.
 *
 * The gateway owns no independent event relationship: channel settings are
 * schema-validated on registration and routes read the settings document only,
 * so every mutable value is validated before a route can observe it.
 *
 * @module @deepseek-ai/dsh-host-auth-gate/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-auth-gate'

/** Cordis companion plugin name. */
export const name = 'auth-gate-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: schema validation owns the only mutable relationship. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
