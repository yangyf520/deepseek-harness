/** Browser entry for the Web client. */
import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
const SESSION_SELECTION_KEY = 'dsh.sessions.current'
const AUTH_SCOPED_SELECTION_VERSION_KEY = 'dsh.sessions.auth-scoped-selection'
const AUTH_SCOPED_SELECTION_VERSION = '1'
const AUTH_COMPLETED_PARAM = 'dsh-auth-completed'

/** Drop a selection that may belong to the identity active before this Web login. */
function resetCrossIdentitySelection(): void {
  if (desktop !== undefined) return
  const url = new URL(window.location.href)
  const loginCompleted = url.searchParams.has(AUTH_COMPLETED_PARAM)
  const migrated = localStorage.getItem(AUTH_SCOPED_SELECTION_VERSION_KEY) === AUTH_SCOPED_SELECTION_VERSION
  if (loginCompleted || !migrated) localStorage.removeItem(SESSION_SELECTION_KEY)
  localStorage.setItem(AUTH_SCOPED_SELECTION_VERSION_KEY, AUTH_SCOPED_SELECTION_VERSION)
  if (!loginCompleted) return
  url.searchParams.delete(AUTH_COMPLETED_PARAM)
  window.history.replaceState(window.history.state, '', url)
}

const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

try {
  resetCrossIdentitySelection()
  const el = document.getElementById('root')
  if (el === null) throw new Error('web app: missing #root')
  const entry = new AppWebEntry(el)
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
      const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
      transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => { resolve() }
        script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
        document.head.append(script)
      }))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  void entry.run(desktop === undefined ? undefined : reportFailure)
} catch (reason) {
  reportFailure(reason)
}
