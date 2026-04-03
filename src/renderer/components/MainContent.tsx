import { useMemo, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import Toolbar from './Toolbar'
import AssetGrid from './AssetGrid'
import { Asset } from '../types'
import { isImage } from '../utils/helpers'
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

export default function MainContent({ dbReady }: Props) {
  const {
    assets, folders, smartFolders,
    activeFolder, activeFolderType,
    searchQuery, sortBy, sortDir,
    filterRating, filterExts,
    thumbnailSize, viewMode,
    selectedAssetIds, deleteAssets, restoreAssets, permanentDelete, permanentDeleteWithPrompt,
    startAiQueue, aiSettings, ollamaSessionFailed,
    setFilteredAssetIds,
  } = useStore()

  // Split into two memos: filter first, sort second.
  // This way a sort-only change doesn't re-filter, and a filter-only change
  // (e.g. toggling deleted flag) re-filters cheaply without re-sorting if IDs match.
  const { filteredUnsorted, folderName } = useMemo(() => {
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
      } else if (activeFolderType === 'smart' && activeFolder) {
        const sf = smartFolders.find(s => s.id === activeFolder)
        if (sf) { list = list.filter(a => matchSmart(a, sf.rules, sf.logic)); folderName = sf.name }
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      list = list.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.ext.toLowerCase().includes(q) ||
        a.notes.toLowerCase().includes(q) ||
        (a.aiDescription || '').toLowerCase().includes(q) ||
        a.tags.some(t => t.toLowerCase().includes(q))
      )
    }
    if (filterRating > 0)    list = list.filter(a => a.rating >= filterRating)
    if (filterExts.length > 0) { const extSet = new Set(filterExts); list = list.filter(a => extSet.has(a.ext)) }

    return { filteredUnsorted: list, folderName }
  }, [assets, folders, smartFolders, activeFolder, activeFolderType,
      searchQuery, filterRating, filterExts])

  const filteredAssets = useMemo(() => {
    return [...filteredUnsorted].sort((a, b) => {
      let va: any, vb: any
      if (sortBy === 'name')        { va = a.name.toLowerCase(); vb = b.name.toLowerCase() }
      else if (sortBy === 'size')   { va = a.size;               vb = b.size }
      else if (sortBy === 'rating') { va = a.rating;             vb = b.rating }
      else                          { va = a.importTime;         vb = b.importTime }
      return (sortDir === 'asc' ? 1 : -1) * (va < vb ? -1 : va > vb ? 1 : 0)
    })
  }, [filteredUnsorted, sortBy, sortDir])

  // useEffect (not useMemo) so syncing filteredAssetIds happens after paint,
  // not synchronously during render — prevents a second blocking render cycle.
  useEffect(() => { setFilteredAssetIds(filteredAssets.map(a => a.id)) }, [filteredAssets])

  const inTrash = activeFolderType === 'trash'

  // Ctrl+F / Cmd+F → focus search input inside Toolbar
  const focusSearchRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        focusSearchRef.current?.()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className={styles.main}>
      <Toolbar
        onSearchReady={(fn) => { focusSearchRef.current = fn }}
        folderName={folderName}
        count={filteredAssets.length}
        selectedCount={selectedAssetIds.length}
        inTrash={inTrash}
        onDeselect={() => useStore.getState().clearSelection()}
        onDelete={() => deleteAssets(selectedAssetIds)}
        onRestore={() => restoreAssets(selectedAssetIds)}
        onPermanentDelete={() => { if (confirm('Permanently delete? This cannot be undone.')) permanentDeleteWithPrompt(selectedAssetIds) }}
        onReAiTag={() => {
          const imageAssets = selectedAssetIds
            .map(id => useStore.getState().assets.find(a => a.id === id))
            .filter((a): a is Asset => !!a && isImage(a.ext))
          if (!imageAssets.length) return
          if (!aiSettings.enabled) { useStore.getState().showToast('Enable AI tagging in Settings first', 'error'); return }
          if (ollamaSessionFailed) { useStore.getState().showToast('Ollama connection failed this session — restart app to retry', 'error'); return }
          startAiQueue(imageAssets)
          useStore.getState().showToast(`🤖 Re-tagging ${imageAssets.length} image${imageAssets.length > 1 ? 's' : ''}…`, 'info')
        }}
      />

      {/* Grid — always rendered, skeleton when loading */}
      {!dbReady ? (
        <SkeletonGrid thumbnailSize={thumbnailSize} />
      ) : filteredAssets.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>{inTrash ? '🗑' : '🗂'}</div>
          <p className={styles.emptyTitle}>
            {inTrash ? 'Trash is empty' : searchQuery ? 'No results found' : 'No assets yet'}
          </p>
          <p className={styles.emptyHint}>
            {inTrash ? 'Deleted assets appear here' :
             searchQuery ? `No match for "${searchQuery}"` :
             'Drag & drop files or click Import'}
          </p>
        </div>
      ) : (
        <AssetGrid assets={filteredAssets} thumbnailSize={thumbnailSize} viewMode={viewMode} />
      )}
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
