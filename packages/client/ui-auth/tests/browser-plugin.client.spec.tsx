// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { AccountChip } from '../src/client/AccountChip.tsx'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  const disposeHoles = slots.register({
    name: 'root',
    children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  return { ctx, slots, disposeHoles }
}

describe('ui-auth browser plugin', () => {
  it('declares the slot and locale services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('occupies sidebar.footer.action once the hole is declared', async () => {
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(subject.slots.entries('sidebar.footer.action')).toHaveLength(1)
    await fiber.dispose()
    expect(subject.slots.entries('sidebar.footer.action')).toHaveLength(0)
    subject.disposeHoles()
  })

  it('renders name and logout after /auth/me succeeds, and nothing on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const href = String(input)
      if (href.endsWith('/auth/me')) {
        return new Response(JSON.stringify({
          issuer: 'lark',
          subject: 'yangyufeng',
          name: '杨雨锋',
          avatarUrl: 'https://example.test/a.png',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 204 })
    }))
    const labels = { logout: '退出登录', logoutAria: '退出登录' } as const
    const t = (key: 'logout' | 'logoutAria') => labels[key]
    // Global hooks ride the standard props share; AccountChip never reads them.
    const neverHook = (() => { throw new Error('AccountChip must not read global hooks') }) as never
    const chipProps = { wide: true as const, t: t as never, useSessions: neverHook, useWorkspaces: neverHook }
    const view = render(<AccountChip {...chipProps} />)
    expect(await screen.findByText('杨雨锋')).toBeTruthy()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy()
    view.unmount()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    render(<AccountChip {...chipProps} />)
    await waitFor(() => {
      expect(screen.queryByText('杨雨锋')).toBeNull()
    })
  })
})
