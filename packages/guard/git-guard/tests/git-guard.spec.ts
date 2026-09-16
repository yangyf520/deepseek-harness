/**
 * Unit coverage for @deepseek-ai/dsh-git-guard.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime, {
  defineContentToolFixture,
  type ToolExecution,
  type ToolExecutionToken,
} from '@deepseek-ai/dsh-tools'
import * as gitGuard from '@deepseek-ai/dsh-git-guard'
import { apply, classifyGitShellCommand } from '@deepseek-ai/dsh-git-guard'

const testSignal = new AbortController().signal

function bashExec(arguments_: Record<string, unknown>): ToolExecution {
  return {
    token: Symbol('tool') as ToolExecutionToken,
    callId: ToolCallId('pre'),
    name: 'bash',
    arguments: Object.freeze(arguments_),
    signal: testSignal,
    rootCallId: ToolCallId('pre'),
  }
}

async function bootTools(plugin: unknown = gitGuard, config?: gitGuard.Config): Promise<Context> {
  const ctx = new Context()
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (config === undefined) await ctx.plugin(plugin)
  else await ctx.plugin(plugin, config)
  return ctx
}

describe('classifyGitShellCommand', () => {
  it('allows non-git commands and non-push git', () => {
    expect(classifyGitShellCommand('pnpm test')).toEqual({ kind: 'allow' })
    expect(classifyGitShellCommand('git status')).toEqual({ kind: 'allow' })
    expect(classifyGitShellCommand('git -C /tmp log -1')).toEqual({ kind: 'allow' })
  })

  it('denies git init forms', () => {
    expect(classifyGitShellCommand('git init').kind).toBe('deny')
    expect(classifyGitShellCommand('git -C /tmp/proj init').kind).toBe('deny')
  })

  it('denies force push variants', () => {
    expect(classifyGitShellCommand('git push --force origin dev').kind).toBe('deny')
    expect(classifyGitShellCommand('git push --force-with-lease origin dev').kind).toBe('deny')
    expect(classifyGitShellCommand('git push -f origin dev').kind).toBe('deny')
  })

  it('denies protected branch refs and skips empty names', () => {
    expect(classifyGitShellCommand('git push origin prd').kind).toBe('deny')
    expect(classifyGitShellCommand('git push origin HEAD:prd').kind).toBe('deny')
    expect(classifyGitShellCommand('git push origin refs/heads/prd').kind).toBe('deny')
    expect(classifyGitShellCommand('git push origin main', ['', 'main']).kind).toBe('deny')
  })

  it('asks or allows ordinary push based on askPush', () => {
    expect(classifyGitShellCommand('git push origin dev', ['prd'], true).kind).toBe('ask')
    expect(classifyGitShellCommand('git push origin dev', ['prd'], false)).toEqual({ kind: 'allow' })
  })
})

describe('git-guard pre-execute', () => {
  it('denies bash git init before dispatch', async () => {
    const ctx = await bootTools()
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'shell',
      parameters: { command: { type: 'string', required: true } },
      async execute() {
        ran = true
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    const result = await ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'bash',
      arguments: { command: 'git init' },
      signal: new AbortController().signal,
    })
    expect(ran).toBe(false)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/git init is blocked/)
  })

  it('asks on ordinary push (degrades to deny without approval)', async () => {
    const ctx = await bootTools()
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'shell',
      parameters: { command: { type: 'string', required: true } },
      async execute() {
        ran = true
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    const result = await ctx.tools.execute({
      callId: ToolCallId('c2'),
      name: 'bash',
      arguments: { command: 'git push origin dev' },
      signal: new AbortController().signal,
    })
    expect(ran).toBe(false)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/git push requires approval/)
  })

  it('allows non-shell tools and non-push bash through', async () => {
    const ctx = new Context()
    const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, {})
    let echoRan = false
    let statusRan = false
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'not shell',
      parameters: { text: { type: 'string', required: true } },
      async execute(args) {
        echoRan = true
        return [{ type: 'text', text: String(args.text) }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'shell',
      parameters: { command: { type: 'string', required: true } },
      async execute() {
        statusRan = true
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    const echo = await ctx.tools.execute({
      callId: ToolCallId('c3'),
      name: 'echo',
      arguments: { text: 'hi' },
      signal: new AbortController().signal,
    })
    const status = await ctx.tools.execute({
      callId: ToolCallId('c4'),
      name: 'bash',
      arguments: { command: 'git status' },
      signal: new AbortController().signal,
    })
    expect(echo.isError).toBe(false)
    expect(echoRan).toBe(true)
    expect(status.isError).toBe(false)
    expect(statusRan).toBe(true)
  })

  it('ignores non-string bash command arguments', async () => {
    const ctx = new Context()
    apply(ctx, { askPush: false })
    let nextCalled = false
    const decision = await ctx.waterfall(
      ctx as never,
      'tools/pre-execute',
      bashExec({ command: 42 }),
      () => {
        nextCalled = true
        return Promise.resolve({ kind: 'allow' as const })
      },
    )
    expect(nextCalled).toBe(true)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('allows push when askPush is false', async () => {
    const ctx = await bootTools(gitGuard, { askPush: false, protectedBranches: ['prd'] })
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'pwsh',
      description: 'shell',
      parameters: { command: { type: 'string', required: true } },
      async execute() {
        ran = true
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    const result = await ctx.tools.execute({
      callId: ToolCallId('c6'),
      name: 'pwsh',
      arguments: { command: 'git push origin dev' },
      signal: new AbortController().signal,
    })
    expect(ran).toBe(true)
    expect(result.isError).toBe(false)
  })
})
