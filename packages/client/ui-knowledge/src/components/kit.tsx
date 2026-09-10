/**
 * Domain-agnostic layout atoms for assembling knowledge (and similar) boards:
 * BoardHeader, ActionBar, Panel, Card, List, Item, Drawer, Empty, Tag, ToolButton.
 *
 * Density (--kb-*) lives on `.boardView` in board.module.css — change once there.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import css from './board.module.css'

export type BoardHeaderProps = {
  title: ReactNode
  titleId?: string
  leading?: ReactNode
  actions?: ReactNode
  className?: string
}

/** Top chrome for a board: leading, title, trailing ActionBar. */
export function BoardHeader({ title, titleId, leading, actions, className }: BoardHeaderProps) {
  return (
    <header className={clsx(css.boardHeader, className)}>
      {leading}
      <h2 id={titleId} className={css.boardTitle}>{title}</h2>
      {actions}
    </header>
  )
}

export type ActionBarProps = {
  children: ReactNode
  /** `end` = push to the right; `equal` = 3-column card footer strip. */
  align?: 'start' | 'end' | 'equal'
  className?: string
}

/** Shared action row — same gap/padding tokens as ToolButton / board chrome. */
export function ActionBar({ children, align = 'start', className }: ActionBarProps) {
  return (
    <div
      className={clsx(
        css.actionBar,
        align === 'end' && css.actionBarEnd,
        align === 'equal' && css.actionBarEqual,
        className,
      )}
    >
      {children}
    </div>
  )
}

export type PanelProps = {
  title: ReactNode
  count?: ReactNode
  leading?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
  className?: string
}

/** Bordered section with optional header chrome and trailing toolbar. */
export function Panel({ title, count, leading, toolbar, children, className }: PanelProps) {
  return (
    <section className={clsx(css.panel, className)}>
      <div className={css.panelHeader}>
        {leading}
        <h3 className={css.panelTitle}>{title}</h3>
        {count !== undefined && count !== null && <span className={css.panelCount}>{count}</span>}
        {toolbar !== undefined && <div className={css.panelToolbar}>{toolbar}</div>}
      </div>
      <div className={css.panelBody}>{children}</div>
    </section>
  )
}

export type CardProps = {
  title: ReactNode
  meta?: ReactNode
  body?: ReactNode
  actions?: ReactNode
  onOpen?: () => void
  className?: string
}

/** Compact card: main block, optional body, optional equal ActionBar. */
export function Card({ title, meta, body, actions, onOpen, className }: CardProps) {
  return (
    <article className={clsx(css.card, className)}>
      {onOpen !== undefined
        ? (
          <button type="button" className={css.cardMain} onClick={onOpen}>
            <div className={css.cardTitle}>{title}</div>
            {meta !== undefined && <div className={css.cardMetaRow}>{meta}</div>}
          </button>
        )
        : (
          <div className={css.cardMain}>
            <div className={css.cardTitle}>{title}</div>
            {meta !== undefined && <div className={css.cardMetaRow}>{meta}</div>}
          </div>
        )}
      {body !== undefined && <div className={css.cardBody}>{body}</div>}
      {actions !== undefined && <ActionBar align="equal">{actions}</ActionBar>}
    </article>
  )
}

export type ListProps = {
  children: ReactNode
  /** `stack` = item `<ul>`; `grid` / `column` = card containers (`<div>`). */
  layout?: 'stack' | 'grid' | 'column'
  className?: string
}

/** Stack (items), card-grid, or single-column card list. */
export function List({ children, layout = 'stack', className }: ListProps) {
  if (layout === 'grid') {
    return <div className={clsx(css.cardGrid, className)}>{children}</div>
  }
  if (layout === 'column') {
    return <div className={clsx(css.cardColumn, className)}>{children}</div>
  }
  return <ul className={clsx(css.list, className)}>{children}</ul>
}

