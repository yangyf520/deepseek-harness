/** Shared frame for configured audit presentation modes. */
import type { ReactNode } from 'react'
import css from './ScenarioView.module.css'

/**
 * Present a specialized review mode with the same title and content spacing.
 * @param props - Localized title, optional compact summary, and mode-specific content.
 * @returns A theme-aware review frame.
 */
export function ScenarioView({ title, summary, children }: {
  title: string
  summary?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={css.root}>
      <header className={css.header}>
        <h1>{title}</h1>
        {summary !== undefined && <div className={css.summary}>{summary}</div>}
      </header>
      <div className={css.content}>{children}</div>
    </section>
  )
}

/** Present the same empty result in every review mode. */
export function ScenarioEmptyState({ children }: { children: ReactNode }) {
  return <div className={css.empty}>{children}</div>
}
