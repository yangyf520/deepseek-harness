/**
 * Browser half of the gateway account chip. Occupies `sidebar.footer.action`
 * (above Settings). Hidden when GET /auth/me is not a session.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AccountChip } from './AccountChip.tsx'
import { en, zh, type AuthKey } from './locales.ts'

export type { AccountChipProps, AuthProfile } from './AccountChip.tsx'
export type { AuthKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar account chip copy. */
    auth: AuthKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'auth'

/** Required services. */
export const inject = ['slots', 'locale']

/**
 * Register the account chip into the sidebar foot list.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-auth: dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'auth-account',
    order: -20,
    locale: NS,
  }, AccountChip))
}
