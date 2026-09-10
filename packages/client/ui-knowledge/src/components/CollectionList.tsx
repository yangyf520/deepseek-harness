/**
 * Collections view assembled from kit atoms (Panel + Card grid).
 */
import type { CollectionSummary } from '@deepseek-ai/dsh-knowledge'
import { Card, Empty, List, Panel, ToolButton } from './kit.tsx'
import type { Translate } from './types.ts'
import css from './board.module.css'

export type CollectionListProps = {
  t: Translate
  collections: readonly CollectionSummary[]
  onOpenDocuments: (collection: CollectionSummary) => void
  onOpenSearch: (collection: CollectionSummary) => void
  onDelete: (collection: CollectionSummary) => void
}

/**
 * Collection catalog: Panel + Card grid.
 * @param props - translator, collections, and card handlers.
 */
export function CollectionList({
  t,
  collections,
  onOpenDocuments,
  onOpenSearch,
  onDelete,
}: CollectionListProps) {
  return (
    <Panel title={t('collections.listTitle')} count={t('collections.count', { count: collections.length })}>
      {collections.length === 0
        ? <Empty title={t('collections.empty')} hint={t('collections.emptyHint')} />
        : (
          <List layout="grid">
            {collections.map(collection => (
              <Card
                key={collection.id as string}
                title={collection.title}
                onOpen={() => onOpenDocuments(collection)}
                meta={(
                  <>
                    <span>{t('collections.docCount', { count: collection.docCount ?? 0 })}</span>
                    <span className={css.cardMetaMuted}>{collection.id as string}</span>
                  </>
                )}
                actions={(
                  <>
                    <ToolButton onClick={() => onOpenDocuments(collection)}>{t('card.documents')}</ToolButton>
                    <ToolButton onClick={() => onOpenSearch(collection)}>{t('card.search')}</ToolButton>
                    <ToolButton variant="ghost" onClick={() => onDelete(collection)}>{t('card.delete')}</ToolButton>
                  </>
                )}
              />
            ))}
          </List>
        )}
    </Panel>
  )
}
