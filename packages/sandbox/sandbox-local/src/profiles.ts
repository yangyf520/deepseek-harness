/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { dirname, sep } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * The directories a denied tmpfs removed on the way to one grant, shallowest
 * first. bwrap cannot mount a grant whose parent does not exist, so every level
 * below the enclosing denial has to be recreated.
 * @param grant - the path about to be bound back.
 * @param denied - roots replaced by an empty tmpfs.
 * @returns directories to recreate, or nothing when the grant is not under a denial.
 */
function replacedDirs(grant: string, denied: readonly string[]): string[] {
  const enclosing = denied
    .filter(root => grant.startsWith(root + sep))
    .sort((a, b) => b.length - a.length)[0]
  if (enclosing === undefined) return []
  const dirs: string[] = []
  for (let dir = dirname(grant); dir.length > enclosing.length; dir = dirname(dir)) {
    dirs.unshift(dir)
  }
  return dirs
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  const denied = policy.readDeniedRoots ?? []
  if (denied.length > 0) {
    // An empty tmpfs over each denied root hides its contents; the grants are
    // then bound back, recreating every directory the tmpfs replaced.
    for (const root of denied) args.push('--tmpfs', root)
    const rebuilt = new Set<string>()
    for (const root of policy.readAllowedRoots ?? []) {
      for (const dir of replacedDirs(root, denied)) {
        if (rebuilt.has(dir)) continue
        rebuilt.add(dir)
        args.push('--dir', dir)
      }
      args.push('--ro-bind', root, root)
    }
  }
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy. Landlock grants
 * are additive only and cannot exclude a subpath of a granted root, so a
 * policy's read fence does not narrow these grants: read isolation under the
 * deployment home is a Seatbelt and bwrap property on this platform.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Read-fence forms for an SBPL profile. SBPL resolves by last match, so the
 * denial precedes the narrower grants that restore the caller's own roots.
 * @param policy - file-effect policy carrying the fence roots.
 * @returns the denial form followed by any grant form, or nothing when unfenced.
 */
function readFenceForms(policy: SandboxPolicy): string[] {
  const denied = policy.readDeniedRoots ?? []
  if (denied.length === 0) return []
  const forms = [`(deny file-read* ${denied.map(root => `(subpath ${sbplString(root)})`).join(' ')})`]
  const allowed = policy.readAllowedRoots ?? []
  if (allowed.length > 0) {
    forms.push(`(allow file-read* ${allowed.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return forms
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', ...readFenceForms(policy), `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
