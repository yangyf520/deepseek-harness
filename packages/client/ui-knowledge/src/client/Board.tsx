/**
 * Knowledge board shell: locales, visibility store, page state, and slot faces.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  Button,
  IconChevronLeftOutline14,
  Input,
  Modal,
  RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CollectionSummary,
  DocumentSummary,
  IngestProgress,
  KnowledgeSearchResult,
  StagingDocumentSummary,
} from '@deepseek-ai/dsh-knowledge'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import { CollectionList } from '../components/CollectionList.tsx'
import { DocumentList } from '../components/DocumentList.tsx'
import { SearchPanel } from '../components/SearchPanel.tsx'
import { ToolButton, BoardHeader, ActionBar } from '../components/kit.tsx'
import { basenameUri, errorMessage, type AdminApi, type Translate } from '../components/types.ts'
import css from '../components/board.module.css'

/** Dictionary namespace owned by this plugin. */
export const NS = 'knowledge' as const

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'close': '关闭',
  'entry.label': '知识库',
  'entry.tooltip': '打开知识库管理',
  'board.title': '知识库',
  'board.close': '返回',
  'board.backList': '返回',
  'board.create': '新建知识库',
  'board.search': '搜索知识库',
  'card.documents': '文档',
  'card.search': '检索',
  'card.delete': '删除',
  'nav.documents': '文档',
  'nav.search': '检索',
  'collections.listTitle': '知识库列表',
  'collections.count': '共 {count} 个',
  'collections.empty': '暂无知识库',
  'collections.emptyHint': '创建一个知识库开始管理文档与检索。',
  'collections.create.id': '库 ID',
  'collections.create.title': '显示名称',
  'collections.create.submit': '创建',
  'collections.deleteConfirmTitle': '删除知识库？',
  'collections.deleteConfirmDesc': '将永久删除知识库「{title}」及其全部文档与索引，此操作不可撤销。',
  'collections.docCount': '{count} 篇文档',
  'confirm.acknowledge': '我了解此操作不可撤销',
  'cancel': '取消',
  'confirm': '确认',
  'documents.listTitle': '文档',
  'documents.empty': '该库暂无文档',
  'documents.chunks': '块数',
  'documents.statusIndexed': '已索引',
  'documents.statusPending': '待入库',
  'documents.delete': '删除',
  'documents.deleteConfirmTitle': '删除文档？',
  'documents.deleteConfirmDesc': '将永久删除文档「{name}」及其分片索引（或待入库文件），此操作不可撤销。',
  'documents.upload': '上传文件',
  'documents.filter': '按路径筛选',
  'documents.reindex': '全量重建索引',
  'documents.ingest.run': '确认入库',
  'documents.ingest.working': '入库中…',
  'documents.ingest.progress': '{message}',
  'documents.chunksLoading': '加载分块…',
  'documents.chunksEmpty': '暂无分块',
  'search.title': '检索',
  'search.query': '查询',
  'search.submit': '搜索',
  'search.empty': '无命中',
  'search.hint': '输入查询词检索已索引内容。',
  'error.generic': '操作失败',
} as const

export type KnowledgeKey = keyof typeof zh

export const en: Record<KnowledgeKey, string> = {
  'close': 'Close',
  'entry.label': 'Knowledge',
  'entry.tooltip': 'Open knowledge admin',
  'board.title': 'Knowledge',
  'board.close': 'Back',
  'board.backList': 'Back',
  'board.create': 'New library',
  'board.search': 'Search libraries',
  'card.documents': 'Documents',
  'card.search': 'Search',
  'card.delete': 'Delete',
  'nav.documents': 'Documents',
  'nav.search': 'Search',
  'collections.listTitle': 'Libraries',
  'collections.count': '{count} total',
  'collections.empty': 'No libraries yet',
  'collections.emptyHint': 'Create a library to manage documents and search.',
  'collections.create.id': 'Library ID',
  'collections.create.title': 'Display name',
  'collections.create.submit': 'Create',
  'collections.deleteConfirmTitle': 'Delete library?',
  'collections.deleteConfirmDesc': 'Permanently delete library “{title}” and all of its documents and indexes. This cannot be undone.',
  'collections.docCount': '{count} documents',
  'confirm.acknowledge': 'I understand this cannot be undone',
  'cancel': 'Cancel',
  'confirm': 'Confirm',
  'documents.listTitle': 'Documents',
  'documents.empty': 'No documents in this library',
  'documents.chunks': 'Chunks',
  'documents.statusIndexed': 'Indexed',
  'documents.statusPending': 'Pending',
  'documents.delete': 'Delete',
  'documents.deleteConfirmTitle': 'Delete document?',
  'documents.deleteConfirmDesc': 'Permanently delete document “{name}” and its chunks (or pending staging file). This cannot be undone.',
  'documents.upload': 'Upload files',
  'documents.filter': 'Filter by path',
  'documents.reindex': 'Full reindex',
  'documents.ingest.run': 'Ingest',
  'documents.ingest.working': 'Ingesting…',
  'documents.ingest.progress': '{message}',
  'documents.chunksLoading': 'Loading chunks…',
  'documents.chunksEmpty': 'No chunks',
  'search.title': 'Search',
  'search.query': 'Query',
  'search.submit': 'Search',
  'search.empty': 'No hits',
  'search.hint': 'Enter a query to search indexed content.',
  'error.generic': 'Operation failed',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Knowledge admin board copy. */
    knowledge: KnowledgeKey
  }
}

