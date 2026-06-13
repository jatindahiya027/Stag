import React, { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { Folder } from '../types'
import appIconUrl from '../../../public/icon.png'
import styles from './Sidebar.module.css'
import {
  LayoutGrid, Inbox, Tag, Trash2, Star, Folder as FolderIcon,
  FolderOpen, Tag as LabelIcon, ChevronRight, Plus,
  PanelLeftClose, Download, History, Shuffle,
} from 'lucide-react'

// ── Tree-line folder connector ────────────────────────────────────────────────
const TreeLineIcon = ({ isLast = false }: { isLast?: boolean }) => (
  <svg className={styles.treeLineIcon} width="10" height="28" viewBox="0 0 10 28" fill="none" aria-hidden="true">
    <line x1="3" y1="-4" x2="3" y2={isLast ? '14' : '32'} stroke="currentColor" strokeWidth="1.4" />
    {isLast && <line x1="3" y1="14" x2="9" y2="14" stroke="currentColor" strokeWidth="1.4" />}
  </svg>
)

// ── Chevron icon ──────────────────────────────────────────────────────────────
const Chevron = ({ open }: { open: boolean }) => (
  <ChevronRight
    size={8} strokeWidth={2}
    style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0, color: 'var(--text-muted)' }}
  />
)

// ── Folder rename/create inline input ────────────────────────────────────────
function InlineInput({ defaultValue = '', onConfirm, onCancel }:
  { defaultValue?: string; onConfirm: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(defaultValue)
  const ref = useRef<HTMLInputElement>(null)
  const blurGuard = useRef(true)

  useEffect(() => {
    const t = setTimeout(() => {
      ref.current?.focus()
      ref.current?.select()
      blurGuard.current = false
    }, 50)
    return () => clearTimeout(t)
  }, [])

  return (
    <input ref={ref} className={styles.inlineInput} value={val}
      onChange={e => setVal(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && val.trim()) onConfirm(val.trim())
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => {
        if (blurGuard.current) return
        if (val.trim()) onConfirm(val.trim()); else onCancel()
      }} />
  )
}

// ── Single folder row (recursive) ────────────────────────────────────────────
type SidebarCounts = {
  all: number
  uncategorized: number
  untagged: number
  trash: number
  folders: Record<string, number>
  tags: Record<string, number>
}

function FolderRow({ folder, depth, assetCount, folderCounts, isLast }: {
  folder: Folder
  depth: number
  assetCount: number
  folderCounts?: Record<string, number>
  isLast?: boolean
}) {
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
      <div className={`${styles.folderRow} ${depth > 0 ? styles.childFolderRow : ''} ${isActive ? styles.active : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => setActiveFolder(folder.id, 'folder')}
        onContextMenu={e => { e.preventDefault(); setCtxOpen(true) }}>

        {depth > 0 && <TreeLineIcon isLast={isLast} />}

        <button className={styles.expandBtn}
          onClick={e => { e.stopPropagation(); setExpanded(!expanded) }}
          style={{ opacity: hasChildren ? 1 : 0, pointerEvents: hasChildren ? 'auto' : 'none' }}>
          <Chevron open={expanded} />
        </button>

        <span className={styles.folderGlyph}>
          {depth === 0
            ? <FolderIcon size={13} strokeWidth={1.55} />
            : <FolderOpen size={13} strokeWidth={1.55} />}
        </span>

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
        <div className={styles.ctxMenu} ref={ctxRef} style={{ marginLeft: 8 + depth * 12 }}>
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
        <div className={depth === 0 ? styles.childrenWrap : ''}>
          {addingChild && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 12 }} className={styles.newFolderRow}>
              <InlineInput
                onConfirm={v => { addFolder(v, folder.id, folder.color); setAddingChild(false) }}
                onCancel={() => setAddingChild(false)} />
            </div>
          )}
          {children.map((child, idx) => {
            const state = useStore.getState()
            const count = folderCounts
              ? getFolderAssetCountFromCounts(child.id, state.folders, folderCounts)
              : getFolderAssetCount(child.id, state.folders, state.assets)
            return <FolderRow key={child.id} folder={child} depth={depth + 1} assetCount={count} folderCounts={folderCounts} isLast={idx === children.length - 1} />
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

function getFolderAssetCountFromCounts(folderId: string, allFolders: Folder[], counts: Record<string, number>): number {
  const childIds = getAllChildFolderIds(folderId, allFolders)
  return [folderId, ...childIds].reduce((sum, id) => sum + (counts[id] || 0), 0)
}

function getAllChildFolderIds(folderId: string, allFolders: Folder[]): string[] {
  const children = allFolders.filter(f => f.parentId === folderId)
  return children.flatMap(c => [c.id, ...getAllChildFolderIds(c.id, allFolders)])
}

// ── Tag row ───────────────────────────────────────────────────────────────────
function TagRow({ tag, count: dbCount }: { tag: string; count?: number }) {
  const { assets, setSearchQuery, setSearchFields, setActiveFolder, deleteTag } = useStore()
  const count = dbCount ?? assets.filter(a => !a.deleted && a.tags.includes(tag)).length
  const [hover, setHover] = useState(false)

  return (
    <div className={styles.tagRow} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => { setActiveFolder(null, 'all'); setSearchFields(['tag']); setSearchQuery(tag) }}>
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
    addFolder, setSidebarOpen,
    setSearchQuery,
    importFiles, isLoading,
    sensitiveTags, showSensitiveContent,
    recentAssetIds, assetQueryVersion,
  } = useStore()

  const [tagExpanded, setTagExpanded] = useState(true)
  const [folderExpanded, setFolderExpanded] = useState(true)
  const [smartExpanded, setSmartExpanded] = useState(true)
  const [addingRoot, setAddingRoot] = useState(false)
  const [filterText, setFilterText] = useState('')
  const [counts, setCounts] = useState<SidebarCounts | null>(null)
  const [recentVisibleCount, setRecentVisibleCount] = useState(0)

  const api = (window as any).electronAPI
  const handleImport = async () => {
    const paths: string[] = await api?.openFiles() || []
    if (!paths.length) return
    const fileObjs = await Promise.all(paths.map(async (p: string) => {
      const info = await api?.getFileInfo(p) || {}
      const name = p.replace(/\\/g, '/').split('/').pop() || p
      return { path: p, name, size: info.size || 0, lastModified: info.mtime || Date.now(), type: '' }
    }))
    await importFiles(fileObjs as any)
  }

  const totalCount    = assets.filter(a => !a.deleted).length
  const uncatCount    = assets.filter(a => !a.deleted && a.folders.length === 0).length
  const untaggedCount = assets.filter(a => !a.deleted && a.tags.length === 0).length
  const trashCount    = assets.filter(a => a.deleted).length
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await (window as any).electronAPI?.dbGetCounts?.({ sensitiveTags, showSensitiveContent })
        if (!cancelled && result) setCounts(result)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [assets.length, assetQueryVersion, folders.length, tags.length, sensitiveTags, showSensitiveContent])

  useEffect(() => {
    let cancelled = false
    if (!recentAssetIds.length) {
      setRecentVisibleCount(0)
      return () => { cancelled = true }
    }
    ;(async () => {
      try {
        const result = await api?.dbQueryAssets?.({
          activeFolderType: 'all',
          assetIds: recentAssetIds,
          sensitiveTags,
          showSensitiveContent,
          limit: 1,
          offset: 0,
        })
        if (!cancelled) setRecentVisibleCount(Number(result?.total) || 0)
      } catch {
        if (!cancelled) {
          const recentSet = new Set(recentAssetIds)
          const sensitiveSet = new Set(sensitiveTags.map(tag => tag.toLowerCase()))
          setRecentVisibleCount(assets.filter(asset => (
            !asset.deleted &&
            recentSet.has(asset.id) &&
            (showSensitiveContent || !asset.tags.some(tag => sensitiveSet.has(tag.toLowerCase())))
          )).length)
        }
      }
    })()
    return () => { cancelled = true }
  }, [api, assetQueryVersion, assets, recentAssetIds, sensitiveTags, showSensitiveContent])

  const sidebarTotalCount = counts?.all ?? totalCount
  const sidebarUncatCount = counts?.uncategorized ?? uncatCount
  const sidebarUntaggedCount = counts?.untagged ?? untaggedCount
  const sidebarTrashCount = counts?.trash ?? trashCount
  const rootFolders   = folders.filter(f => f.parentId === null)
  const filteredTags  = tags.filter(t => !filterText || t.toLowerCase().includes(filterText.toLowerCase()))

  return (
    <div className={styles.sidebar}>
      {/* Brand header with import and collapse */}
      <div className={styles.brandHeader}>
        <img className={styles.brandIcon} src={appIconUrl} alt="" />
        <span className={styles.brandName}>Stag</span>
        <div className={styles.brandActions}>
          <button className={styles.importBtn} onClick={handleImport} disabled={isLoading} data-tooltip="Import files" aria-label="Import files">
            <Download size={12} strokeWidth={2.2} />
          </button>
          <button className={styles.collapseBtn} onClick={() => setSidebarOpen(false)} data-tooltip="Collapse sidebar" data-tooltip-align="right" aria-label="Collapse sidebar">
            <PanelLeftClose size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className={styles.sidebarMain}>
        {/* Library section */}
        <div className={styles.sectionCard}>
          <div className={styles.section}>
            <div className={styles.sectionHeader}>Library</div>
            <NavItem label="All Assets"  count={sidebarTotalCount}    icon={<LayoutGrid size={13} strokeWidth={1.6} />}  active={activeFolderType === 'all'}           onClick={() => { setActiveFolder(null, 'all'); setSearchQuery('') }} />
            <NavItem label="Uncategorized" count={sidebarUncatCount} icon={<Inbox size={13} strokeWidth={1.6} />} active={activeFolderType === 'uncategorized'} onClick={() => setActiveFolder(null, 'uncategorized')} />
            <NavItem label="Untagged"    count={sidebarUntaggedCount} icon={<Tag size={13} strokeWidth={1.6} />}         active={activeFolderType === 'untagged'}      onClick={() => setActiveFolder(null, 'untagged')} />
            <NavItem label="Recently Used" count={recentVisibleCount} icon={<History size={13} strokeWidth={1.6} />} active={activeFolderType === 'recent'} onClick={() => setActiveFolder(null, 'recent')} />
            <NavItem label="Random" icon={<Shuffle size={13} strokeWidth={1.6} />} active={activeFolderType === 'random'} onClick={() => setActiveFolder(String(Date.now()), 'random')} />
            <NavItem label="Trash"       count={sidebarTrashCount}    icon={<Trash2 size={13} strokeWidth={1.6} />}      active={activeFolderType === 'trash'}         onClick={() => setActiveFolder(null, 'trash')} />
          </div>
        </div>

        <hr className={styles.divider} />

        {/* Smart folders */}
        <CollapseSection label="Smart" icon={<Star size={13} strokeWidth={1.6} />} expanded={smartExpanded} onToggle={() => setSmartExpanded(!smartExpanded)}>
          {smartFolders.map(sf => (
            <NavItem key={sf.id} label={sf.name} icon={<Star size={13} strokeWidth={1.6} />}
              active={activeFolderType === 'smart' && activeFolder === sf.id}
              onClick={() => setActiveFolder(sf.id, 'smart')} />
          ))}
        </CollapseSection>

        <hr className={styles.divider} />

        {/* Folders */}
        <CollapseSection label="Folders" icon={<FolderIcon size={13} strokeWidth={1.6} />} expanded={folderExpanded} onToggle={() => setFolderExpanded(!folderExpanded)}
          className={styles.foldersSection}
          bodyClassName={styles.foldersBody}
          action={<button className={styles.sectionAction} onClick={() => setAddingRoot(true)} data-tooltip="New folder" data-tooltip-align="right" aria-label="New folder"><Plus size={11} strokeWidth={2} /></button>}>
          {addingRoot && (
            <div className={styles.newFolderRow}>
              <InlineInput
                onConfirm={v => { addFolder(v, null, '#7c6ff0'); setAddingRoot(false) }}
                onCancel={() => setAddingRoot(false)} />
            </div>
          )}
          <div className={styles.folderList}>
            {rootFolders.map((f, idx) => {
              const count = counts?.folders
                ? getFolderAssetCountFromCounts(f.id, folders, counts.folders)
                : getFolderAssetCount(f.id, folders, assets)
              return <FolderRow key={f.id} folder={f} depth={0} assetCount={count} folderCounts={counts?.folders} isLast={idx === rootFolders.length - 1} />
            })}
          </div>
        </CollapseSection>
      </div>

      <div className={styles.sidebarBottom}>
        <hr className={styles.divider} />

        {/* Tags */}
        <CollapseSection label="Labels" icon={<LabelIcon size={13} strokeWidth={1.6} />} expanded={tagExpanded} onToggle={() => setTagExpanded(!tagExpanded)}
          className={styles.labelsSection}>
          {tags.length > 6 && (
            <div className={styles.tagFilter}>
              <input className={styles.tagFilterInput} placeholder="Filter tags…"
                value={filterText} onChange={e => setFilterText(e.target.value)} />
            </div>
          )}
          <div className={styles.tagList}>
            {filteredTags.map(tag => <TagRow key={tag} tag={tag} count={counts?.tags?.[tag]} />)}
            {filteredTags.length === 0 && <div className={styles.emptyMsg}>No tags yet</div>}
          </div>
        </CollapseSection>

        <div className={styles.bottomPad} />
      </div>
    </div>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function NavItem({ label, count, icon, active, onClick }: {
  label: string; count?: number; icon?: React.ReactNode; active: boolean; onClick: () => void
}) {
  return (
    <div className={`${styles.navItem} ${active ? styles.navActive : ''}`} onClick={onClick}>
      {icon && <span className={styles.navIcon}>{icon}</span>}
      <span className={styles.navLabel}>{label}</span>
      {count !== undefined && <span className={styles.navCount}>{count}</span>}
    </div>
  )
}

function CollapseSection({ label, icon, expanded, onToggle, action, children, className, bodyClassName }: {
  label: string; icon?: React.ReactNode; expanded: boolean; onToggle: () => void
  action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string
}) {
  return (
    <div className={`${styles.sectionCard}${className ? ' ' + className : ''}`}>
      <div className={styles.collapseSection}>
        <div className={styles.collapseHeader} onClick={onToggle}>
          <Chevron open={expanded} />
          {icon && <span className={styles.sectionIcon}>{icon}</span>}
          <span className={styles.collapseLabel}>{label}</span>
          {action && <span onClick={e => e.stopPropagation()}>{action}</span>}
        </div>
        {expanded && <div className={`${styles.collapseBody}${bodyClassName ? ' ' + bodyClassName : ''}`}>{children}</div>}
      </div>
    </div>
  )
}
