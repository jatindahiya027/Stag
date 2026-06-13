import { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import { useStore } from '../store/useStore'
import AssetGrid from './AssetGrid'
import { Asset } from '../types'
import styles from './MainContent.module.css'

function matchSmart(asset: Asset, rules: any[], logic: 'ANY' | 'ALL'): boolean {
  const results = rules.map(r => {
    if (r.field === 'rating') {
      if (r.operator === 'gte') return asset.rating >= Number(r.value)
      if (r.operator === 'lte') return asset.rating <= Number(r.value)
    }
    if (r.field === 'tags') {
      if (r.operator === 'is' && r.value === '') return asset.tags.length === 0
      if (r.operator === 'contains') return asset.tags.some((t: string) => t.toLowerCase().includes(String(r.value).toLowerCase()))
    }
    if (r.field === 'name') return asset.name.toLowerCase().includes(String(r.value).toLowerCase())
    if (r.field === 'ext') return asset.ext === String(r.value)
    return false
  })
  return logic === 'ALL' ? results.every(Boolean) : results.some(Boolean)
}

function getAllChildIds(folderId: string, folders: any[]): string[] {
  return folders.filter((f: any) => f.parentId === folderId)
    .flatMap((c: any) => [c.id, ...getAllChildIds(c.id, folders)])
}

interface Props { dbReady: boolean }

const PAGE_SIZE = 1000
const MAX_RENDERER_PAGES = 12

function visibleAssetLog(message: string, data?: Record<string, any>) {
  console.log(message, data || '')
  ;(window as any).electronAPI?.log?.({
    level: 'info',
    module: 'assets-ui',
    event: 'page_timing',
    data,
    message,
    time: new Date().toISOString(),
  }).catch?.(() => {})
}

export default function MainContent({ dbReady }: Props) {
  const assets = useStore(s => s.assets)
  const assetQueryVersion = useStore(s => s.assetQueryVersion)
  const folders = useStore(s => s.folders)
  const smartFolders = useStore(s => s.smartFolders)
  const activeFolder = useStore(s => s.activeFolder)
  const activeFolderType = useStore(s => s.activeFolderType)
  const searchQuery = useStore(s => s.searchQuery)
  const searchFields = useStore(s => s.searchFields)
  const sortBy = useStore(s => s.sortBy)
  const sortDir = useStore(s => s.sortDir)
  const filterRating = useStore(s => s.filterRating)
  const filterExts = useStore(s => s.filterExts)
  const thumbnailSize = useStore(s => s.thumbnailSize)
  const viewMode = useStore(s => s.viewMode)
  const setFilteredAssetIds = useStore(s => s.setFilteredAssetIds)
  const setToolbarState = useStore(s => s.setToolbarState)
  const aiSearchMode = useStore(s => s.aiSearchMode)
  const aiSearchResultIds = useStore(s => s.aiSearchResultIds)
  const sensitiveTags = useStore(s => s.sensitiveTags)
  const showSensitiveContent = useStore(s => s.showSensitiveContent)
  const recentAssetIds = useStore(s => s.recentAssetIds)
  const setAssets = useStore(s => s.setAssets)
  const [serverTotal, setServerTotal] = useState<number | null>(null)
  const [isPageLoading, setIsPageLoading] = useState(false)
  const querySeq = useRef(0)
  const pageCacheRef = useRef(new Map<number, { assets: Asset[]; usedAt: number }>())
  const loadingOffsetsRef = useRef(new Set<number>())
  const activeQueryKeyRef = useRef('')
  const mutationPendingRef = useRef(false)
  const publishedOffsetsKeyRef = useRef('')

  const activeSmartFolder = useMemo(
    () => activeFolderType === 'smart' && activeFolder ? smartFolders.find(s => s.id === activeFolder) || null : null,
    [activeFolderType, activeFolder, smartFolders],
  )
  const folderIdsForQuery = useMemo(
    () => activeFolderType === 'folder' && activeFolder ? [activeFolder, ...getAllChildIds(activeFolder, folders)] : [],
    [activeFolderType, activeFolder, folders],
  )
  const dbQueryOptions = useMemo(() => ({
    activeFolderType: ['smart', 'recent', 'random'].includes(activeFolderType) ? 'all' : activeFolderType,
    folderIds: folderIdsForQuery,
    searchQuery: aiSearchMode ? '' : searchQuery,
    searchFields,
    filterRating,
    filterExts,
    sortBy,
    sortDir,
    sensitiveTags,
    showSensitiveContent,
    assetIds: aiSearchMode && aiSearchResultIds
      ? aiSearchResultIds
      : activeFolderType === 'recent'
        ? (recentAssetIds.length ? recentAssetIds : ['__no_recent_assets__'])
        : undefined,
    random: activeFolderType === 'random',
    randomSeed: activeFolderType === 'random' ? activeFolder : undefined,
    smartRules: activeSmartFolder?.rules,
    smartLogic: activeSmartFolder?.logic,
  }), [
    activeFolderType, folderIdsForQuery, searchQuery, searchFields, filterRating, filterExts,
    sortBy, sortDir, sensitiveTags, showSensitiveContent, aiSearchMode,
    aiSearchResultIds, activeSmartFolder, recentAssetIds, activeFolder,
  ])
  const dbQueryKey = useMemo(() => JSON.stringify(dbQueryOptions), [dbQueryOptions])

  const publishCachedPages = useCallback(() => {
    const entries = [...pageCacheRef.current.entries()].sort((a, b) => a[0] - b[0])
    const pageKey = entries.map(([offset, page]) => {
      const first = page.assets[0]?.id || ''
      const last = page.assets[page.assets.length - 1]?.id || ''
      return `${offset}:${page.assets.length}:${first}:${last}`
    }).join(',')
    if (pageKey === publishedOffsetsKeyRef.current) return
    publishedOffsetsKeyRef.current = pageKey
    const latestById = new Map(useStore.getState().assets.map(a => [a.id, a]))
    const merged = entries
      .flatMap(([, page]) => page.assets)
      .map(asset => latestById.get(asset.id) ?? asset)
    setAssets(merged)
  }, [setAssets])

  const loadPage = useCallback(async (offset: number, queryKey = dbQueryKey, options: { force?: boolean } = {}) => {
    if (!dbReady || activeFolderType === 'alltags') return
    const api = (window as any).electronAPI
    if (!api?.dbQueryAssets) return
    if (mutationPendingRef.current && !options.force) return
    const safeOffset = Math.max(0, Math.floor(offset / PAGE_SIZE) * PAGE_SIZE)
    const cached = activeQueryKeyRef.current === queryKey ? pageCacheRef.current.get(safeOffset) : null
    if (cached && !options.force) {
      cached.usedAt = Date.now()
      publishCachedPages()
      return
    }
    if (loadingOffsetsRef.current.has(safeOffset)) return
    loadingOffsetsRef.current.add(safeOffset)
    setIsPageLoading(true)
    const seq = querySeq.current
    const started = performance.now()
    try {
      const result = await api.dbQueryAssets({
        ...dbQueryOptions,
        limit: activeFolderType === 'random' ? 5000 : PAGE_SIZE,
        offset: safeOffset,
      })
      if (seq !== querySeq.current || activeQueryKeyRef.current !== queryKey || !result?.assets) return
      const elapsedMs = Math.round(performance.now() - started)
      visibleAssetLog(`[Assets] page ${safeOffset}-${safeOffset + result.assets.length} loaded in ${elapsedMs}ms (${result.assets.length}/${result.total ?? result.assets.length})`, {
        ms: elapsedMs,
        offset: safeOffset,
        count: result.assets.length,
        total: result.total ?? result.assets.length,
      })
      pageCacheRef.current.set(safeOffset, { assets: result.assets, usedAt: Date.now() })
      while (pageCacheRef.current.size > MAX_RENDERER_PAGES) {
        const oldest = [...pageCacheRef.current.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]?.[0]
        if (oldest === undefined || oldest === safeOffset) break
        pageCacheRef.current.delete(oldest)
      }
      setServerTotal(result.total ?? result.assets.length)
      publishCachedPages()
    } catch {
      setServerTotal(null)
    } finally {
      loadingOffsetsRef.current.delete(safeOffset)
      setIsPageLoading(loadingOffsetsRef.current.size > 0)
    }
  }, [dbReady, activeFolderType, dbQueryKey, dbQueryOptions, publishCachedPages])

  // Split into two memos: filter first, sort second.
  // This way a sort-only change doesn't re-filter, and a filter-only change
  // (e.g. toggling deleted flag) re-filters cheaply without re-sorting if IDs match.
  const { filteredUnsortedIds, folderName } = useMemo(() => {
    let folderName = 'All'
    let list: Asset[]

    if (activeFolderType === 'trash') {
      list = assets.filter(a => a.deleted); folderName = 'Trash'
    } else {
      list = assets.filter(a => !a.deleted)
      if (activeFolderType === 'folder' && activeFolder) {
        const allIds = new Set([activeFolder, ...getAllChildIds(activeFolder, folders)])
        list = list.filter(a => a.folders.some(f => allIds.has(f)))
        folderName = folders.find(f => f.id === activeFolder)?.name || 'Folder'
      } else if (activeFolderType === 'uncategorized') {
        list = list.filter(a => a.folders.length === 0); folderName = 'Uncategorized'
      } else if (activeFolderType === 'untagged') {
        list = list.filter(a => a.tags.length === 0); folderName = 'Untagged'
      } else if (activeFolderType === 'recent') {
        const recentSet = new Set(recentAssetIds)
        list = list.filter(a => recentSet.has(a.id)); folderName = 'Recently Used'
      } else if (activeFolderType === 'random') {
        folderName = 'Random'
      } else if (activeFolderType === 'smart' && activeFolder) {
        const sf = smartFolders.find(s => s.id === activeFolder)
        if (sf) { list = list.filter(a => matchSmart(a, sf.rules, sf.logic)); folderName = sf.name }
      }
    }

    if (aiSearchMode && aiSearchResultIds !== null) {
      const resultSet = new Set(aiSearchResultIds)
      list = list.filter(a => resultSet.has(a.id))
    } else if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      const extensionQuery = q.replace(/^\./, '')
      list = list.filter(a => searchFields.some(field => {
        if (field === 'description') return a.notes.toLowerCase().includes(q) || (a.aiDescription || '').toLowerCase().includes(q)
        if (field === 'extension') return a.ext.toLowerCase().includes(extensionQuery)
        if (field === 'tag') return a.tags.some(t => t.toLowerCase().includes(q))
        return a.name.toLowerCase().includes(q)
      }))
    }
    if (filterRating > 0)    list = list.filter(a => a.rating >= filterRating)
    if (filterExts.length > 0) { const extSet = new Set(filterExts); list = list.filter(a => extSet.has(a.ext)) }
    if (!showSensitiveContent && sensitiveTags.length > 0) {
      const sensitiveSet = new Set(sensitiveTags.map(t => t.toLowerCase()))
      list = list.filter(a => !a.tags.some(t => sensitiveSet.has(t.toLowerCase())))
    }

    return { filteredUnsortedIds: list.map(a => a.id), folderName }
  }, [assetQueryVersion, folders, smartFolders, activeFolder, activeFolderType,
      searchQuery, searchFields, filterRating, filterExts, aiSearchMode, aiSearchResultIds,
      sensitiveTags, showSensitiveContent, recentAssetIds])

  useEffect(() => {
    if (!dbReady || activeFolderType === 'alltags') return
    const seq = ++querySeq.current
    activeQueryKeyRef.current = dbQueryKey
    publishedOffsetsKeyRef.current = ''
    pageCacheRef.current.clear()
    loadingOffsetsRef.current.clear()
    const currentAssets = useStore.getState().assets
    const canReuseStartupPage =
      activeFolderType === 'all' &&
      !aiSearchMode &&
      !searchQuery.trim() &&
      filterRating === 0 &&
      filterExts.length === 0 &&
      currentAssets.length > 0
    if (canReuseStartupPage) {
      pageCacheRef.current.set(0, { assets: currentAssets.slice(0, PAGE_SIZE), usedAt: Date.now() })
      publishCachedPages()
    } else {
      if (currentAssets.length === 0) setAssets([])
    }
    setServerTotal(null)
    const timer = window.setTimeout(() => {
      if (seq === querySeq.current) loadPage(0, dbQueryKey, { force: canReuseStartupPage && currentAssets.length < PAGE_SIZE })
    }, searchQuery.trim() ? 180 : 40)
    return () => window.clearTimeout(timer)
  }, [dbReady, activeFolderType, dbQueryKey, searchQuery, filterRating, filterExts.length, aiSearchMode, loadPage, publishCachedPages, setAssets])

  useEffect(() => {
    if (!dbReady || activeFolderType === 'alltags') return
    let timer: number | null = null
    const onMutated = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      const phase = detail.phase || 'committed'
      pageCacheRef.current.clear()
      loadingOffsetsRef.current.clear()
      publishedOffsetsKeyRef.current = ''
      const seq = ++querySeq.current
      activeQueryKeyRef.current = dbQueryKey
      if (timer !== null) window.clearTimeout(timer)
      if (phase === 'optimistic') {
        mutationPendingRef.current = true
        setIsPageLoading(false)
        return
      }
      mutationPendingRef.current = false
      timer = window.setTimeout(() => {
        if (seq === querySeq.current) loadPage(0, dbQueryKey, { force: true })
      }, 0)
    }
    window.addEventListener('stag:assets-mutated', onMutated as EventListener)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      window.removeEventListener('stag:assets-mutated', onMutated as EventListener)
    }
  }, [dbReady, activeFolderType, dbQueryKey, loadPage])

  const handleLoadMore = useCallback((direction: 'next' | 'prev') => {
    const loadedOffsets = [...pageCacheRef.current.keys()]
    if (direction === 'prev') {
      const minOffset = loadedOffsets.length ? Math.min(...loadedOffsets) : 0
      if (minOffset <= 0) return
    }
    const base = direction === 'prev'
      ? Math.max(0, (loadedOffsets.length ? Math.min(...loadedOffsets) : 0) - PAGE_SIZE)
      : loadedOffsets.length
        ? Math.max(...loadedOffsets) + PAGE_SIZE
        : 0
    if (serverTotal !== null && base >= serverTotal) return
    loadPage(base)
  }, [loadPage, serverTotal])

  const assetById = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets])

  const sortedFilteredIds = useMemo(() => {
    const list = filteredUnsortedIds
      .map(id => assetById.get(id))
      .filter((asset): asset is Asset => !!asset)
    // When AI search results are active, preserve relevance rank order
    if (aiSearchMode && aiSearchResultIds !== null && aiSearchResultIds.length > 0) {
      const rankMap = new Map(aiSearchResultIds.map((id, i) => [id, i]))
      return list
        .sort((a, b) => (rankMap.get(a.id) ?? 999) - (rankMap.get(b.id) ?? 999))
        .map(a => a.id)
    }
    if (activeFolderType === 'recent') {
      const rankMap = new Map(recentAssetIds.map((id, index) => [id, index]))
      return list.sort((a, b) => (rankMap.get(a.id) ?? 999) - (rankMap.get(b.id) ?? 999)).map(a => a.id)
    }
    if (activeFolderType === 'random') return list.map(asset => asset.id)
    return list.sort((a, b) => {
      let va: any, vb: any
      if (sortBy === 'name')        { va = a.name.toLowerCase(); vb = b.name.toLowerCase() }
      else if (sortBy === 'size')   { va = a.size;               vb = b.size }
      else if (sortBy === 'rating') { va = a.rating;             vb = b.rating }
      else                          { va = a.importTime;         vb = b.importTime }
      return (sortDir === 'asc' ? 1 : -1) * (va < vb ? -1 : va > vb ? 1 : 0)
    }).map(a => a.id)
  }, [filteredUnsortedIds, assetQueryVersion, sortBy, sortDir, aiSearchMode, aiSearchResultIds, activeFolderType, recentAssetIds])

  const filteredAssets = useMemo(
    () => sortedFilteredIds.map(id => assetById.get(id)).filter((asset): asset is Asset => !!asset),
    [sortedFilteredIds, assetById],
  )

  // useEffect (not useMemo) so syncing filteredAssetIds happens after paint,
  // not synchronously during render — prevents a second blocking render cycle.
  useEffect(() => { setFilteredAssetIds(sortedFilteredIds) }, [sortedFilteredIds])
  useEffect(() => { setToolbarState(folderName, serverTotal ?? sortedFilteredIds.length) }, [folderName, sortedFilteredIds.length, serverTotal])

  const inTrash = activeFolderType === 'trash'

  return (
    <div className={styles.main}>

      {/* Grid — always rendered, skeleton when loading */}
      {!dbReady ? (
        <SkeletonGrid thumbnailSize={thumbnailSize} />
      ) : filteredAssets.length === 0 ? (
        <EmptyState inTrash={inTrash} searchQuery={searchQuery} />

      ) : (
        <AssetGrid
          assets={filteredAssets}
          thumbnailSize={thumbnailSize}
          viewMode={viewMode}
          onLoadMore={handleLoadMore}
          hasMore={activeFolderType !== 'random' && (serverTotal === null || filteredAssets.length < serverTotal)}
          loadingMore={isPageLoading}
        />
      )}
    </div>
  )
}

