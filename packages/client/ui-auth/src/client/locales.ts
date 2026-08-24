/** `auth` namespace dictionaries for the sidebar account chip. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  logout: '退出登录',
  logoutAria: '退出登录',
} satisfies Record<string, string>

/** The auth namespace key union. */
export type AuthKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  logout: 'Log out',
  logoutAria: 'Log out',
} satisfies Record<AuthKey, string>
