// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

const boot = vi.hoisted(() => ({
  run: vi.fn(),
  applyIndexInjections: vi.fn(async () => {}),
}))
vi.mock('@deepseek-ai/dsh-client-web', () => ({
  AppWebEntry: class { run = boot.run },
  applyIndexInjections: boot.applyIndexInjections,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.resetModules()
  document.body.replaceChildren()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

it('forwards client initialization failures to native recovery', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const failed = vi.fn(async () => {})
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', { ready: async () => ({ injections: [], streamBaseUrl: 'http://127.0.0.1:3080' }), failed })
  vi.stubGlobal('__DSH_TRANSPORT__', undefined)
  await import('../src/main.ts')
  await gate.promise
  expect(boot.applyIndexInjections).toHaveBeenCalledWith([], expect.any(Function))
  const report = boot.run.mock.calls[0]![0] as (reason: unknown) => void
  report(new Error('client plugin activation failed'))
  expect(failed).toHaveBeenCalledWith('client plugin activation failed')
})

it('rejects the shared boot wait when the Desktop Host cannot start', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const gate = Promise.withResolvers<undefined>()
  const failure = new Error('Host failed')
  const rejected = expect(gate.promise).rejects.toBe(failure)
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  vi.stubGlobal('dshDesktopBoot', { ready: async () => { throw failure }, failed: vi.fn() })
  await import('../src/main.ts')
  await rejected
  expect(boot.applyIndexInjections).not.toHaveBeenCalled()
  expect(boot.run).toHaveBeenCalledWith(expect.any(Function))
})

it('leaves browser failure presentation with the Web boot kernel', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('dshDesktopBoot', undefined)
  await import('../src/main.ts')
  expect(boot.run).toHaveBeenCalledWith(undefined)
})

it('drops the legacy saved Session before the first authenticated Web boot', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'old' }))
  vi.stubGlobal('dshDesktopBoot', undefined)

  await import('../src/main.ts')

  expect(localStorage.getItem('dsh.sessions.current')).toBeNull()
  expect(localStorage.getItem('dsh.sessions.auth-scoped-selection')).toBe('1')
})

it('drops the saved Session after each Web login and consumes the callback marker', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  localStorage.setItem('dsh.sessions.auth-scoped-selection', '1')
  localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'previous-identity' }))
  window.history.replaceState(null, '', '/?token=launch&dsh-auth-completed=1')
  vi.stubGlobal('dshDesktopBoot', undefined)

  await import('../src/main.ts')

  expect(localStorage.getItem('dsh.sessions.current')).toBeNull()
  expect(window.location.search).toBe('?token=launch')
})

it.each(['root', 'readiness'])('reports missing %s before client plugin startup', async (missing) => {
  if (missing !== 'root') document.body.innerHTML = '<div id="root"></div>'
  const failed = vi.fn(async () => {})
  vi.stubGlobal('dshDesktopBoot', { ready: vi.fn(), failed })
  vi.stubGlobal('__DSH_BOOT_READY__', undefined)
  await import('../src/main.ts')
  expect(failed).toHaveBeenCalledWith(missing === 'root'
    ? 'web app: missing #root' : 'desktop web: boot readiness is missing')
  expect(boot.run).not.toHaveBeenCalled()
})
