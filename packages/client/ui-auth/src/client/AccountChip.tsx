/** Sidebar-foot account chip: gateway session profile plus logout. */

import { useEffect, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './AccountChip.module.css'

/** Profile fields returned by GET /auth/me. */
export interface AuthProfile {
  issuer: string
  subject: string
  name?: string
  enName?: string
  avatarUrl?: string
}

/** Slot props: sidebar foot geometry plus the auth locale seat. */
export type AccountChipProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'auth'>

/**
 * Load the gateway session and render avatar, name, and logout.
 * Renders nothing when `/auth/me` is missing or unauthenticated.
 * @param props - sidebar foot owner share and locale.
 * @returns the chip, or null.
 */
export function AccountChip({ wide, t }: AccountChipProps) {
  const [profile, setProfile] = useState<AuthProfile | null | undefined>(undefined)

  useEffect(() => {
    const ac = new AbortController()
    void fetch('/auth/me', { credentials: 'include', signal: ac.signal })
      .then(async (response) => {
        if (!response.ok) {
          setProfile(null)
          return
        }
        setProfile(await response.json() as AuthProfile)
      })
      .catch((error: unknown) => {
        if (ac.signal.aborted) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setProfile(null)
      })
    return () => { ac.abort() }
  }, [])

  if (profile === undefined || profile === null) return null
  const label = profile.name ?? profile.enName ?? profile.subject
  const initial = (label[0] ?? '?').toLocaleUpperCase()

  const avatar = profile.avatarUrl !== undefined && profile.avatarUrl.length > 0
    ? <img className={css.avatar} src={profile.avatarUrl} alt="" referrerPolicy="no-referrer" />
    : <span className={`${css.avatar} ${css.initial}`}>{initial}</span>

  const logout = (): void => {
    void fetch('/auth/logout', { credentials: 'include' }).finally(() => {
      window.location.assign('/')
    })
  }

  if (!wide) {
    return (
      <div className={`${css.chip} ${css.rail}`}>
        <Tooltip label={`${label} · ${t('logout')}`} side="right">
          <button type="button" className={css.railButton} aria-label={t('logoutAria')} onClick={logout}>
            {avatar}
          </button>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className={css.chip}>
      {avatar}
      <span className={css.name}>{label}</span>
      <button type="button" className={css.logout} onClick={logout}>{t('logout')}</button>
    </div>
  )
}
