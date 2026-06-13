import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { Asset } from '../types'
import { formatSize, formatDate, isImage, isVideo, isAudio, isFont, is3D } from '../utils/helpers'
import { shareAssets } from '../utils/share'
import styles from './Inspector.module.css'
import {
  PanelRightClose, FolderOpen, Download, Search,
  Music, Type, FileText, Palette, Video, Box, Folder,
  RotateCcw, X,
  Brain, Sparkles, Loader2, Share2, Copy, Globe2, ImagePlus,
} from 'lucide-react'

function StarRating({ rating, onChange }: { rating: number; onChange: (r: number) => void }) {
  const [hov, setHov] = useState(0)
  const [popped, setPopped] = useState(0)
  const [fullGlow, setFullGlow] = useState(false)
  const handleClick = (s: number) => {
    const next = s === rating ? 0 : s
    onChange(next)
    setPopped(s)
    if (next === 5) { setFullGlow(true); setTimeout(() => setFullGlow(false), 700) }
    setTimeout(() => setPopped(0), 320)
  }
  return (
    <div className={`${styles.stars} ${fullGlow ? styles.starsFull : ''}`}>
      {[1,2,3,4,5].map(s => (
        <span key={s}
          className={`${styles.star} ${s<=(hov||rating)?styles.starFilled:''} ${popped===s?styles.starPop:''}`}
          onMouseEnter={()=>setHov(s)} onMouseLeave={()=>setHov(0)}
          onClick={()=>handleClick(s)}>★</span>
      ))}
    </div>
  )
}

