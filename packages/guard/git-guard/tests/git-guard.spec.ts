/**
 * Unit coverage for @deepseek-ai/dsh-git-guard.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as gitGuard from '@deepseek-ai/dsh-git-guard'
import { classifyGitShellCommand } from '@deepseek-ai/dsh-git-guard'

describe('classifyGitShellCommand', () => {
  it('allows non-git commands', () => {
    expect(classifyGitShellCommand('pnpm test')).toEqual({ kind: 'allow' })
  })

  it('denies git init forms', () => {
    expect(classifyGitShellCommand('git init').kind).toBe('deny')
    expect(classifyGitShellCommand('git -C /tmp/proj init').kind).toBe('deny')
  })

  it('denies force push and protected prd', () => {
    expect(classifyGitShellCommand('git push --force origin dev').kind).toBe('deny')
    expect(classifyGitShellCommand('git push origin prd').kind).toBe('deny')
  })

  it('asks for ordinary push when askPush is true', () => {
    expect(classifyGitShellCommand('git push origin dev', ['prd'], true).kind).toBe('ask')
  })
})

describe('git-guard pre-execute', () => {
  it('denies bash git init before dispatch', async () => {
    const ctx = new Context()
    const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(gitGuard)
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
})