type BoardState = { open: boolean }
type BoardActions = {
  open: (draft: BoardState) => void
  close: (draft: BoardState) => void
  toggle: (draft: BoardState) => void
}

/**
 * Create the knowledge board visibility store handle.
 * @returns store handle shared by the sidebar entry and center-column mount.
 */
export function createKnowledgeBoardStore(): EngineStoreHandle<BoardState, BoardActions> {
  return defineStore({
    init: (): BoardState => ({ open: false }),
    actions: {
      open: (d) => { d.open = true },
      close: (d) => { d.open = false },
      toggle: (d) => { d.open = !d.open },
    },
  })
}

type Page = 'collections' | 'documents' | 'search'

type DeleteTarget =
  | { kind: 'collection'; collection: CollectionSummary }
  | { kind: 'document'; uri: string }

export type BoardProps = {
  t: Translate
  api: AdminApi
  onClose: () => void
}

/**
 * Knowledge admin board body.
 * @param props - translator, admin API, and close handler.
 */
export function Board({ t, api, onClose: _onClose }: BoardProps) {
  const [page, setPage] = useState<Page>('collections')
  const [collections, setCollections] = useState<readonly CollectionSummary[]>([])
  const [active, setActive] = useState<CollectionSummary | undefined>()
  const [documents, setDocuments] = useState<readonly DocumentSummary[]>([])
  const [staging, setStaging] = useState<readonly StagingDocumentSummary[]>([])
  const [error, setError] = useState<string | undefined>()
  const [ingestUri, setIngestUri] = useState<string | undefined>()
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | undefined>()
  const [createOpen, setCreateOpen] = useState(false)
  const [createId, setCreateId] = useState('')
  const [createTitle, setCreateTitle] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | undefined>()
  const [deleteAck, setDeleteAck] = useState(false)
  const [query, setQuery] = useState('')
  const [listFilter, setListFilter] = useState('')
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | undefined>()
  const [busy, setBusy] = useState(false)
  const titleId = useId()

  async function refreshCollections(): Promise<void> {
    setCollections(await api.listCollections())
  }

  async function refreshDocs(collectionId: string): Promise<void> {
    const [docs, pending] = await Promise.all([
      api.listDocuments(collectionId),
      api.listStaging(collectionId),
    ])
    setDocuments(docs)
    setStaging(pending)
  }

  useEffect(() => {
    void refreshCollections().catch(err => setError(errorMessage(err)))
  }, [api])

  async function openCollection(collection: CollectionSummary, next: Exclude<Page, 'collections'>): Promise<void> {
    setActive(collection)
    setPage(next)
    setError(undefined)
    setSearchResult(undefined)
    if (next === 'documents') {
      try {
        await refreshDocs(collection.id as string)
      } catch (err) {
        setError(errorMessage(err))
      }
    }
  }

  async function onCreate(): Promise<void> {
    const id = createId.trim()
    if (id === '') return
    setBusy(true)
    try {
      await api.createCollection(id, createTitle.trim() || undefined)
      setCreateOpen(false)
      setCreateId('')
      setCreateTitle('')
      await refreshCollections()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function onConfirmDelete(): Promise<void> {
    if (deleteTarget === undefined) return
    setBusy(true)
    try {
      if (deleteTarget.kind === 'collection') {
        await api.deleteCollection(deleteTarget.collection.id as string)
        setActive(undefined)
        setPage('collections')
        await refreshCollections()
      } else {
        if (active === undefined) return
        await api.deleteDocument(active.id as string, deleteTarget.uri)
        await refreshDocs(active.id as string)
      }
      setDeleteTarget(undefined)
      setDeleteAck(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function onUpload(files: FileList | null): Promise<void> {
    if (active === undefined || files === null || files.length === 0) return
    setBusy(true)
    try {
      for (const file of files) {
        await api.uploadStagingFile(active.id as string, file)
      }
      await refreshDocs(active.id as string)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function onIngest(uri: string): Promise<void> {
    if (active === undefined) return
    setBusy(true)
    setError(undefined)
    setIngestUri(uri)
    setIngestProgress({ phase: 'normalize', uri, done: 0, total: 1, message: '开始入库…' })
    const poll = window.setInterval(() => {
      void api.getIngestProgress()
        .then((progress) => { setIngestProgress(progress) })
        .catch(() => undefined)
    }, 400)
    try {
      const result = await api.ingest(active.id as string, uri)
      if (result.errors.length > 0) {
        setError(result.errors.map(entry => entry.message).join('；'))
      } else if (result.chunksWritten === 0 && result.skipped > 0) {
        setError(undefined)
      }
      await refreshDocs(active.id as string)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      window.clearInterval(poll)
      setIngestUri(undefined)
      setIngestProgress(undefined)
      setBusy(false)
    }
  }

  async function onSearch(): Promise<void> {
    const q = query.trim()
    if (q === '') return
    setBusy(true)
    try {
      setSearchResult(await api.search(q, active?.id as string | undefined))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const headerLeading = page === 'collections'
    ? null
    : (
      <ToolButton
        variant="ghost"
        className={css.backButton}
        aria-label={t('board.backList')}
        onClick={() => {
          setPage('collections')
          setActive(undefined)
          setSearchResult(undefined)
        }}
      >
        <IconChevronLeftOutline14 />
      </ToolButton>
    )

  const filteredCollections = listFilter.trim() === ''
    ? collections
    : collections.filter((collection) => {
      const needle = listFilter.trim().toLowerCase()
      return (collection.title).toLowerCase().includes(needle)
        || (collection.id as string).toLowerCase().includes(needle)
    })

  let body: ReactNode
  if (page === 'collections') {
    body = (
      <CollectionList
        t={t}
        collections={filteredCollections}
        onOpenDocuments={collection => void openCollection(collection, 'documents')}
        onOpenSearch={collection => void openCollection(collection, 'search')}
        onDelete={(collection) => {
          setDeleteAck(false)
          setDeleteTarget({ kind: 'collection', collection })
        }}
      />
    )
  } else if (page === 'documents' && active !== undefined) {
    body = (
      <DocumentList
        t={t}
        collectionId={active.id as string}
        api={api}
        documents={documents}
        staging={staging}
        busy={busy}
        ingestUri={ingestUri}
        ingestProgress={ingestProgress}
        onUpload={files => void onUpload(files)}
        onIngest={uri => void onIngest(uri)}
        onDelete={(uri) => {
          setDeleteAck(false)
          setDeleteTarget({ kind: 'document', uri })
        }}
      />
    )
  } else {
    body = (
      <SearchPanel
        t={t}
        query={query}
        busy={busy}
        searchResult={searchResult}
        onQueryChange={setQuery}
        onSearch={() => void onSearch()}
      />
    )
  }

  return (
    <section className={css.board} role="region" aria-labelledby={titleId} data-dsh-knowledge-board="">
      <BoardHeader
        titleId={titleId}
        leading={headerLeading}
        title={active !== undefined && page !== 'collections' ? `${active.title}` : t('board.title')}
        actions={page === 'collections'
          ? (
            <ActionBar align="end">
              <input
                className={css.search}
                type="search"
                placeholder={t('board.search')}
                value={listFilter}
                onChange={(event) => { setListFilter(event.target.value) }}
                aria-label={t('board.search')}
              />
              <ToolButton variant="primary" onClick={() => setCreateOpen(true)}>
                + {t('board.create')}
              </ToolButton>
            </ActionBar>
          )
          : undefined}
      />
      {error !== undefined && <div className={css.error} role="alert">{error}</div>}
      <div className={css.body}>{body}</div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t('board.create')}>
        <div className={css.form}>
          <label className={css.label}>
            {t('collections.create.id')}
            <Input value={createId} onChange={e => setCreateId(e.target.value)} />
          </label>
          <label className={css.label}>
            {t('collections.create.title')}
            <Input value={createTitle} onChange={e => setCreateTitle(e.target.value)} />
          </label>
          <div className={css.formActions}>
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>{t('cancel')}</Button>
            <Button type="button" disabled={busy || createId.trim() === ''} onClick={() => void onCreate()}>
              {t('collections.create.submit')}
            </Button>
          </div>
        </div>
      </Modal>

      <RiskConfirmation
        open={deleteTarget !== undefined}
        title={deleteTarget?.kind === 'document'
          ? t('documents.deleteConfirmTitle')
          : t('collections.deleteConfirmTitle')}
        description={deleteTarget === undefined
          ? ''
          : deleteTarget.kind === 'document'
            ? t('documents.deleteConfirmDesc', { name: basenameUri(deleteTarget.uri) })
            : t('collections.deleteConfirmDesc', { title: deleteTarget.collection.title })}
        acknowledgeLabel={t('confirm.acknowledge')}
        confirmLabel={t('confirm')}
        cancelLabel={t('cancel')}
        acknowledged={deleteAck}
        disabled={busy}
        onAcknowledgedChange={setDeleteAck}
        onCancel={() => {
          setDeleteTarget(undefined)
          setDeleteAck(false)
        }}
        onConfirm={() => void onConfirmDelete()}
      />
    </section>
  )
}
