/**
 * Search view assembled from kit atoms (Panel + Card list).
 */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { KnowledgeSearchResult } from '@deepseek-ai/dsh-knowledge'
import { Card, Empty, List, Panel, ToolButton } from './kit.tsx'
import { formatScore, type Translate } from './types.ts'
import css from './board.module.css'

export type SearchPanelProps = {
  t: Translate
  query: string
  busy: boolean
  searchResult: KnowledgeSearchResult | undefined
  onQueryChange: (value: string) => void
  onSearch: () => void
}

/**
 * Search page: Panel + query toolbar + hit cards.
 * @param props - translator, query state, results, and handlers.
 */
export function SearchPanel({
  t,
  query,
  busy,
  searchResult,
  onQueryChange,
  onSearch,
}: SearchPanelProps) {
  return (
    <Panel
      title={t('search.title')}
      toolbar={(
        <>
          <Input
            className={css.searchInput ?? ''}
            aria-label={t('search.query')}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onSearch() }}
          />
          <ToolButton variant="primary" disabled={busy} onClick={() => void onSearch()}>
            {t('search.submit')}
          </ToolButton>
        </>
      )}
    >
      <p className={css.hint}>{t('search.hint')}</p>
      {searchResult === undefined
        ? null
        : searchResult.hits.length === 0
          ? <Empty title={t('search.empty')} />
          : (
            <List layout="column">
              {searchResult.hits.map(hit => (
                <Card
                  key={hit.chunkId as string}
                  title={hit.source.uri}
                  meta={<span>{formatScore(hit.score)}</span>}
                  body={<pre className={css.hitText}>{hit.text}</pre>}
                />
              ))}
            </List>
          )}
    </Panel>
  )
}