export type ItemProps = {
  /** Left column, top slot (e.g. title). */
  leftTop?: ReactNode
  /** Left column, bottom slot (e.g. tags / meta). */
  leftBottom?: ReactNode
  /** Right column, top slot (e.g. primary action); right-aligned. */
  rightTop?: ReactNode
  /** Right column, bottom slot; right-aligned. */
  rightBottom?: ReactNode
  /** Row activate (e.g. open drawer); right-slot clicks should stopPropagation. */
  onActivate?: () => void
  className?: string
}

/**
 * List item with optional left/right × top/bottom slots.
 * Omit unused slots; empty columns collapse.
 */
export function Item({ leftTop, leftBottom, rightTop, rightBottom, onActivate, className }: ItemProps) {
  const hasLeft = leftTop !== undefined || leftBottom !== undefined
  const hasRight = rightTop !== undefined || rightBottom !== undefined
  return (
    <li
      className={clsx(css.item, onActivate !== undefined && css.itemClickable, className)}
      onClick={onActivate}
      onKeyDown={onActivate === undefined
        ? undefined
        : (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onActivate()
          }
        }}
      role={onActivate !== undefined ? 'button' : undefined}
      tabIndex={onActivate !== undefined ? 0 : undefined}
    >
      {hasLeft && (
        <div className={css.itemLeft}>
          {leftTop !== undefined && <div className={css.itemSlot}>{leftTop}</div>}
          {leftBottom !== undefined && <div className={clsx(css.itemSlot, css.itemMeta)}>{leftBottom}</div>}
        </div>
      )}
      {hasRight && (
        <div className={css.itemRight} onClick={(event) => { event.stopPropagation() }}>
          {rightTop !== undefined && <div className={css.itemSlot}>{rightTop}</div>}
          {rightBottom !== undefined && <div className={css.itemSlot}>{rightBottom}</div>}
        </div>
      )}
    </li>
  )
}

export type DrawerProps = {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  closeLabel?: string
}

/** Right-side drawer over the board view (portaled to the boardView root). */
export function Drawer({ open, title, onClose, children, closeLabel = 'Close' }: DrawerProps) {
  if (!open || typeof document === 'undefined') return null
  const host = document.querySelector<HTMLElement>('[data-dsh-knowledge-view]')
  const node = (
    <div className={css.drawerRoot} data-dsh-knowledge-drawer="">
      <button type="button" className={css.drawerBackdrop} aria-label={closeLabel} onClick={onClose} />
      <aside className={css.drawerPanel} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <header className={css.drawerHeader}>
          <h3 className={css.drawerTitle}>{title}</h3>
          <ToolButton variant="ghost" onClick={onClose}>{closeLabel}</ToolButton>
        </header>
        <div className={css.drawerBody}>{children}</div>
      </aside>
    </div>
  )
  return host !== null ? createPortal(node, host) : node
}

export type EmptyProps = {
  title: ReactNode
  hint?: ReactNode
  className?: string
}

/** Centered empty placeholder. */
export function Empty({ title, hint, className }: EmptyProps) {
  return (
    <div className={clsx(css.empty, className)}>
      <div className={css.emptyTitle}>{title}</div>
      {hint !== undefined && <div className={css.emptyHint}>{hint}</div>}
    </div>
  )
}

export type TagProps = {
  children: ReactNode
  className?: string
}

/** Compact pill tag for status / labels. */
export function Tag({ children, className }: TagProps) {
  return <span className={clsx(css.tag, className)}>{children}</span>
}

export type ToolButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'outline' | 'primary' | 'ghost'
}

/** Compact control; size comes from `--kb-control-*` on `.boardView`. */
export function ToolButton({ variant = 'outline', className, type = 'button', ...rest }: ToolButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        css.toolBtn,
        variant === 'primary' && css.toolBtnPrimary,
        variant === 'ghost' && css.toolBtnGhost,
        className,
      )}
      {...rest}
    />
  )
}
