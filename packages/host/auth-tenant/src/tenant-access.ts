/** Single policy source for per-tenant path containment under `$DSH_HOME/users/`. */

import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { assertTenantPath, isLexicallyUnder } from '@deepseek-ai/dsh-fs-sandbox'
import type { SandboxExecutionPolicy, TenantIsolation } from '@deepseek-ai/dsh-sandbox'
import { activeTenantId } from './principal.ts'
import { tenantRoot, usersRoot } from './tenant-files.ts'

/** Resolve tenant containment roots for the active principal, if any. */
export function tenantIsolationFor(ctx: Context): TenantIsolation | undefined {
  const tenantId = activeTenantId(ctx)
  if (tenantId === undefined) return undefined
  return { usersRoot: usersRoot(), tenantRoot: tenantRoot(tenantId) }
}

/** Tenant fence for one resolved filesystem target. */
export async function assertTenantFsTarget(ctx: Context, target: FsTarget): Promise<void> {
  const isolation = tenantIsolationFor(ctx)
  if (isolation === undefined) return
  await assertTenantPath(target.targetKey, target.displayPath, isolation)
}

/** Stamp {@link TenantIsolation} onto a resolved sandbox policy. */
export function withTenantIsolation(
  policy: SandboxExecutionPolicy,
  isolation: TenantIsolation | undefined,
): SandboxExecutionPolicy {
  if (isolation === undefined) return policy
  return { ...policy, tenantIsolation: isolation }
}

/**
 * Lexical tenant check for subprocess argv paths (spawn is synchronous).
 * Relative paths resolve against `cwd`.
 */
export function assertTenantArgvPaths(
  isolation: TenantIsolation,
  argv: readonly string[],
  cwd: string,
): void {
  for (const arg of argv) {
    if (arg.length === 0 || arg.startsWith('-')) continue
    if (!arg.includes('/') && !arg.includes('\\')) continue
    const resolved = isAbsolute(arg) ? resolvePath(arg) : resolvePath(cwd, arg)
    if (!isLexicallyUnder(resolved, isolation.usersRoot)) continue
    if (!isLexicallyUnder(resolved, isolation.tenantRoot)) {
      throw new Error(`subprocess path "${arg}" is outside the authenticated user's tenant directory`)
    }
  }
}