function FolderPicker({ onSelect, excludeIds }: { onSelect:(id:string)=>void; excludeIds:string[] }) {
  const { folders } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [open])
  const available = folders.filter(f => !excludeIds.includes(f.id))
  return (
    <div ref={ref} style={{ position:'relative' }}>
      <button className={styles.addChipBtn} onClick={()=>setOpen(!open)}>+ Folder</button>
      {open && (
        <div className={styles.folderDrop}>
          {!available.length && <div className={styles.dropEmpty}>No folders</div>}
          {available.map(f => (
            <button key={f.id} className={styles.dropItem} onClick={()=>{onSelect(f.id);setOpen(false)}}>
              <Folder size={12} strokeWidth={1.6} style={{ color: f.color, flexShrink: 0 }} /> {f.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AiStatusPill({
  icon,
  state,
  title,
}: {
  icon: 'index' | 'image' | 'tag'
  state: 'done' | 'running' | 'pending'
  title: string
}) {
  const MainIcon = icon === 'index'
    ? Brain
    : icon === 'image'
      ? ImagePlus
      : Sparkles
  const StateIcon = state === 'running' ? Loader2 : MainIcon
  return (
    <div
      className={`${styles.aiStatusPill} ${icon === 'image' ? styles.aiStatusCompactTooltip : ''} ${styles[`aiStatusIcon${icon[0].toUpperCase()}${icon.slice(1)}`]} ${styles[`aiStatus${state[0].toUpperCase()}${state.slice(1)}`]}`}
      data-tooltip={title}
      aria-label={title}
    >
      <StateIcon size={12} strokeWidth={2} className={state === 'running' ? styles.aiStatusSpin : undefined} />
    </div>
  )
}

function MultiSelectionEditor({ selectedIds }: { selectedIds: string[] }) {
  const { assets, folders, tags: allTags, updateAsset, addTag, showToast } = useStore()
  const [tagInput, setTagInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const tagRef = useRef<HTMLInputElement>(null)

  const selectedAssets = selectedIds
    .map(id => assets.find(a => a.id === id))
    .filter((a): a is Asset => !!a)

  const selectedTagUniverse = Array.from(new Set(selectedAssets.flatMap(a => a.tags)))
  const tagUniverse = Array.from(new Set([...allTags, ...selectedTagUniverse]))
  const commonTags = tagUniverse.filter(t => selectedAssets.every(a => a.tags.includes(t)))
  const partialTags = tagUniverse.filter(t => !commonTags.includes(t) && selectedAssets.some(a => a.tags.includes(t)))
  const topFolders = folders.filter(f => !f.parentId)
  const childFolders = folders.filter(f => f.parentId)

  const applyTagToAll = (tag: string) => {
    const trimmed = tag.trim().toLowerCase()
    if (!trimmed || !selectedAssets.length) return
    selectedAssets.forEach(a => {
      if (!a.tags.includes(trimmed)) updateAsset(a.id, { tags: [...a.tags, trimmed] })
    })
    addTag(trimmed)
    showToast(`Added "${trimmed}" to ${selectedAssets.length} assets`, 'success')
    setTagInput('')
    tagRef.current?.focus()
  }

  const removeTagFromAll = (tag: string) => {
    selectedAssets.forEach(a => {
      if (a.tags.includes(tag)) updateAsset(a.id, { tags: a.tags.filter(t => t !== tag) })
    })
    showToast(`Removed "${tag}" from ${selectedAssets.length} assets`, 'info')
  }

  const toggleFolderForAll = (folderId: string, hasAll: boolean) => {
    selectedAssets.forEach(a => {
      const inFolder = a.folders.includes(folderId)
      if (hasAll && inFolder) updateAsset(a.id, { folders: a.folders.filter(f => f !== folderId) })
      else if (!hasAll && !inFolder) updateAsset(a.id, { folders: [...a.folders, folderId] })
    })
  }

  const sendTo = async () => {
    const dest = await (window as any).electronAPI?.selectDestFolder()
    if (!dest) return
    const paths = selectedAssets.map(a => a.filePath)
    const results = await (window as any).electronAPI?.copyFilesToDest(paths, dest)
    const ok = results?.filter((r: any) => r.ok).length || 0
    showToast(`Copied ${ok}/${paths.length} files`, ok === paths.length ? 'success' : 'error')
  }

  const shareSelected = () => {
    void shareAssets(selectedAssets, showToast)
  }

  const suggestions = tagInput.trim()
    ? tagUniverse.filter(t => t.toLowerCase().includes(tagInput.toLowerCase()) && !selectedAssets.every(a => a.tags.includes(t)))
    : tagUniverse.filter(t => !selectedAssets.every(a => a.tags.includes(t))).slice(0, 12)

  const renderFolderRow = (f: typeof folders[number], nested = false) => {
    const parent = f.parentId ? folders.find(p => p.id === f.parentId) : null
    const hasAll = selectedAssets.every(a => a.folders.includes(f.id))
    const hasSome = !hasAll && selectedAssets.some(a => a.folders.includes(f.id))
    return (
      <label key={f.id} className={`${styles.bulkFolderRow} ${nested ? styles.bulkFolderRowNested : ''}`}>
        <input type="checkbox" checked={hasAll}
          ref={el => { if (el) el.indeterminate = hasSome }}
          onChange={() => toggleFolderForAll(f.id, hasAll)}
          className={styles.bulkCheckbox} />
        <Folder size={13} strokeWidth={1.6} style={{ color: f.color || 'var(--text-muted)', flexShrink: 0 }} />
        <span className={styles.bulkFolderName}>{f.name}</span>
        {parent && <span className={styles.bulkMeta}>{parent.icon} {parent.name}</span>}
        {hasSome && <span className={styles.bulkMeta}>some</span>}
      </label>
    )
  }

  return (
    <>
      <div className={styles.body}>
        <div className={styles.nameLabel}>{selectedAssets.length} items selected</div>

        <hr className={styles.divider} />

        <div className={styles.section}>
          <div className={styles.secLabel}>Tags</div>
          <div className={`${styles.chipsBox} ${styles.bulkChipsBox}`}>
            {commonTags.map(t => (
              <span key={t} className={styles.chip}>
                {t}
                <button className={styles.chipX} onClick={() => removeTagFromAll(t)}>×</button>
              </span>
            ))}
            {partialTags.slice(0, 10).map(t => (
              <button key={t} className={`${styles.chip} ${styles.bulkPartialChip}`} onClick={() => applyTagToAll(t)}
                data-tooltip={`Add "${t}" to all selected`}
                aria-label={`Add "${t}" to all selected`}>
                {t} <span className={styles.bulkMeta}>+</span>
              </button>
            ))}
            <input ref={tagRef} value={tagInput}
              onChange={e => { setTagInput(e.target.value); setShowSuggestions(true) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { applyTagToAll(tagInput); setShowSuggestions(false) }
                if (e.key === 'Escape') { setShowSuggestions(false); setTagInput('') }
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="Tag, Enter..."
              className={styles.tagInput} />
            {showSuggestions && suggestions.length > 0 && (
              <div className={styles.bulkSuggestMenu}>
                {suggestions.map(t => (
                  <button key={t} className={`${styles.bulkSuggestItem} ${partialTags.includes(t) ? styles.bulkSuggestItemPartial : ''}`}
                    onMouseDown={e => { e.preventDefault(); applyTagToAll(t); setShowSuggestions(false) }}>
                    <span className={styles.bulkSuggestName}>{t}</span>
                    {partialTags.includes(t) && <span className={styles.bulkMeta}>some</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <hr className={styles.divider} />

        <div className={styles.section}>
          <div className={styles.secLabel}>Folders</div>
          <div className={`${styles.chipsBox} ${styles.bulkFolderBox}`}>
            {topFolders.map(f => renderFolderRow(f))}
            {childFolders.map(f => renderFolderRow(f, true))}
            {!folders.length && <button className={styles.addChipBtn} disabled>No folders</button>}
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        <button className={styles.footBtn} onClick={shareSelected}>
          <Share2 size={13} strokeWidth={1.8} /> Share
        </button>
        <button className={styles.footBtn} onClick={sendTo}>
          <FolderOpen size={13} strokeWidth={1.8} /> Send to folder
        </button>
      </div>
    </>
  )
}

// ── Thumb for ANY file type in the inspector panel ────────────────────────────
function InspectorThumb({ asset, onImgLoad }: { asset: Asset; onImgLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void }) {
  const [fontLoaded, setFontLoaded] = useState(false)
  const fontId = `ins_font_${asset.id}`
  const thumbnail = asset.thumbnailVariants?.md || asset.thumbnailVariants?.lg || asset.thumbnailVariants?.sm || asset.thumbnailData

  useEffect(() => {
    if (!isFont(asset.ext)) return
    setFontLoaded(false)
    const fp = asset.filePath.replace(/\\/g, '/')
    const style = document.createElement('style')
    style.id = fontId
    style.textContent = `@font-face { font-family: "${fontId}"; src: url("file://${fp}"); }`
    document.head.appendChild(style)
    document.fonts.load(`24px "${fontId}"`).then(() => setFontLoaded(true)).catch(() => {})
    return () => { const s = document.getElementById(fontId); if (s) s.remove() }
  }, [asset.id])

  if (thumbnail && !isVideo(asset.ext) && !is3D(asset.ext)) {
    return <img src={thumbnail} className={styles.previewImg} alt="" onLoad={onImgLoad} />
  }
  if (isVideo(asset.ext) && thumbnail) {
    return (
      <div className={styles.previewThumbWrap}>
        <img src={thumbnail} className={styles.previewImg} alt="" />
        <div className={styles.previewPlayBadge}><Video size={10} strokeWidth={2} /></div>
      </div>
    )
  }
  if (is3D(asset.ext) && thumbnail) {
    return (
      <div className={styles.previewThumbWrap}>
        <img src={thumbnail} className={styles.previewImg} alt="" />
        <div className={styles.preview3DBadge}>3D</div>
      </div>
    )
  }
  if (isAudio(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a1e2e,#0f1118)' }}>
        <div className={styles.miniWave}>
          {[4,8,6,10,5,9,7,11,6,8,4,7,10,5,8].map((h,i) => (
            <div key={i} style={{ height: h*3, width: 3, background: 'var(--accent)', borderRadius: 2, opacity: 0.7 }} />
          ))}
        </div>
        <span className={styles.previewTypeLabel}><Music size={11} strokeWidth={1.8} style={{display:'inline',verticalAlign:'middle',marginRight:3}}/>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  if (isFont(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: '#fafafa' }}>
        {fontLoaded
          ? <div style={{ fontFamily: `"${fontId}"`, fontSize: 32, color: '#111', lineHeight:1 }}>Aa</div>
          : <Type size={32} strokeWidth={1.2} style={{ opacity: 0.4, color: '#111' }} />}
        <span className={styles.previewTypeLabel} style={{color:'#666'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  if (asset.ext === 'pdf') {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a0a0a,#2a1010)' }}>
        <FileText size={36} strokeWidth={1.2} style={{ opacity: 0.6, color: '#e05252' }} />
        <span className={styles.previewTypeLabel} style={{color:'#e05252'}}>PDF</span>
      </div>
    )
  }
  if (['txt','md','json','csv','xml','html','css','js','ts','jsx','tsx','py','sh'].includes(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#0a1a0a,#101810)' }}>
        <FileText size={36} strokeWidth={1.2} style={{ opacity: 0.6, color: '#6bcb77' }} />
        <span className={styles.previewTypeLabel} style={{color:'#6bcb77'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  if (['psd','ai','fig','sketch','xd','eps','afdesign'].includes(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a0a1a,#210d21)' }}>
        <Palette size={36} strokeWidth={1.2} style={{ opacity: 0.6, color: '#a259ff' }} />
        <span className={styles.previewTypeLabel} style={{color:'#a259ff'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  if (is3D(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a1008,#221508)' }}>
        <Box size={36} strokeWidth={1.2} style={{ opacity: 0.6, color: '#ff922b' }} />
        <span className={styles.previewTypeLabel} style={{color:'#ff922b'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  if (isVideo(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a0808,#200d0d)' }}>
        <Video size={36} strokeWidth={1.2} style={{ opacity: 0.6, color: '#ff6b6b' }} />
        <span className={styles.previewTypeLabel} style={{color:'#ff6b6b'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  return (
    <div className={styles.previewIconBox}>
      <Folder size={36} strokeWidth={1.2} style={{ opacity: 0.4 }} />
      <span className={styles.previewTypeLabel}>{asset.ext.toUpperCase()}</span>
    </div>
  )
}

// ── Main inspector ────────────────────────────────────────────────────────────
export default function Inspector() {
  const assets = useStore(s => s.assets)
  const selectedAssetIds = useStore(s => s.selectedAssetIds)
  const updateAsset = useStore(s => s.updateAsset)
  const renameAsset = useStore(s => s.renameAsset)
  const folders = useStore(s => s.folders)
  const allTags = useStore(s => s.tags)
  const addTag = useStore(s => s.addTag)
  const showToast = useStore(s => s.showToast)
  const setLightboxAsset = useStore(s => s.setLightboxAsset)
  const setInspectorOpen = useStore(s => s.setInspectorOpen)
  const restoreAssets = useStore(s => s.restoreAssets)
  const activeFolderType = useStore(s => s.activeFolderType)
  const clearSelection = useStore(s => s.clearSelection)
  const aiProgress = useStore(s => s.aiProgress)
  const aiIndexProgress = useStore(s => s.aiIndexProgress)
  const dinoIndexProgress = useStore(s => s.dinoIndexProgress)
  const dinoIndexStatus = useStore(s => s.dinoIndexStatus)
  const aiFeatureStatus = useStore(s => s.aiFeatureStatus)
  const [newTag, setNewTag] = useState('')
  const [showTagSuggestions, setShowTagSuggestions] = useState(false)
  const [editName, setEditName] = useState(false)
  const [nameVal, setNameVal] = useState('')
  const [copiedColor, setCopiedColor] = useState<string|null>(null)
  const [detailSelectedAssetIds, setDetailSelectedAssetIds] = useState<string[]>(selectedAssetIds)

  const inTrash = activeFolderType === 'trash'
  const hasSelection = selectedAssetIds.length > 0

  useEffect(() => {
    if (selectedAssetIds.length !== 1) {
      setDetailSelectedAssetIds(selectedAssetIds)
      return
    }
    const nextIds = [...selectedAssetIds]
    const raf = requestAnimationFrame(() => setDetailSelectedAssetIds(nextIds))
    return () => cancelAnimationFrame(raf)
  }, [selectedAssetIds])

  const singleSelectionPending =
    selectedAssetIds.length === 1 &&
    (detailSelectedAssetIds.length !== 1 || detailSelectedAssetIds[0] !== selectedAssetIds[0])

  const effectiveDetailSelectedAssetIds = selectedAssetIds.length === 1 ? detailSelectedAssetIds : selectedAssetIds
  const asset: Asset|null = useMemo(() => (
    effectiveDetailSelectedAssetIds.length === 1 ? assets.find(a => a.id === effectiveDetailSelectedAssetIds[0]) || null : null
  ), [assets, effectiveDetailSelectedAssetIds])
  useEffect(() => {
    if (asset) {
      setNameVal(asset.name)
      setEditName(false)
      setNewTag('')
      setShowTagSuggestions(false)
    }
  }, [asset?.id])

  const saveName = async () => {
    if (!asset) return
    const nextName = nameVal.trim()
    if (!nextName) {
      setNameVal(asset.name)
      setEditName(false)
      return
    }
    const renamed = nextName === asset.name || await renameAsset(asset.id, nextName)
    if (renamed) setEditName(false)
    else setNameVal(asset.name)
  }
  const applySingleTag = (rawTag: string) => {
    const tag = rawTag.trim()
    if (!tag) return
    if (asset && !asset.tags.includes(tag)) { updateAsset(asset.id, { tags:[...asset.tags,tag] }); addTag(tag) }
    setNewTag('')
    setShowTagSuggestions(false)
  }
  const handleAddTag = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') applySingleTag(newTag)
    if (e.key === 'Escape') { setNewTag(''); setShowTagSuggestions(false) }
  }
  const singleTagSuggestions = asset
    ? (newTag.trim()
      ? allTags.filter(t => t.toLowerCase().includes(newTag.toLowerCase()) && !asset.tags.includes(t)).slice(0, 12)
      : allTags.filter(t => !asset.tags.includes(t)).slice(0, 12))
    : []
  const handleColorClick = (hex: string) => {
    navigator.clipboard?.writeText(hex).then(() => { setCopiedColor(hex); showToast(`Colour ${hex} copied!`,'success'); setTimeout(()=>setCopiedColor(null),1500) })
  }
  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    if (!asset) return
    const img = e.currentTarget
    const assetId = asset.id
    const shouldSaveDimensions = !asset.width || !asset.height
    window.setTimeout(() => {
      const updates: Partial<Asset> = {}
      if (shouldSaveDimensions) {
        updates.width = img.naturalWidth
        updates.height = img.naturalHeight
      }
      if (Object.keys(updates).length) updateAsset(assetId, updates)
    }, 120)
  }, [asset])

  const selectedAssets = useMemo(() => (
    selectedAssetIds
      .map(id => assets.find(a => a.id === id))
      .filter((a): a is Asset => !!a)
  ), [assets, selectedAssetIds])

  const shareSelected = useCallback(() => {
    void shareAssets(selectedAssets, showToast)
  }, [selectedAssets, showToast])

  if (singleSelectionPending || (!asset && selectedAssetIds.length === 1)) {
    return <InspectorSkeleton onCollapse={() => setInspectorOpen(false)} />
  }

  if (!asset) return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        {hasSelection && (
          <div className={styles.headerActions}>
            {inTrash ? (
              <button className={styles.hBtn} onClick={() => restoreAssets(selectedAssetIds)} data-tooltip="Restore" aria-label="Restore"><RotateCcw size={12} strokeWidth={2}/></button>
            ) : null}
            <button className={styles.hBtn} onClick={() => clearSelection()} data-tooltip="Deselect" aria-label="Deselect"><X size={12} strokeWidth={2}/></button>
            <span className={styles.selCount}>{selectedAssetIds.length} selected</span>
          </div>
        )}
        <button className={styles.collapseBtn} onClick={() => setInspectorOpen(false)} data-tooltip="Collapse inspector" aria-label="Collapse inspector">
          <PanelRightClose size={13} strokeWidth={1.8} />
        </button>
      </div>
      {selectedAssetIds.length > 1 ? (
        <MultiSelectionEditor selectedIds={selectedAssetIds} />
      ) : (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}><Search size={28} strokeWidth={1.2} style={{ opacity: 0.25 }} /></div>
          <p>Select an asset</p>
        </div>
      )}
    </div>
  )

  const getFolderName = (id: string) => folders.find(f=>f.id===id)?.name||id
  const assetFileName = `${asset.name}.${asset.ext}`
  const aiTaggingThisAsset = !!aiProgress?.active && aiProgress.current === assetFileName
  const aiIndexingThisAsset = !!aiIndexProgress && aiIndexProgress.type !== 'done' && aiIndexProgress.type !== 'error'
    && (
      aiIndexProgress.file === asset.id ||
      aiIndexProgress.file === assetFileName ||
      aiIndexProgress.file === `${asset.id}.jpg` ||
      !!aiIndexProgress.file?.includes(asset.id) ||
      !!aiIndexProgress.file?.includes(assetFileName)
    )
  const indexState = asset.aiEmbedded ? 'done' : aiIndexingThisAsset ? 'running' : 'pending'
  const dinoIndexingThisAsset = !!dinoIndexProgress &&
    dinoIndexProgress.type !== 'done' &&
    dinoIndexProgress.type !== 'error' &&
    dinoIndexProgress.type !== 'cancelled' &&
    (
      dinoIndexProgress.file === `${asset.id}.jpg` ||
      !!dinoIndexProgress.file?.includes(asset.id)
    )
  const dinoState = dinoIndexStatus?.assetIds?.includes(asset.id)
    ? 'done'
    : dinoIndexingThisAsset
      ? 'running'
      : 'pending'
  const tagState = asset.aiTagged ? 'done' : aiTaggingThisAsset ? 'running' : 'pending'

  return (
    <div className={styles.panel}>
      {/* Panel header with selection actions and collapse button */}
      <div className={styles.panelHeader}>
        {hasSelection && (
          <div className={styles.headerActions}>
            <button className={styles.collapseBtn} onClick={() => setInspectorOpen(false)} data-tooltip="Collapse inspector" aria-label="Collapse inspector">
              <PanelRightClose size={13} strokeWidth={1.8} />
            </button>
            {inTrash ? (
              <button className={styles.hBtn} onClick={() => restoreAssets(selectedAssetIds)} data-tooltip="Restore" aria-label="Restore"><RotateCcw size={12} strokeWidth={2}/></button>
            ) : null}
          </div>
        )}
        <div className={styles.aiStatusCenter}>
          {aiFeatureStatus?.tipsv2.installed && aiFeatureStatus.tipsv2.enabled && <AiStatusPill
            icon="index"
            state={indexState}
            title={indexState === 'done' ? 'AI index ready' : indexState === 'running' ? 'Indexing with AI' : 'No AI index'}
          />}
          {aiFeatureStatus?.dinov3.installed && aiFeatureStatus.dinov3.enabled && <AiStatusPill
            icon="image"
            state={dinoState}
            title={dinoState === 'done'
              ? 'DINOv3 image index ready'
              : dinoState === 'running'
                ? 'Indexing image with DINOv3'
                : dinoIndexStatus?.enabled === false
                  ? 'Not indexed; image search will index this on demand'
                  : 'No DINOv3 image index'}
          />}
          {aiFeatureStatus?.tagging.active && aiFeatureStatus.tagging.enabled && <AiStatusPill
            icon="tag"
            state={tagState}
            title={tagState === 'done' ? 'AI tags ready' : tagState === 'running' ? 'AI tagging' : 'No AI tags'}
          />}
        </div>
        {hasSelection && (
          <div className={styles.headerRightActions}>
            <button className={styles.hBtn} onClick={() => clearSelection()} data-tooltip="Deselect" aria-label="Deselect"><X size={12} strokeWidth={2}/></button>
          </div>
        )}
      </div>

      {/* Clickable preview box */}
      <div className={styles.previewBox} onClick={() => setLightboxAsset(asset)} data-tooltip="Click to preview" aria-label="Click to preview">
        <InspectorThumb asset={asset} onImgLoad={handleImgLoad} />
        <div className={styles.previewHoverOverlay}><Search size={14} strokeWidth={2} style={{marginRight:4}}/> Preview</div>
      </div>

      <div className={styles.body}>
        {/* Colour palette — images use their preview, non-image assets use their max thumbnail */}
        {asset.colors.length>0 && (isImage(asset.ext) || !!asset.thumbnailData) && (
          <div className={styles.palette}>
            <div className={styles.palettePill}>
              {asset.colors.map((c,i) => (
                <div key={i} className={styles.swatchWrap} onClick={()=>handleColorClick(c.hex)}>
                  <div className={`${styles.swatch} ${copiedColor===c.hex?styles.swatchCopied:''}`}
                    style={{background:c.hex}} />
                  <div className={styles.swatchTooltip}>{copiedColor===c.hex?'Copied!':c.hex}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {editName
          ? <input className={styles.nameInput} value={nameVal} onChange={e=>setNameVal(e.target.value)}
              onBlur={() => { void saveName() }} autoFocus onKeyDown={e=>{if(e.key==='Enter')void saveName();if(e.key==='Escape'){setNameVal(asset.name);setEditName(false)}}} />
          : <div className={styles.nameLabel} onClick={()=>setEditName(true)} data-tooltip="Click to rename" aria-label="Click to rename">{asset.name}</div>}

        <textarea className={styles.notes}
          placeholder="Add notes…"
          value={asset.notes || asset.aiDescription || ''}
          style={!asset.notes && asset.aiDescription ? {color:'var(--text-muted)'} : undefined}
          onChange={e => { updateAsset(asset.id, {notes: e.target.value}) }}
          onFocus={e => {
            if (!asset.notes && asset.aiDescription) {
              updateAsset(asset.id, {notes: asset.aiDescription})
              const el = e.target
              requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = el.value.length })
            }
          }} />

        <hr className={styles.divider} />

        <div className={styles.section}>
          <div className={styles.secLabel}>Tags</div>
          <div className={`${styles.chipsBox} ${styles.tagChipsBox}`}>
            {asset.tags.map(t=>(
              <span key={t} className={styles.chip}>{t}
                <button className={styles.chipX} onClick={()=>updateAsset(asset.id,{tags:asset.tags.filter(x=>x!==t)})}>×</button>
              </span>
            ))}
            <input className={styles.tagInput} placeholder="Tag, Enter…" value={newTag}
              onChange={e=>{ setNewTag(e.target.value); setShowTagSuggestions(true) }}
              onKeyDown={handleAddTag}
              onFocus={() => setShowTagSuggestions(true)}
              onBlur={() => window.setTimeout(() => setShowTagSuggestions(false), 140)} />
            {showTagSuggestions && singleTagSuggestions.length > 0 && (
              <div className={styles.tagSuggestMenu}>
                {singleTagSuggestions.map(t => (
                  <button key={t} className={styles.tagSuggestItem}
                    onMouseDown={e => { e.preventDefault(); applySingleTag(t) }}>
                    <span className={styles.bulkSuggestName}>{t}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <hr className={styles.divider} />

        <div className={styles.section}>
          <div className={styles.secLabel}>Folders</div>
          <div className={styles.chipsBox}>
            {asset.folders.map(fid=>(
              <span key={fid} className={`${styles.chip} ${styles.fchip}`}>
                <Folder size={11} strokeWidth={1.6} style={{ flexShrink: 0 }} /> {getFolderName(fid)}
                <button className={styles.chipX} onClick={()=>updateAsset(asset.id,{folders:asset.folders.filter(f=>f!==fid)})}>×</button>
              </span>
            ))}
            <FolderPicker excludeIds={asset.folders} onSelect={fid=>updateAsset(asset.id,{folders:[...asset.folders,fid]})} />
          </div>
        </div>

        <hr className={styles.divider} />

        <div className={styles.section}>
          <div className={styles.secLabel}>Properties</div>
          <div className={styles.propsBox}>
            <div className={styles.propRating}>
              <span className={styles.propK}>Rating</span>
              <StarRating rating={asset.rating} onChange={r=>updateAsset(asset.id,{rating:r})} />
            </div>
            {asset.width&&asset.height&&<Prop k="Dimensions" v={`${asset.width} × ${asset.height}`}/>}
            <Prop k="Size" v={formatSize(asset.size)}/>
            <Prop k="Type" v={asset.ext.toUpperCase()}/>
            <Prop k="Imported" v={formatDate(asset.importTime)}/>
            <Prop k="Modified" v={formatDate(asset.mtime)}/>
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        {asset.ext === 'url' ? <>
          <button className={styles.footBtn} onClick={async () => {
            await navigator.clipboard.writeText(asset.url)
            showToast('URL copied', 'success')
          }}>
            <Copy size={13} strokeWidth={1.8} /> Copy URL
          </button>
          <button className={styles.footBtn} onClick={() => (window as any).electronAPI?.openExternalUrl(asset.url)}>
            <Globe2 size={13} strokeWidth={1.8} /> Open
          </button>
        </> : <>
          <button className={styles.footBtn} onClick={()=>(window as any).electronAPI?.showInFolder(asset.filePath)}>
            <FolderOpen size={13} strokeWidth={1.8} /> Show
          </button>
          <button className={styles.footBtn} onClick={()=>(window as any).electronAPI?.exportFile?.(asset.filePath)}>
            <Download size={13} strokeWidth={1.8} /> Export
          </button>
          <button className={styles.footBtn} onClick={shareSelected}>
            <Share2 size={13} strokeWidth={1.8} /> Share
          </button>
        </>}
      </div>
    </div>
  )
}

function Prop({ k, v }: { k:string; v:string }) {
  return <div className={styles.propRow}><span className={styles.propK}>{k}</span><span className={styles.propV}>{v}</span></div>
}

function InspectorSkeleton({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.headerActions}>
          <button className={styles.collapseBtn} onClick={onCollapse} data-tooltip="Collapse inspector" aria-label="Collapse inspector">
            <PanelRightClose size={13} strokeWidth={1.8} />
          </button>
          <span className={`${styles.skeletonBlock} ${styles.skeletonHeaderButton}`} />
        </div>
        <div className={styles.aiStatusCenter}>
          <span className={`${styles.skeletonBlock} ${styles.skeletonHeaderButton}`} />
          <span className={`${styles.skeletonBlock} ${styles.skeletonHeaderButton}`} />
          <span className={`${styles.skeletonBlock} ${styles.skeletonHeaderButton}`} />
          <span className={`${styles.skeletonBlock} ${styles.skeletonHeaderButton}`} />
        </div>
        <div className={styles.headerRightActions}>
          <span className={`${styles.skeletonBlock} ${styles.skeletonHeaderButton}`} />
          <span className={`${styles.skeletonBlock} ${styles.skeletonHeaderButton}`} />
          <span className={`${styles.skeletonBlock} ${styles.skeletonHeaderButton}`} />
        </div>
      </div>
      <div className={styles.previewBox}>
        <div className={`${styles.skeletonBlock} ${styles.skeletonPreview}`} />
      </div>
      <div className={styles.body}>
        <div className={styles.skeletonPalette}>
          {[0, 1, 2, 3, 4].map(item => <span key={item} className={`${styles.skeletonBlock} ${styles.skeletonSwatch}`} />)}
        </div>
        <div className={`${styles.skeletonBlock} ${styles.skeletonTitle}`} />
        <div className={`${styles.skeletonBlock} ${styles.skeletonNotes}`} />
        <hr className={styles.divider} />
        <div className={styles.section}>
          <div className={`${styles.skeletonBlock} ${styles.skeletonSectionLabel}`} />
          <div className={`${styles.chipsBox} ${styles.skeletonChipsBox}`}>
            <span className={`${styles.skeletonBlock} ${styles.skeletonChip}`} />
            <span className={`${styles.skeletonBlock} ${styles.skeletonChipWide}`} />
            <span className={`${styles.skeletonBlock} ${styles.skeletonChip}`} />
            <span className={`${styles.skeletonBlock} ${styles.skeletonChipWide}`} />
            <span className={`${styles.skeletonBlock} ${styles.skeletonChip}`} />
          </div>
        </div>
        <hr className={styles.divider} />
        <div className={styles.section}>
          <div className={`${styles.skeletonBlock} ${styles.skeletonSectionLabel}`} />
          <div className={`${styles.chipsBox} ${styles.skeletonFolderBox}`}>
            <span className={`${styles.skeletonBlock} ${styles.skeletonFolderChip}`} />
          </div>
        </div>
        <hr className={styles.divider} />
        <div className={styles.section}>
          <div className={`${styles.skeletonBlock} ${styles.skeletonSectionLabel}`} />
          <div className={`${styles.propsBox} ${styles.skeletonPropsBox}`}>
            {[0, 1, 2, 3, 4].map(item => (
              <div key={item} className={styles.skeletonPropRow}>
                <span className={`${styles.skeletonBlock} ${styles.skeletonPropKey}`} />
                <span className={`${styles.skeletonBlock} ${styles.skeletonPropValue}`} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        {[0, 1, 2].map(item => <span key={item} className={`${styles.skeletonBlock} ${styles.skeletonFooterButton}`} />)}
      </div>
    </div>
  )
}
