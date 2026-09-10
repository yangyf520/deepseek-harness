/**
 * Mount the knowledge board into the AppFrame center column.
 *
 * Same takeover pattern as task-board / ssh: append a trailing child React
 * never owns, toggle visibility with an <html> data attribute, and hide the
 * conversation subtree while open. Does not use shell.overlay (that layer is
 * full-frame and would cover the sidebar).
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Board } from './Board.tsx'
import type { AdminApi, Translate } from '../components/types.ts'
import css from '../components/board.module.css'

const COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const ACTIVE_ATTR = 'data-dsh-knowledge-active'
/** Evict sibling center-column panels when knowledge opens. */
const SIBLING_ACTIVE_ATTRS = ['data-dsh-taskboard-active', 'data-dsh-ssh-active'] as const
const SIDEBAR_ROW_SELECTOR =
  '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

export type MountKnowledgeBoardOptions = {
  api: AdminApi
  t: () => Translate
  isOpen: () => boolean
  close: () => void
  subscribe: (listener: () => void) => () => void
  locale?: { subscribe(listener: () => void): () => void }
}

/**
 * Mount the board into the center column and bind visibility to open state.
 * @param options - API, translator, and open-state wiring.
 * @returns disposer that unmounts and clears the active attribute.
 */
export function mountKnowledgeBoard(options: MountKnowledgeBoardOptions): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let unsubscribeLocale: (() => void) | undefined

  const render = (target: Root): void => {
    target.render(createElement(Board, {
      t: options.t(),
      api: options.api,
      onClose: options.close,
    }))
  }

  try {
    unsubscribeLocale = options.locale?.subscribe(() => {
      if (root !== undefined) render(root)
    })
  } catch {
    /* locale absent: next natural re-render is enough */
  }

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    const column = document.querySelector<HTMLElement>(COLUMN_SELECTOR)
    if (column === null) return
    container = document.createElement('div')
    container.dataset.dshKnowledgeView = ''
    container.dataset.dshPlugin = 'knowledge'
    container.className = css.boardView ?? ''
    column.appendChild(container)
    root = createRoot(container)
    render(root)
  }

  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (options.isOpen()) {
      for (const attr of SIBLING_ACTIVE_ATTRS) {
        document.documentElement.removeAttribute(attr)
      }
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'knowledge' }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }

  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== 'knowledge' && options.isOpen()) {
      options.close()
    }
  }

  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!options.isOpen()) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) options.close()
  }

  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = options.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    unsubscribeLocale?.()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
