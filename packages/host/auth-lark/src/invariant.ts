/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-auth-lark`.
 * @module @deepseek-ai/dsh-host-auth-lark/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-auth-lark'

/** Cordis companion plugin name. */
export const name = 'host-auth-lark-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: HTTP/upgrade registrations are owned by `ctx.webServer`
 * (checked there); workers are killed by the same `ctx.effect()` disposer that
 * removes those routes, and tests observe child exit.
 */
const install: InvariantInstaller = () => {}

/**
 * Register the Lark auth gateway invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
