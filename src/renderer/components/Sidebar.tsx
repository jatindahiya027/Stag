import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { Folder } from '../types'
import styles from './Sidebar.module.css'

// ── Folder rename/create inline input ────────────────────────────────────────
function InlineInput({ defaultValue = '', onConfirm, onCancel }:
  { defaultValue?: string; onConfirm: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(defaultValue)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])

  return (
    <input ref={ref} className={styles.inlineInput} value={val}
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && val.trim()) onConfirm(val.trim())
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => { if (val.trim()) onConfirm(val.trim()); else onCancel() }} />
  )
}

// ── Single folder row (recursive) ────────────────────────────────────────────
function FolderRow({ folder, depth, assetCount }: { folder: Folder; depth: number; assetCount: number }) {
  const { activeFolder, activeFolderType, setActiveFolder, folders, updateFolder, deleteFolder, addFolder } = useStore()
  const [expanded, setExpanded] = useState(depth === 0)
  const [renaming, setRenaming] = useState(false)
  const [addingChild, setAddingChild] = useState(false)
  const [ctxOpen, setCtxOpen] = useState(false)
  const ctxRef = useRef<HTMLDivElement>(null)

  const isActive = activeFolderType === 'folder' && activeFolder === folder.id
  const children = folders.filter(f => f.parentId === folder.id)
  const hasChildren = children.length > 0

  useEffect(() => {
    if (!ctxOpen) return
    const h = (e: MouseEvent) => { if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [ctxOpen])

  const handleDelete = () => {
    if (confirm(`Delete folder "${folder.name}"? Assets won't be deleted.`)) deleteFolder(folder.id)
    setCtxOpen(false)
  }

  return (
    <div>
      <div className={`${styles.folderRow} ${isActive ? styles.active : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => setActiveFolder(folder.id, 'folder')}
        onContextMenu={e => { e.preventDefault(); setCtxOpen(true) }}>

        <button className={styles.expandBtn}
          onClick={e => { e.stopPropagation(); setExpanded(!expanded) }}
          style={{ opacity: hasChildren ? 1 : 0, pointerEvents: hasChildren ? 'auto' : 'none' }}>
          <span style={{ transform: expanded ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
        </button>

        <span className={styles.folderIcon} style={{ color: folder.color }}>{folder.icon}</span>

        {renaming ? (
          <InlineInput defaultValue={folder.name}
            onConfirm={v => { updateFolder(folder.id, { name: v }); setRenaming(false) }}
            onCancel={() => setRenaming(false)} />
        ) : (
          <span className={styles.folderName}>{folder.name}</span>
        )}

        <span className={styles.folderCount}>{assetCount}</span>
      </div>

      {/* Context menu */}
      {ctxOpen && (
        <div className={styles.ctxMenu} ref={ctxRef} style={{ marginLeft: 10 + depth * 14 }}>
          <button className={styles.ctxItem} onClick={() => { setAddingChild(true); setExpanded(true); setCtxOpen(false) }}>
            + New subfolder
          </button>
          <button className={styles.ctxItem} onClick={() => { setRenaming(true); setCtxOpen(false) }}>
            Rename
          </button>
          <div className={styles.ctxDiv} />
          <button className={`${styles.ctxItem} ${styles.ctxDanger}`} onClick={handleDelete}>
            Delete folder
          </button>
        </div>
      )}

      {/* Children */}
      {expanded && (
        <div>
          {addingChild && (
            <div style={{ paddingLeft: 10 + (depth + 1) * 14 }} className={styles.newFolderRow}>
              <InlineInput
                onConfirm={v => { addFolder(v, folder.id, folder.color); setAddingChild(false) }}
                onCancel={() => setAddingChild(false)} />
            </div>
          )}
          {children.map(child => {
            const count = getFolderAssetCount(child.id, useStore.getState().folders, useStore.getState().assets)
            return <FolderRow key={child.id} folder={child} depth={depth + 1} assetCount={count} />
          })}
        </div>
      )}
    </div>
  )
}

function getFolderAssetCount(folderId: string, allFolders: Folder[], assets: any[]): number {
  const childIds = getAllChildFolderIds(folderId, allFolders)
  const all = [folderId, ...childIds]
  return assets.filter(a => !a.deleted && a.folders.some((f: string) => all.includes(f))).length
}

function getAllChildFolderIds(folderId: string, allFolders: Folder[]): string[] {
  const children = allFolders.filter(f => f.parentId === folderId)
  return children.flatMap(c => [c.id, ...getAllChildFolderIds(c.id, allFolders)])
}

// ── Tag row ───────────────────────────────────────────────────────────────────
function TagRow({ tag }: { tag: string }) {
  const { assets, searchQuery, setSearchQuery, setActiveFolder, deleteTag } = useStore()
  const count = assets.filter(a => !a.deleted && a.tags.includes(tag)).length
  const [hover, setHover] = useState(false)

  return (
    <div className={styles.tagRow} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => { setActiveFolder(null, 'all'); setSearchQuery(tag) }}>
      <span className={styles.tagDot} />
      <span className={styles.tagName}>{tag}</span>
      <span className={styles.tagCount}>{count}</span>
      {hover && (
        <button className={styles.tagDelete}
          onClick={e => { e.stopPropagation(); if (confirm(`Delete tag "${tag}"?`)) deleteTag(tag) }}>
          ×
        </button>
      )}
    </div>
  )
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────
export default function Sidebar() {
  const {
    assets, folders, tags, smartFolders,
    activeFolder, activeFolderType, setActiveFolder,
    addFolder,
    searchQuery, setSearchQuery,
    filterRating, setFilterRating, filterExts, toggleFilterExt, clearFilters,
  } = useStore()

  const [tagExpanded, setTagExpanded] = useState(true)
  const [folderExpanded, setFolderExpanded] = useState(true)
  const [smartExpanded, setSmartExpanded] = useState(false)
  const [filterExpanded, setFilterExpanded] = useState(false)
  const [addingRoot, setAddingRoot] = useState(false)
  const [filterText, setFilterText] = useState('')

  const totalCount    = assets.filter(a => !a.deleted).length
  const uncatCount    = assets.filter(a => !a.deleted && a.folders.length === 0).length
  const untaggedCount = assets.filter(a => !a.deleted && a.tags.length === 0).length
  const trashCount    = assets.filter(a => a.deleted).length
  const rootFolders   = folders.filter(f => f.parentId === null)
  const filteredTags  = tags.filter(t => !filterText || t.toLowerCase().includes(filterText.toLowerCase()))
  const hasFilters    = filterRating > 0 || filterExts.length > 0

  const EXT_GROUPS = [
    { label: 'Image', exts: ['jpg','png','gif','webp','svg','psd'] },
    { label: 'Video', exts: ['mp4','mov','webm','avi'] },
    { label: 'Audio', exts: ['mp3','wav','flac','aac'] },
    { label: 'Font',  exts: ['ttf','otf','woff'] },
    { label: '3D',    exts: ['glb','obj','fbx'] },
    { label: 'Doc',   exts: ['pdf'] },
  ]

  return (
    <div className={styles.sidebar}>
      {/* Library section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>Library</div>
        <NavItem label="All"           count={totalCount}    icon="⊞" active={activeFolderType === 'all'}            onClick={() => { setActiveFolder(null, 'all'); setSearchQuery('') }} />
        <NavItem label="Uncategorized" count={uncatCount}    icon="□" active={activeFolderType === 'uncategorized'}  onClick={() => setActiveFolder(null, 'uncategorized')} />
        <NavItem label="Untagged"      count={untaggedCount} icon="◯" active={activeFolderType === 'untagged'}       onClick={() => setActiveFolder(null, 'untagged')} />
        <NavItem label="Trash"         count={trashCount}    icon="🗑" active={activeFolderType === 'trash'}         onClick={() => setActiveFolder(null, 'trash')} />
      </div>

      {/* Smart folders */}
      <CollapseSection label="Smart Folders" expanded={smartExpanded} onToggle={() => setSmartExpanded(!smartExpanded)}>
        {smartFolders.map(sf => (
          <NavItem key={sf.id} label={sf.name} icon="◈"
            active={activeFolderType === 'smart' && activeFolder === sf.id}
            onClick={() => setActiveFolder(sf.id, 'smart')} />
        ))}
      </CollapseSection>

      {/* Folders */}
      <CollapseSection label="Folders" expanded={folderExpanded} onToggle={() => setFolderExpanded(!folderExpanded)}
        action={<button className={styles.sectionAction} onClick={() => setAddingRoot(true)} title="New folder">+</button>}>
        {addingRoot && (
          <div className={styles.newFolderRow}>
            <InlineInput
              onConfirm={v => { addFolder(v, null, '#4a9eff'); setAddingRoot(false) }}
              onCancel={() => setAddingRoot(false)} />
          </div>
        )}
        {rootFolders.map(f => {
          const count = getFolderAssetCount(f.id, folders, assets)
          return <FolderRow key={f.id} folder={f} depth={0} assetCount={count} />
        })}
      </CollapseSection>

      {/* Tags */}
      <CollapseSection label="Tags" expanded={tagExpanded} onToggle={() => setTagExpanded(!tagExpanded)}>
        {tags.length > 6 && (
          <div className={styles.tagFilter}>
            <input className={styles.tagFilterInput} placeholder="Filter tags…"
              value={filterText} onChange={e => setFilterText(e.target.value)} />
          </div>
        )}
        <div className={styles.tagList}>
          {filteredTags.map(tag => <TagRow key={tag} tag={tag} />)}
          {filteredTags.length === 0 && <div className={styles.emptyMsg}>No tags yet</div>}
        </div>
      </CollapseSection>

      {/* Filters — in sidebar as requested */}
      <CollapseSection
        label={`Filters${hasFilters ? ' ●' : ''}`}
        expanded={filterExpanded}
        onToggle={() => setFilterExpanded(!filterExpanded)}
        action={hasFilters ? <button className={styles.sectionAction} onClick={clearFilters} title="Clear">×</button> : undefined}>

        <div className={styles.filterSection}>
          <div className={styles.filterLabel}>Min Rating</div>
          <div className={styles.ratingRow}>
            {[0,1,2,3,4,5].map(r => (
              <button key={r} className={`${styles.ratingBtn} ${filterRating === r ? styles.filterActive : ''}`}
                onClick={() => setFilterRating(r)}>
                {r === 0 ? 'All' : '★'.repeat(r)}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.filterSection}>
          <div className={styles.filterLabel}>File Type</div>
          {EXT_GROUPS.map(g => (
            <div key={g.label} className={styles.extGroupRow}>
              <span className={styles.extGroupLabel}>{g.label}</span>
              <div className={styles.extChips}>
                {g.exts.map(ext => (
                  <button key={ext} className={`${styles.extChip} ${filterExts.includes(ext) ? styles.filterActive : ''}`}
                    onClick={() => toggleFilterExt(ext)}>
                    {ext}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CollapseSection>
    </div>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function NavItem({ label, count, icon, active, onClick }: {
  label: string; count?: number; icon?: string; active: boolean; onClick: () => void
}) {
  return (
    <div className={`${styles.navItem} ${active ? styles.navActive : ''}`} onClick={onClick}>
      {icon && <span className={styles.navIcon}>{icon}</span>}
      <span className={styles.navLabel}>{label}</span>
      {count !== undefined && <span className={styles.navCount}>{count}</span>}
    </div>
  )
}

function CollapseSection({ label, expanded, onToggle, action, children }: {
  label: string; expanded: boolean; onToggle: () => void
  action?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className={styles.collapseSection}>
      <div className={styles.collapseHeader} onClick={onToggle}>
        <span className={styles.collapseArrow} style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>▶</span>
        <span className={styles.collapseLabel}>{label}</span>
        {action && <span onClick={e => e.stopPropagation()}>{action}</span>}
      </div>
      {expanded && <div className={styles.collapseBody}>{children}</div>}
    </div>
  )
}
