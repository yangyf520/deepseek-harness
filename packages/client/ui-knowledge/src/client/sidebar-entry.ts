/**
 * DOM sidebar entry for knowledge admin.
 *
 * The stock sidebar shell has no plugin row slot; same approach as task-board /
 * skill-explorer: inject a plain button between New Session and the workspace
 * region, and re-place it if React re-renders displace it.
 */
import css from '../components/board.module.css'

const ROW_ATTR = 'data-dsh-knowledge-entry'
const ROW_SELECTOR = `[${ROW_ATTR}]`
const FAMILY = [
  '[data-dsh-taskboard-entry]',
  '[data-dsh-skill-explorer-entry]',
  ROW_SELECTOR,
] as const

/** Document-page glyph (inline for plain DOM; matches browse/docs silhouette). */
const ENTRY_ICON = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2.5" y="1.5" width="11" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

export type MountKnowledgeSidebarEntryOptions = {
  label(): string
  tooltip(): string
  onToggle(): void
  refresh?: { subscribe(listener: () => void): () => void }
  active?: {
    subscribe(listener: () => void): () => void
    isOpen(): boolean
  }
}

/**
 * Mount the knowledge sidebar row; self-heals across sidebar React re-renders.
 * @param options - labels, toggle, and optional active/locale subscriptions.
 * @returns disposer that removes the row and observers.
 */
export function mountKnowledgeSidebarEntry(options: MountKnowledgeSidebarEntryOptions): () => void {
  if (typeof document !== 'undefined' && document.querySelector(ROW_SELECTOR) !== null) {
    return () => {}
  }

  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(ROW_ATTR, '')
  entry.setAttribute('data-dsh-plugin', 'knowledge')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.className = css.entry ?? ''
  const icon = document.createElement('span')
  icon.className = css.entryIcon ?? ''
  icon.innerHTML = ENTRY_ICON
  const label = document.createElement('span')
  label.className = css.entryLabel ?? ''
  entry.append(icon, label)

  const applyLabel = (): void => {
    entry.setAttribute('aria-label', options.label())
    entry.setAttribute('title', options.tooltip())
    label.textContent = options.label()
  }
  try {
    applyLabel()
  } catch {
    entry.setAttribute('aria-label', 'knowledge')
    label.textContent = 'knowledge'
  }
  entry.addEventListener('click', () => { options.onToggle() })

  let root: HTMLElement | undefined
  let placed = false
  let unsubscribeRefresh: (() => void) | undefined
  if (options.refresh !== undefined) {
    try {
      unsubscribeRefresh = options.refresh.subscribe(applyLabel)
    } catch {
      // Keep the initial label if locale subscription fails.
    }
  }

  const place = (host: HTMLElement): boolean => {
    const button = newSessionButton(host)
    if (button === undefined) return false
    if (entry.parentElement !== host) {
      const row = button.closest('[class*="logoRow"]')
      const base = (row !== null && row.parentElement === host) ? row : button
      const family = Array.from(host.children).filter(
        (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY.join(', ')),
      )
      const lastFamily = family.at(-1)
      const anchor = lastFamily !== undefined
        ? lastFamily.nextElementSibling
        : base.nextElementSibling
      host.insertBefore(entry, anchor)
    }
    return true
  }

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = place(root)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = place(root)
  })

  let unsubscribeActive: (() => void) | undefined
  const active = options.active
  if (active !== undefined) {
    try {
      const sync = (): void => {
        if (active.isOpen()) entry.dataset.active = 'true'
        else delete entry.dataset.active
      }
      unsubscribeActive = active.subscribe(sync)
      sync()
    } catch {
      // Active highlight is optional; placement must still proceed.
    }
  }

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeRefresh?.()
    unsubscribeActive?.()
    entry.remove()
  }
}
