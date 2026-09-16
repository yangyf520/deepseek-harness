/**
 * Shell git command gate on `tools/pre-execute` for bash/pwsh.
 * Denies `git init` and force-push; asks before push; blocks push to protected branches.
 *
 * @module @deepseek-ai/dsh-git-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'git-guard'

/** Needs the tool registry only to sit on its pre-execute waterfall. */
export const inject = ['tools']

/** Shell tool names whose `command` argument is classified. */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/**
 * Deployment knobs for which refs are protected and whether push asks for approval.
 */
export interface Config {
  /**
   * Branch names that may not be push destinations (default `prd`).
   * Matching is by ref token (`prd`, `origin/prd`, `HEAD:prd`).
   */
  protectedBranches?: string[]
  /**
   * When true (default), any `git push` that is not already denied requires
   * user approval through `tools/pre-execute` ask.
   */
  askPush?: boolean
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  protectedBranches: z.array(String).default(['prd']),
  askPush: z.boolean().default(true),
})

/** Closed classification for one shell command string. */
export type GitCommandPolicy =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string }

/**
 * Classify a shell command for git safety. Best-effort over free-form shell text;
 * obfuscated invocations may evade detection.
 *
 * @param command - raw bash/pwsh command string
 * @param protectedBranches - branch names that refuse push
 * @param askPush - whether a non-denied push should ask for approval
 * @returns allow, deny, or ask
 */
export function classifyGitShellCommand(
  command: string,
  protectedBranches: readonly string[] = ['prd'],
  askPush = true,
): GitCommandPolicy {
  const text = command.replace(/\r\n/g, '\n')
  if (!/\bgit\b/i.test(text)) return { kind: 'allow' }

  if (/\bgit\b(?:\s+-C\s+\S+|\s+-[^\s]+|\s+--[^\s=]+(?:=\S+)?)*\s+init\b/i.test(text)) {
    return {
      kind: 'deny',
      reason: 'git init is blocked: create the remote repository in GitLab (or paste an existing URL), then clone — do not initialize a new product repo from the agent',
    }
  }

  if (!/\bgit\b(?:\s+-C\s+\S+|\s+-[^\s]+|\s+--[^\s=]+(?:=\S+)?)*\s+push\b/i.test(text)) {
    return { kind: 'allow' }
  }

  if (
    /--force-with-lease\b/i.test(text)
    || /--force\b/i.test(text)
    || /(^|[\s])-f([\s]|$)/.test(text)
  ) {
    return {
      kind: 'deny',
      reason: 'git push --force is blocked on shared branches; open a merge request or ask a human to recover history',
    }
  }

  for (const branch of protectedBranches) {
    if (branch.length === 0) continue
    const escaped = escapeRegExp(branch)
    const refHit = new RegExp(
      String.raw`(?:^|[\s/:])(?:refs/heads/|origin/)?${escaped}(?:$|[\s:])`,
      'i',
    )
    if (refHit.test(text)) {
      return {
        kind: 'deny',
        reason: `git push to protected branch "${branch}" is blocked; develop on dev and promote only with explicit human confirmation`,
      }
    }
  }

  if (askPush) {
    return {
      kind: 'ask',
      reason: 'git push requires approval before updating a remote',
    }
  }
  return { kind: 'allow' }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function shellCommandOf(exec: ToolExecution): string | undefined {
  if (!SHELL_TOOLS.has(exec.name)) return undefined
  const command = exec.arguments['command']
  return typeof command === 'string' ? command : undefined
}

/**
 * Register the pre-execute git gate for bash and pwsh.
 *
 * @param ctx - cordis context with `tools`
 * @param config - protected branches and ask-on-push
 */
export function apply(ctx: Context, config: Config = {}): void {
  const protectedBranches = config.protectedBranches ?? ['prd']
  const askPush = config.askPush ?? true

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const command = shellCommandOf(exec)
    if (command === undefined) return next()
    const decision = classifyGitShellCommand(command, protectedBranches, askPush)
    if (decision.kind === 'allow') return next()
    if (decision.kind === 'deny') {
      return Promise.resolve({ kind: 'deny', reason: decision.reason })
    }
    return Promise.resolve({ kind: 'ask', reason: decision.reason })
  })
}
