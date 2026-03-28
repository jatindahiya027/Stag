import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'
import styles from './Toolbar.module.css'

const EXT_OPTIONS = ['jpg','jpeg','png','gif','webp','svg','psd','ai','mp4','mov','mp3','wav','pdf','ttf','glb','obj']

function FilterPanel({ onClose }: { onClose: () => void }) {
  const { filterRating, setFilterRating, filterExts, toggleFilterExt, clearFilters } = useStore()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const hasFilters = filterRating > 0 || filterExts.length > 0

  return (
    <div className={styles.filterPanel} ref={ref}>
      <div className={styles.filterHeader}>
        <span>Filters</span>
        {hasFilters && <button className={styles.clearBtn} onClick={clearFilters}>Clear all</button>}
      </div>

      <div className={styles.filterSection}>
        <div className={styles.filterLabel}>Min Rating</div>
        <div className={styles.ratingRow}>
          {[0,1,2,3,4,5].map(r => (
            <button key={r}
              className={`${styles.ratingBtn} ${filterRating === r ? styles.active : ''}`}
              onClick={() => setFilterRating(r)}>
              {r === 0 ? 'All' : '★'.repeat(r)}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.filterSection}>
        <div className={styles.filterLabel}>File Type</div>
        <div className={styles.extGrid}>
          {EXT_OPTIONS.map(ext => (
            <button key={ext}
              className={`${styles.extBtn} ${filterExts.includes(ext) ? styles.active : ''}`}
              onClick={() => toggleFilterExt(ext)}>
              {ext}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function Toolbar({ folderName, count }: { folderName: string; count: number }) {
  const {
    thumbnailSize, setThumbnailSize,
    searchQuery, setSearchQuery,
    sortBy, setSortBy,
    sortDir, toggleSortDir,
    filterRating, filterExts,
    importFiles, isLoading, importProgress,
  } = useStore()
  const [showFilter, setShowFilter] = useState(false)
  const hasFilters = filterRating > 0 || filterExts.length > 0

  const handleImport = async () => {
    const paths: string[] = await (window as any).electronAPI?.openFiles() || []
    if (!paths.length) return
    const fileObjs = await Promise.all(paths.map(async (p: string) => {
      const info = await (window as any).electronAPI?.getFileInfo(p) || {}
      const name = p.replace(/\\/g, '/').split('/').pop() || p
      return { path: p, name, size: info.size || 0, lastModified: info.mtime || Date.now(), type: '' }
    }))
    await importFiles(fileObjs as any)
  }

  const pct = importProgress
    ? Math.round((importProgress.current / importProgress.total) * 100)
    : 0

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarMain}>
        <div className={styles.left}>
          <h2 className={styles.title}>{folderName}</h2>
          <span className={styles.count}>{count}</span>
        </div>

        <div className={styles.right}>
        <div className={styles.sizeSlider}>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" style={{ color: 'var(--text-muted)' }}>
            <rect x="0" y="3.5" width="4" height="4" rx="0.5"/>
            <rect x="6" y="1" width="5" height="9" rx="0.5" opacity="0.5"/>
          </svg>
          <input type="range" min="80" max="320" value={thumbnailSize}
            onChange={e => setThumbnailSize(Number(e.target.value))}
            className={styles.slider} />
        </div>

        <button className={styles.importBtn} onClick={handleImport} disabled={isLoading}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v7M3 6l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M1 10h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Import
        </button>

        <button className={styles.iconBtn} onClick={toggleSortDir} title="Toggle sort direction">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            {sortDir === 'desc'
              ? <path d="M2 3h9M2 6.5h6M2 10h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              : <path d="M2 10h9M2 6.5h6M2 3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>}
          </svg>
        </button>

        <select className={styles.sortSelect} value={sortBy}
          onChange={e => setSortBy(e.target.value as any)}>
          <option value="date">Date added</option>
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="rating">Rating</option>
        </select>

        <div className={styles.filterWrap}>
          <button className={`${styles.iconBtn} ${hasFilters ? styles.activeBtn : ''}`}
            onClick={() => setShowFilter(!showFilter)} title="Filters">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M1.5 3h10L8 7.5v4L5 10V7.5L1.5 3z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
                fill={hasFilters ? 'currentColor' : 'none'} fillOpacity="0.2"/>
            </svg>
            {hasFilters && <span className={styles.filterDot} />}
          </button>
          {showFilter && <FilterPanel onClose={() => setShowFilter(false)} />}
        </div>

        <div className={styles.searchBox}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={styles.searchIcon}>
            <circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          <input className={styles.searchInput} placeholder="Search name, tags…"
            value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          {searchQuery && <button className={styles.searchClear} onClick={() => setSearchQuery('')}>×</button>}
        </div>
      </div>
      </div>{/* end toolbarMain */}

      {/* Progress — own row below toolbar, never overlaps buttons */}
      {isLoading && importProgress && (
        <div className={styles.progressWrap}>
          <div className={styles.progressTrack}>
            <div className={styles.progressBar} style={{ width: `${pct}%` }} />
          </div>
          <span className={styles.progressText}>
            Importing {importProgress.current}/{importProgress.total} — {importProgress.currentName}
          </span>
        </div>
      )}
    </div>
  )
}
