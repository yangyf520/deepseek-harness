/** auth-gate client: settings login channels + sidebar account panel. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconChevronUpOutline14,
  IconUserOutline16,
  Tooltip,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import css from './ui.module.css'

const CHANNEL_NS = 'settings.authChannels'
const ACCOUNT_NS = 'account.auth'

const channelZh = {
  nav: '登录渠道',
  intro: '配置 OAuth 登录渠道。应用密钥经凭据库保存，页面不回显明文；保存后热生效。',
  unconfigured: '未配置', configured: '已配置', enabled: '已启用', disabled: '已停用',
  configure: '配置', edit: '编辑', save: '保存', cancel: '取消', disable: '停用', enable: '启用',
  testLogin: '测试登录', appId: '应用 ID', appSecret: '应用密钥',
  appSecretHint: '留空则保留已保存的密钥；首次配置必须填写',
  appSecretSet: '已配置', appSecretUnset: '未配置', redirectUri: '回调地址',
  redirectUriHint: '须与开放平台登记的回调 URL 一致', saving: '保存中…',
  saveFailed: '保存失败，请检查必填项', secretRequired: '请填写应用密钥',
  'label.feishu': '飞书', 'label.dingtalk': '钉钉', 'label.wecom': '企业微信', 'label.wechat-scan': '微信扫码',
} as const

const channelEn: Record<keyof typeof channelZh, string> = {
  nav: 'Login channels',
  intro: 'Configure OAuth login channels. App secrets are stored in the credentials store and never echoed back; saves apply live.',
  unconfigured: 'Not configured', configured: 'Configured', enabled: 'Enabled', disabled: 'Disabled',
  configure: 'Configure', edit: 'Edit', save: 'Save', cancel: 'Cancel', disable: 'Disable', enable: 'Enable',
  testLogin: 'Test login', appId: 'App ID', appSecret: 'App secret',
  appSecretHint: 'Leave blank to keep the stored secret; required on first setup',
  appSecretSet: 'Configured', appSecretUnset: 'Not set', redirectUri: 'Redirect URI',
  redirectUriHint: 'Must match the callback URL registered with the provider', saving: 'Saving…',
  saveFailed: 'Save failed; check required fields', secretRequired: 'Enter the app secret',
  'label.feishu': 'Feishu', 'label.dingtalk': 'DingTalk', 'label.wecom': 'WeCom', 'label.wechat-scan': 'WeChat scan',
}

const accountZh = {
  accountMenuAria: '当前账号', panelTitle: '账号', logout: '退出登录',
  'provider.feishu': '飞书', 'provider.dingtalk': '钉钉', 'provider.wecom': '企业微信', 'provider.wechat-scan': '微信扫码',
} as const

const accountEn: Record<keyof typeof accountZh, string> = {
  accountMenuAria: 'Current account', panelTitle: 'Account', logout: 'Log out',
  'provider.feishu': 'Feishu', 'provider.dingtalk': 'DingTalk', 'provider.wecom': 'WeCom', 'provider.wechat-scan': 'WeChat scan',
}

type AuthChannelsKey = keyof typeof channelZh
type AuthAccountKey = keyof typeof accountZh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.authChannels': AuthChannelsKey
    'account.auth': AuthAccountKey
  }
}

const BUILTIN = ['feishu', 'dingtalk', 'wecom', 'wechat-scan'] as const
type BuiltinChannelId = typeof BUILTIN[number]

export const inject = ['slots', 'locale', 'settingsScope', 'connection']

function secretRef(channelId: string): string {
  return `AUTH_${channelId.replaceAll('-', '_').toUpperCase()}_APP_SECRET`
}

function defaultRedirect(channelId: string): string {
  return `${window.location.origin}/auth/callback/${channelId}`
}

interface ChannelDraft {
  preset?: BuiltinChannelId
  enabled?: boolean
  appId?: string
  appSecretRef?: string
  redirectUri?: string
}

type ChannelProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.authChannels'>
  & InjectFace<{ scope: SettingsScope<Record<string, ChannelDraft>>; api: Pick<IApiClient, 'credentials'> }>

function ChannelSection({ scope, api, t }: ChannelProps): JSX.Element {
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())
  const [editing, setEditing] = useState<BuiltinChannelId | null>(null)
  const [draft, setDraft] = useState<ChannelDraft>({})
  const [secretDraft, setSecretDraft] = useState('')
  const [secretOk, setSecretOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const channels = snapshot.value ?? {}

  useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope])

  const openEdit = async (id: BuiltinChannelId): Promise<void> => {
    const row = channels[id]
    setError(null); setEditing(id); setSecretDraft('')
    setDraft({
      preset: id, enabled: row?.enabled !== false, appId: row?.appId ?? '',
      appSecretRef: secretRef(id), redirectUri: row?.redirectUri ?? defaultRedirect(id),
    })
    try {
      const res = await api.credentials.describe({ refs: [secretRef(id)] })
      setSecretOk(res.result.ok && res.result.value.credentials[secretRef(id)]?.configured === true)
    } catch { setSecretOk(false) }
  }

  const save = async (id: BuiltinChannelId): Promise<void> => {
    const appId = draft.appId?.trim() ?? ''
    const redirectUri = draft.redirectUri?.trim() ?? ''
    const secret = secretDraft.trim()
    if (!appId || !redirectUri) { setError(t('saveFailed')); return }
    if (!secret && !secretOk) { setError(t('secretRequired')); return }
    setBusy(true); setError(null)
    try {
      if (secret) {
        const stored = await api.credentials.set({ ref: secretRef(id), value: secret })
        if (!stored.result.ok) { setError(t('saveFailed')); return }
      }
      await scope.set(id, {
        preset: id, enabled: draft.enabled !== false, appId,
        appSecretRef: secretRef(id), redirectUri,
      })
      setEditing(null); setSecretDraft('')
    } catch { setError(t('saveFailed')) } finally { setBusy(false) }
  }

  const toggle = async (id: BuiltinChannelId, enabled: boolean): Promise<void> => {
    const row = channels[id]
    if (!row) return
    setBusy(true); setError(null)
    try {
      await scope.set(id, { ...row, preset: row.preset ?? id, appSecretRef: row.appSecretRef ?? secretRef(id), enabled })
    } catch { setError(t('saveFailed')) } finally { setBusy(false) }
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('intro')}</p>
      {error && <p className={css.error}>{error}</p>}
      {BUILTIN.map((id) => {
        const row = channels[id]
        const ok = row && row.appId && row.appSecretRef && row.redirectUri
        const on = ok && row.enabled !== false
        const edit = editing === id
        const label = `label.${id}` as AuthChannelsKey
        const status = !ok ? t('unconfigured') : on ? t('enabled') : t('disabled')
        const dot = !ok ? css.dotOff : on ? css.dotOn : css.dot
        return (
          <div key={id} className={edit ? `${css.card} ${css.cardEditing}` : css.card}>
            <div className={css.row}>
              <div className={css.identity}>
                <span className={`${css.dot} ${dot}`} aria-hidden />
                <h3 className={css.name}>{t(label)}</h3>
                <span className={css.tag}>{status}</span>
                {ok && row.appId && <span className={css.appId} title={row.appId}>{row.appId}</span>}
              </div>
              {!edit && (
                <div className={css.actions}>
                  <button type="button" className={css.btn} disabled={busy} onClick={() => { void openEdit(id) }}>
                    {ok ? t('edit') : t('configure')}
                  </button>
                  {ok && (
                    <button type="button" className={css.btn} disabled={busy} onClick={() => { void toggle(id, !on) }}>
                      {on ? t('disable') : t('enable')}
                    </button>
                  )}
                  {ok && on && (
                    <button type="button" className={css.btn}
                      onClick={() => { window.open(`/auth/login/${id}`, '_blank', 'noopener,noreferrer') }}>
                      {t('testLogin')}
                    </button>
                  )}
                </div>
              )}
            </div>
            {edit && (
              <div className={css.form}>
                <label className={css.field}>{t('appId')}
                  <input type="text" value={draft.appId ?? ''} onChange={e => setDraft({ ...draft, appId: e.target.value })} />
                </label>
                <div className={css.field}>
                  <div className={css.fieldHead}>
                    <span>{t('appSecret')}</span>
                    <span className={secretOk ? css.badge : css.badgeMuted}>{secretOk ? t('appSecretSet') : t('appSecretUnset')}</span>
                  </div>
                  <input type="password" autoComplete="off" value={secretDraft} onChange={e => setSecretDraft(e.target.value)} />
                  <span className={css.hint}>{t('appSecretHint')}</span>
                </div>
                <label className={css.field}>{t('redirectUri')}
                  <input type="text" value={draft.redirectUri ?? ''} onChange={e => setDraft({ ...draft, redirectUri: e.target.value })} />
                  <span className={css.hint}>{t('redirectUriHint')}</span>
                </label>
                <div className={css.actions}>
                  <button type="button" className={`${css.btn} ${css.btnPrimary}`} disabled={busy} onClick={() => { void save(id) }}>
                    {busy ? t('saving') : t('save')}
                  </button>
                  <button type="button" className={css.btn} disabled={busy}
                    onClick={() => { setEditing(null); setError(null); setSecretDraft('') }}>
                    {t('cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface AuthMe {
  provider?: string
  userId?: string
  displayName?: string
  englishName?: string
  avatarUrl?: string
}

type AccountProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'account.auth'>

function AccountFooter({ wide, t }: AccountProps): JSX.Element | null {
  const [user, setUser] = useState<AuthMe>()
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number }>()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let dead = false
    void fetch('/auth/me', { credentials: 'same-origin' }).then(async (res) => {
      if (!res.ok || dead) return
      setUser(await res.json() as AuthMe)
    }).catch(() => {})
    return () => { dead = true }
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = rootRef.current?.getBoundingClientRect()
      if (r) setAnchor({ left: r.left, bottom: window.innerHeight - r.top + 8 })
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open, wide])

  useDismissOnOutsidePointer(rootRef, open, setOpen)
  if (!user) return null

  const name = user.displayName?.trim() || user.englishName?.trim()
  const provKey = user.provider ? `provider.${user.provider}` as AuthAccountKey : undefined
  const prov = provKey && t(provKey) !== provKey ? t(provKey) : user.provider
  const aria = name ? `${t('accountMenuAria')}: ${name}` : t('accountMenuAria')

  const trigger = (
    <button type="button" className={css.acctTrigger} aria-label={aria} aria-haspopup="dialog"
      aria-expanded={open} data-active={open || undefined} onClick={() => { setOpen(v => !v) }}>
      {user.avatarUrl
        ? <img className={css.acctAvatar} src={user.avatarUrl} alt="" />
        : <IconUserOutline16 size={wide ? 16 : 18} />}
      {wide && <span className={css.acctName}>{name ?? t('panelTitle')}</span>}
      {wide && <IconChevronUpOutline14 className={css.acctChevron} size={14} />}
    </button>
  )

  return (
    <div ref={rootRef} className={wide ? css.acctLayer : `${css.acctLayer} ${css.acctRail}`}>
      {open && anchor && (
        <section className={css.acctPanel} style={{ left: anchor.left, bottom: anchor.bottom }}
          role="dialog" aria-label={t('panelTitle')}>
          <header className={css.acctHeader}>
            {user.avatarUrl
              ? <img className={css.acctHeaderAvatar} src={user.avatarUrl} alt="" />
              : <IconUserOutline16 size={36} />}
            <div className={css.acctHeaderText}>
              <div className={css.acctDisplayName}>{name ?? t('panelTitle')}</div>
              {prov && <span className={css.acctBadge}>{prov}</span>}
            </div>
          </header>
          <div className={css.acctFooter}>
            <button type="button" className={css.acctLogout} onClick={() => { window.location.assign('/auth/logout') }}>
              {t('logout')}
            </button>
          </div>
        </section>
      )}
      {wide ? trigger : <Tooltip label={name ?? t('panelTitle')} delayMs={500}>{trigger}</Tooltip>}
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(CHANNEL_NS, { zh: channelZh, en: channelEn }), 'auth-gate: channels')
  ctx.effect(() => ctx.locale.register(ACCOUNT_NS, { zh: accountZh, en: accountEn }), 'auth-gate: account')
  const t = ctx.locale.bind(CHANNEL_NS)
  const api = (ctx.get('connection') as ConnectionHandle).api
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'auth-account', order: 5, locale: ACCOUNT_NS,
  }, AccountFooter))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'auth-channels', order: 22, label: () => t('nav'), locale: CHANNEL_NS,
    inject: () => ({
      scope: ctx.settingsScope.bind<Record<string, ChannelDraft>>({ namespace: 'auth-channels' }),
      api,
    }),
  }, ChannelSection))
}