// ── Empty state — composed type-color mark ─────────────────────────────────────
const TYPE_COLORS = [
  'var(--type-audio)', 'var(--type-video)', 'var(--type-font)',
  'var(--type-doc)',   'var(--type-model)', 'var(--type-archive)',
]

function EmptyState({ inTrash, searchQuery }: { inTrash: boolean; searchQuery: string }) {
  const title = inTrash ? 'Trash is clear'
    : searchQuery    ? 'Nothing matches'
    :                  'Library is empty'
  const hint = inTrash ? 'Deleted assets appear here'
    : searchQuery    ? `No assets match "${searchQuery}"`
    :                  'Drag files here or click Import to get started'
  return (
    <div className={styles.empty}>
      {!searchQuery && (
        <div className={styles.emptyMark}>
          {TYPE_COLORS.map((c, i) => (
            <div key={i} className={styles.emptyDot} style={{ background: c }} />
          ))}
        </div>
      )}
      <div className={styles.emptyText}>
        <p className={styles.emptyTitle}>{title}</p>
        <p className={styles.emptyHint}>{hint}</p>
      </div>
    </div>
  )
}

// Skeleton cards to show while DB loads — gives feel that content exists
function SkeletonGrid({ thumbnailSize }: { thumbnailSize: number }) {
  // Generate fake cards with varying heights to mimic Pinterest layout
  const cards = [1.0, 1.4, 0.75, 1.2, 0.9, 1.6, 1.0, 0.8, 1.3, 1.1,
                 0.7, 1.5, 1.0, 1.2, 0.85, 1.4, 0.95, 1.1, 1.3, 0.75,
                 1.0, 1.6, 0.8, 1.2, 1.05]
  return (
    <div className={styles.skeletonGrid}>
      {cards.map((ratio, i) => (
        <div key={i} className={styles.skeletonCard}
          style={{
            width: thumbnailSize,
            height: Math.round(thumbnailSize * ratio),
            animationDelay: `${(i % 8) * 0.08}s`,
          }} />
      ))}
    </div>
  )
}
