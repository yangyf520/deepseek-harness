/**
 * Documents view assembled from kit atoms (Panel + Item list + chunk Drawer).
 */
import { useEffect, useRef, useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentChunkSummary, DocumentSummary, IngestProgress, StagingDocumentSummary } from '@deepseek-ai/dsh-knowledge'
import { Drawer, Empty, Item, List, Panel, Tag, ToolButton } from './kit.tsx'
import { basenameUri, errorMessage, type AdminApi, type Translate } from './types.ts'
import css from './board.module.css'

export type DocumentListProps = {
  t: Translate
  collectionId: string
  api: AdminApi
  documents: readonly DocumentSummary[]
  staging: readonly StagingDocumentSummary[]
  busy: boolean
  ingestUri?: string
  ingestProgress?: IngestProgress
  onUpload: (files: FileList | null) => void
  onIngest: (uri: string) => void
  onDelete: (uri: string) => void
  onReindex?: () => void
}

/** Format document updatedAt for the item trailing column. */
function formatDocTime(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Documents page: Panel + filter toolbar + Item list; click opens chunk drawer.
 * @param props - translator, collection, documents, and handlers.
 */
export function DocumentList({
  t,
  collectionId,
  api,
  documents,
  staging,
  busy,
  ingestUri,
  ingestProgress,
  onUpload,
  onIngest,
  onDelete,
  onReindex,
}: DocumentListProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const [drawerUri, setDrawerUri] = useState<string | undefined>()
  const [chunks, setChunks] = useState<readonly DocumentChunkSummary[] | undefined>()
  const [chunkError, setChunkError] = useState<string | undefined>()
  const [chunkBusy, setChunkBusy] = useState(false)
  const pendingSet = new Set(staging.map(row => row.uri))
  const needle = filter.trim().toLowerCase()
  const visibleDocs = needle === ''
    ? documents
    : documents.filter(doc => doc.uri.toLowerCase().includes(needle) || basenameUri(doc.uri).toLowerCase().includes(needle))
  const visibleStaging = needle === ''
    ? staging
    : staging.filter(row => row.uri.toLowerCase().includes(needle) || basenameUri(row.uri).toLowerCase().includes(needle))
  const total = visibleDocs.length + visibleStaging.length

  useEffect(() => {
    if (drawerUri === undefined) {
      setChunks(undefined)
      setChunkError(undefined)
      return
    }
    const uri = drawerUri
    const ac = new AbortController()
    setChunkBusy(true)
    setChunkError(undefined)
    setChunks(undefined)
    void api.listDocumentChunks(collectionId, uri, ac.signal)
      .then((list) => {
        if (!ac.signal.aborted) setChunks(list)
      })
      .catch((err) => {
        if (!ac.signal.aborted) setChunkError(errorMessage(err))
      })
      .finally(() => {
        if (!ac.signal.aborted) setChunkBusy(false)
      })
    return () => { ac.abort() }
  }, [api, collectionId, drawerUri])

  return (
    <Panel
      title={t('documents.listTitle')}
      count={t('collections.count', { count: total })}
      toolbar={(
        <>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void onUpload(e.target.files)
              if (fileRef.current) fileRef.current.value = ''
            }}
          />
          <Input
            type="search"
            placeholder={t('documents.filter')}
            value={filter}
            onChange={(event) => { setFilter(event.target.value) }}
            aria-label={t('documents.filter')}
          />
          {onReindex !== undefined && (
            <ToolButton disabled={busy} onClick={onReindex}>{t('documents.reindex')}</ToolButton>
          )}
          <ToolButton variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {t('documents.upload')}
          </ToolButton>
        </>
      )}
    >
      {total === 0
        ? <Empty title={t('documents.empty')} />
        : (
          <List>
            {visibleDocs.map((doc) => {
              const time = formatDocTime(doc.updatedAt)
              return (
                <Item
                  key={doc.uri}
                  onActivate={() => { setDrawerUri(doc.uri) }}
                  leftTop={<span className={css.itemTitle}>{basenameUri(doc.uri)}</span>}
                  leftBottom={(
                    <>
                      <Tag>{t('documents.statusIndexed')}</Tag>
                      <span>{t('documents.chunks')}: {doc.chunkCount}</span>
                    </>
                  )}
                  rightTop={time !== undefined
                    ? <span className={css.itemTime}>{time}</span>
                    : undefined}
                  rightBottom={(
                    <ToolButton disabled={busy} onClick={() => void onDelete(doc.uri)}>
                      {t('documents.delete')}
                    </ToolButton>
                  )}
                />
              )
            })}
            {visibleStaging.map((row) => {
              const time = formatDocTime(row.createdAt)
              const working = ingestUri === row.uri
              const progressLabel = working && ingestProgress?.message !== undefined && ingestProgress.message !== ''
                ? ingestProgress.message
                : working
                  ? t('documents.ingest.working')
                  : undefined
              return (
                <Item
                  key={row.uri}
                  leftTop={<span className={css.itemTitle}>{basenameUri(row.uri)}</span>}
                  leftBottom={(
                    <>
                      <Tag>{t('documents.statusPending')}</Tag>
                      {progressLabel !== undefined && (
                        <span className={css.itemTime}>{progressLabel}</span>
                      )}
                    </>
                  )}
                  rightTop={time !== undefined
                    ? <span className={css.itemTime}>{time}</span>
                    : undefined}
                  rightBottom={(
                    <>
                      <ToolButton disabled={busy} onClick={() => void onDelete(row.uri)}>
                        {t('documents.delete')}
                      </ToolButton>
                      <ToolButton
                        disabled={busy || !pendingSet.has(row.uri)}
                        onClick={() => void onIngest(row.uri)}
                      >
                        {working ? t('documents.ingest.working') : t('documents.ingest.run')}
                      </ToolButton>
                    </>
                  )}
                />
              )
            })}
          </List>
        )}

      <Drawer
        open={drawerUri !== undefined}
        title={drawerUri !== undefined ? basenameUri(drawerUri) : ''}
        onClose={() => { setDrawerUri(undefined) }}
        closeLabel={t('close')}
      >
        {chunkBusy
          ? <Empty title={t('documents.chunksLoading')} />
          : chunkError !== undefined
            ? <Empty title={chunkError} />
            : chunks === undefined || chunks.length === 0
              ? <Empty title={t('documents.chunksEmpty')} />
              : (
                <ul className={css.chunkList}>
                  {chunks.map(chunk => (
                    <li key={chunk.chunkId as string} className={css.chunkCard}>
                      <div className={css.chunkHead}>
                        <span className={css.chunkIndex}>#{chunk.chunkIndex}</span>
                        {chunk.role !== undefined && <Tag>{chunk.role}</Tag>}
                        {chunk.source.loc !== undefined && chunk.source.loc !== '' && (
                          <span>{chunk.source.loc}</span>
                        )}
                      </div>
                      <pre className={css.chunkText}>{chunk.text}</pre>
                    </li>
                  ))}
                </ul>
              )}
      </Drawer>
    </Panel>
  )
}
