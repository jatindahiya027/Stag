import { useRef, useCallback, memo, useState, useEffect, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { Asset } from '../types'
import { getExtBadgeColor, isImage, isVideo, isAudio, isFont, is3D } from '../utils/helpers'
import styles from './AssetGrid.module.css'

const IS_3D = (ext: string) => ['glb','gltf','obj','fbx','dae','stl'].includes(ext)

// ── Video thumbnail — pure display ────────────────────────────────────────────
// Thumbnail generation is handled by thumbEngine.ts background queue.
const VideoThumb = memo(({ asset }: { asset: Asset }) => (
  <div className={styles.videoThumb}>
    {asset.thumbnailData
      ? <img src={asset.thumbnailData} className={styles.fill} alt="" draggable={false} />
      : <div className={styles.placeholder}>
          <span className={styles.bigIcon}>▶</span>
          <span className={styles.typeLabel}>{asset.ext.toUpperCase()}</span>
        </div>
    }
    <div className={styles.videoPlayOverlay}>▶</div>
    <div className={styles.fileNameOverlay}>{asset.name}.{asset.ext}</div>
  </div>
), (prev, next) => prev.asset.id === next.asset.id && prev.asset.thumbnailData === next.asset.thumbnailData)

const COLORS_3D: Record<string,string> = { glb:'#ff922b',gltf:'#ff922b',obj:'#4ecdc4',fbx:'#ff6b9d',stl:'#c7f464',dae:'#88d8b0' }

// ── 3D thumbnail — pure display ───────────────────────────────────────────────
const Model3DThumb = memo(({ asset }: { asset: Asset }) => {
  const col = COLORS_3D[asset.ext] || '#ff922b'
  if (asset.thumbnailData) return (
    <div className={styles.model3dThumb}>
      <img src={asset.thumbnailData} className={styles.fill} alt="" draggable={false} />
      <div className={styles.model3dBadge}>3D</div>
    </div>
  )
  return (
    <div className={styles.placeholder}>
      <div style={{ fontSize: 34, color: col, lineHeight: 1 }}>⬡</div>
      <span style={{ fontSize: 11, fontWeight: 800, color: col, letterSpacing: '0.08em' }}>{asset.ext.toUpperCase()}</span>
      <span className={styles.typeLabel}>3D Model</span>
      <div className={styles.fileNameOverlay}>{asset.name}.{asset.ext}</div>
    </div>
  )
}, (prev, next) => prev.asset.id === next.asset.id && prev.asset.thumbnailData === next.asset.thumbnailData)

// ── Audio thumbnail ───────────────────────────────────────────────────────────
const AudioThumb = memo(({ asset }: { asset: Asset }) => {
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const barHeights = useMemo(() => Array.from({length: 12}, () => 20 + Math.random() * 80), [asset.id])
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    const a = audioRef.current
    if (!a) return
    if (playing) { a.pause(); setPlaying(false) }
    else { a.src = `file://${asset.filePath.replace(/\\/g, '/')}`; a.play().then(() => setPlaying(true)).catch(() => {}) }
  }
  useEffect(() => () => { audioRef.current?.pause() }, [])
  return (
    <div className={styles.audioThumb}>
      <audio ref={audioRef} onEnded={() => setPlaying(false)} />
      <div className={styles.waveform}>
        {barHeights.map((h, i) => (
          <div key={i} className={`${styles.waveBar} ${playing ? styles.wavePlaying : ''}`}
            style={{ height: `${h}%`, animationDelay: `${i * 0.06}s` }} />
        ))}
      </div>
      <button className={styles.playBtn} onClick={toggle}>{playing ? '⏸' : '▶'}</button>
      <div className={styles.fileNameOverlay}>{asset.name}.{asset.ext}</div>
    </div>
  )
})

// ── Font thumbnail ────────────────────────────────────────────────────────────
const FontThumb = memo(({ asset }: { asset: Asset }) => {
  const [loaded, setLoaded] = useState(false)
  const fontId = `card_font_${asset.id}`
  useEffect(() => {
    const fp = asset.filePath.replace(/\\/g, '/')
    const style = document.createElement('style')
    style.id = fontId
    style.textContent = `@font-face { font-family: "${fontId}"; src: url("file://${fp}"); }`
    document.head.appendChild(style)
    document.fonts.load(`20px "${fontId}"`).then(() => setLoaded(true)).catch(() => {})
    return () => { const s = document.getElementById(fontId); if (s) s.remove() }
  }, [asset.id])
  return (
    <div className={styles.fontThumb}>
      {loaded
        ? <div style={{ fontFamily: `"${fontId}"`, fontSize: 38, color: '#e0e3eb', lineHeight: 1 }}>Aa</div>
        : <span className={styles.bigIcon}>🔤</span>}
      <span className={styles.typeLabel}>{asset.ext.toUpperCase()}</span>
      <div className={styles.fileNameOverlay}>{asset.name}.{asset.ext}</div>
    </div>
  )
})

// ── Doc/text/code thumbnail ───────────────────────────────────────────────────
const DocThumb = memo(({ asset }: { asset: Asset }) => {
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => {
    const textExts = ['txt','md','json','csv','xml','html','css','js','ts','jsx','tsx','py','sh','yaml','yml','log','cfg','conf','sql']
    if (!textExts.includes(asset.ext)) return
    ;(window as any).electronAPI?.readText(asset.filePath, 400).then((r: any) => {
      if (r?.text) setLines(r.text.split('\n').slice(0, 8).filter((l: string) => l.trim()))
    })
  }, [asset.id])

  const ICONS: Record<string,string> = {
    pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📋', pptx:'📋',
    epub:'📖', zip:'📦', rar:'📦', '7z':'📦', psd:'🎨', ai:'🎨', fig:'🎨',
    sketch:'🎨', xd:'🎨', eps:'🎨', blend:'🎲',
  }
  const COLORS: Record<string,string> = { pdf:'#e05252', doc:'#2b6fcf', docx:'#2b6fcf', xls:'#217346', xlsx:'#217346', ppt:'#d04c2f', pptx:'#d04c2f', json:'#f5a623', md:'#6bcb77', py:'#4d96ff', js:'#f5a623', ts:'#4a9eff', html:'#e34c26', css:'#264de4', sql:'#cc6699', sh:'#6bcb77', zip:'#9b59b6', rar:'#9b59b6', psd:'#31a8ff', ai:'#ff9a00', epub:'#ff922b' }
  const icon = ICONS[asset.ext]
  const col = COLORS[asset.ext] || '#6b7280'

  if (icon && !lines.length) return (
    <div className={styles.placeholder} style={{ background: `linear-gradient(135deg, #0d1020 0%, ${col}18 100%)` }}>
      <span style={{ fontSize: 38 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 700, color: col, letterSpacing: '0.08em' }}>{asset.ext.toUpperCase()}</span>
      <div className={styles.fileNameOverlay}>{asset.name}.{asset.ext}</div>
    </div>
  )

  if (lines.length) return (
    <div className={styles.docThumb}>
      <div className={styles.docLines}>
        {lines.map((l, i) => <div key={i} className={styles.docLine} style={{ opacity: 1 - i * 0.09, fontSize: i === 0 ? 9 : 8 }}>{l}</div>)}
      </div>
      <div className={styles.docExt} style={{ color: col }}>{asset.ext.toUpperCase()}</div>
      <div className={styles.fileNameOverlay}>{asset.name}.{asset.ext}</div>
    </div>
  )

  return (
    <div className={styles.placeholder}>
      <span className={styles.bigIcon}>📁</span>
      <span className={styles.typeLabel}>{asset.ext.toUpperCase()}</span>
      <div className={styles.fileNameOverlay}>{asset.name}.{asset.ext}</div>
    </div>
  )
})

// ── Lazy image ────────────────────────────────────────────────────────────────
const LazyImage = memo(({ src, alt }: { src: string; alt: string }) => {
  // Virtual scroll + 200px overscan means this component only mounts when near viewport.
  // Just render immediately — no IntersectionObserver needed.
  const [inView] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className={styles.lazyWrap}>
      {!loaded && <div className={styles.shimmer} />}
      {inView && <img src={src} className={`${styles.img} ${loaded ? styles.imgLoaded : ''}`} alt={alt} draggable={false} decoding="async" onLoad={() => setLoaded(true)} />}
    </div>
  )
})

// ── Context menu ──────────────────────────────────────────────────────────────
const CtxMenu = memo(({ x, y, asset, selCount, selIds, onClose }: any) => {
  const { deleteAssets, setLightboxAsset, restoreAssets, permanentDeleteWithPrompt, activeFolderType } = useStore()
  const inTrash = activeFolderType === 'trash'
  const ids = selCount > 1 ? selIds : [asset.id]
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{x:number;y:number}|null>(null)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <div className={styles.ctxMenu} ref={ref} style={{ left: pos?.x??x, top: pos?.y??y, visibility: pos?'visible':'hidden' }}>
      {!inTrash && selCount <= 1 && <>
        <button className={styles.ctxItem} onClick={() => { setLightboxAsset(asset); onClose() }}>🔍 Preview</button>
        <button className={styles.ctxItem} onClick={() => { (window as any).electronAPI?.openPath(asset.filePath); onClose() }}>↗ Open in app</button>
        <button className={styles.ctxItem} onClick={() => { (window as any).electronAPI?.showInFolder(asset.filePath); onClose() }}>📂 Show in folder</button>
        <div className={styles.ctxDiv} />
      </>}
      {inTrash ? <>
        <button className={styles.ctxItem} onClick={() => { restoreAssets(ids); onClose() }}>↩ Restore</button>
        <button className={`${styles.ctxItem} ${styles.ctxDanger}`}
          onClick={() => { permanentDeleteWithPrompt(ids); onClose() }}>
          🗑 Delete permanently{selCount>1?` (${selCount})`:''}
        </button>
      </> : (
        <button className={`${styles.ctxItem} ${styles.ctxDanger}`}
          onClick={() => { deleteAssets(ids); onClose() }}>
          🗑 Trash{selCount>1?` (${selCount})`:''}
        </button>
      )}
    </div>
  )
})

// ── Layout ────────────────────────────────────────────────────────────────────
function cardH(a: Asset, w: number) {
  // Preserve aspect ratio for PDF/EPUB thumbnails when actual dimensions are known.
  if ((a.ext === 'pdf' || a.ext === 'epub') && a.width && a.height && a.width > 0) {
    return Math.max(60, Math.min(Math.round((a.height / a.width) * w), w * 2.8))
  }
  if (isImage(a.ext) && a.width && a.height && a.width > 0) return Math.max(60, Math.min(Math.round(a.height / a.width * w), w * 2.8))
  if (isAudio(a.ext)) return 90
  if (isVideo(a.ext)) return Math.round(w * 9 / 16)
  if (IS_3D(a.ext))   return w
  if (isFont(a.ext))  return Math.round(w * 0.75)
  return Math.round(w * 0.85)
}
interface LI { asset: Asset; x: number; y: number; w: number; h: number }
function computeLayout(assets: Asset[], cw: number, gap: number, cW: number) {
  if (cW < 10 || cw < 10) return { items: [] as LI[], totalH: 0 }
  const cols = Math.max(1, Math.floor((cW+gap)/(cw+gap)))
  const hs = new Array(cols).fill(0)
  const items: LI[] = []
  for (const a of assets) {
    const col = hs.indexOf(Math.min(...hs)); const h = cardH(a, cw)
    items.push({ asset:a, x:col*(cw+gap), y:hs[col], w:cw, h }); hs[col] += h+gap
  }
  return { items, totalH: Math.max(0, Math.max(...hs)-gap+10) }
}

// ── Pick which thumb to show ──────────────────────────────────────────────────
const ThumbContent = memo(function ThumbContent({ asset }: { asset: Asset }) {
  if (isAudio(asset.ext)) return <AudioThumb asset={asset} />
  if (isVideo(asset.ext)) return <VideoThumb asset={asset} />
  if (IS_3D(asset.ext))   return <Model3DThumb asset={asset} />
  if (isFont(asset.ext))  return <FontThumb asset={asset} />
  if (asset.thumbnailData) return <LazyImage src={asset.thumbnailData} alt={asset.name} />
  // Documents, code, design, archives
  return <DocThumb asset={asset} />
}, (p, n) => p.asset.id === n.asset.id && p.asset.thumbnailData === n.asset.thumbnailData && p.asset.ext === n.asset.ext)

// ── Asset card ────────────────────────────────────────────────────────────────
const AssetCard = memo(({ asset, colWidth, isSelected, onClick, onDoubleClick, onContextMenu, onDragStart }: {
  asset: Asset; colWidth: number; isSelected: boolean
  onClick: (id: string, shift: boolean, ctrl: boolean) => void
  onDoubleClick: (a: Asset) => void
  onContextMenu: (e: React.MouseEvent, a: Asset) => void
  onDragStart: (e: React.DragEvent, a: Asset) => void
}) => {
  const h = cardH(asset, colWidth)
  return (
    <div id={`asset-${asset.id}`}
      className={`${styles.card} ${isSelected ? styles.selected : ''}`}
      style={{ width: colWidth }} draggable
      onDragStart={e => onDragStart(e, asset)}
      onClick={e => onClick(asset.id, e.shiftKey, e.metaKey||e.ctrlKey)}
      onDoubleClick={() => onDoubleClick(asset)}
      onContextMenu={e => onContextMenu(e, asset)}>
      <div className={styles.thumb} style={{ height: h }}>
        <ThumbContent asset={asset} />
        <div className={styles.extBadge} style={{ background: getExtBadgeColor(asset.ext) }}>{asset.ext.toUpperCase()}</div>
        {asset.aiTagged && (
          <div style={{position:'absolute',top:4,left:4,background:'rgba(74,158,255,0.85)',color:'#fff',fontSize:9,fontWeight:700,padding:'1px 4px',borderRadius:3,backdropFilter:'blur(4px)',letterSpacing:'0.5px'}}>AI</div>
        )}
        {asset.rating > 0 && <div className={styles.ratingBadge}>{'★'.repeat(asset.rating)}</div>}
      </div>
    </div>
  )
}, (p, n) => p.asset === n.asset && p.colWidth === n.colWidth && p.isSelected === n.isSelected)
AssetCard.displayName = 'AssetCard'

// ── Bulk actions bar ──────────────────────────────────────────────────────────
function BulkActionsBar({ selectedIds }: { selectedIds: string[] }) {
  const { assets, folders, tags: allTags, updateAsset, addTag, showToast } = useStore()
  const [panel, setPanel] = useState<'tags'|'folders'|null>(null)
  const [tagInput, setTagInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const tagRef = useRef<HTMLInputElement>(null)

  if (selectedIds.length < 2) return null

  const selectedAssets = selectedIds.map(id => assets.find(a => a.id === id)).filter(Boolean) as Asset[]

  // Tags already present on ALL selected assets
  const commonTags = allTags.filter(t => selectedAssets.every(a => a.tags.includes(t)))
  // Tags present on SOME (partial)
  const partialTags = allTags.filter(t => !commonTags.includes(t) && selectedAssets.some(a => a.tags.includes(t)))
  // Folders already present on ALL selected assets
  const commonFolderIds = folders.filter(f => selectedAssets.every(a => a.folders.includes(f.id)))

  const applyTagToAll = (tag: string) => {
    const trimmed = tag.trim().toLowerCase()
    if (!trimmed) return
    selectedAssets.forEach(a => {
      if (!a.tags.includes(trimmed)) updateAsset(a.id, { tags: [...a.tags, trimmed] })
    })
    addTag(trimmed)
    showToast(`Added "${trimmed}" to ${selectedIds.length} assets`, 'success')
    setTagInput('')
    tagRef.current?.focus()
  }

  const removeTagFromAll = (tag: string) => {
    selectedAssets.forEach(a => {
      if (a.tags.includes(tag)) updateAsset(a.id, { tags: a.tags.filter(t => t !== tag) })
    })
    showToast(`Removed "${tag}" from ${selectedIds.length} assets`, 'info')
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

  const suggestions = tagInput.trim()
    ? allTags.filter(t => t.toLowerCase().includes(tagInput.toLowerCase()) && !selectedAssets.every(a => a.tags.includes(t)))
    : allTags.filter(t => !selectedAssets.every(a => a.tags.includes(t))).slice(0, 12)

  const topFolders = folders.filter(f => !f.parentId)  // root folders first

  return (
    <div className={styles.bulkBar} style={{flexDirection:'column',alignItems:'stretch',gap:0,padding:0}}>
      {/* top row */}
      <div style={{display:'flex',alignItems:'center',gap:8,padding:'5px 12px'}}>
        <span className={styles.bulkCount}>{selectedIds.length} selected</span>
        <button className={styles.bulkBtn}
          style={{background: panel==='tags' ? 'var(--accent)' : 'var(--bg-tertiary)', color: panel==='tags'?'#fff':'var(--text-secondary)', border:'1px solid var(--border)'}}
          onClick={() => setPanel(p => p==='tags' ? null : 'tags')}>
          🏷 Tags
        </button>
        <button className={styles.bulkBtn}
          style={{background: panel==='folders' ? 'var(--accent)' : 'var(--bg-tertiary)', color: panel==='folders'?'#fff':'var(--text-secondary)', border:'1px solid var(--border)'}}
          onClick={() => setPanel(p => p==='folders' ? null : 'folders')}>
          📁 Folders
        </button>
        <button className={styles.bulkBtn}
          style={{background:'var(--bg-tertiary)',color:'var(--text-secondary)',border:'1px solid var(--border)'}}
          onClick={sendTo}>
          📂 Send to
        </button>
      </div>

      {/* Tags panel */}
      {panel === 'tags' && (
        <div style={{borderTop:'1px solid var(--border)',padding:'8px 12px',background:'var(--bg-secondary)'}}>
          {/* tag input */}
          <div style={{position:'relative',marginBottom:6}}>
            <div style={{display:'flex',gap:6}}>
              <input ref={tagRef} value={tagInput}
                onChange={e => { setTagInput(e.target.value); setShowSuggestions(true) }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { applyTagToAll(tagInput); setShowSuggestions(false) }
                  if (e.key === 'Escape') { setShowSuggestions(false); setTagInput('') }
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                placeholder="Type tag and press Enter…"
                list="bulk-tag-datalist"
                style={{flex:1,background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:5,padding:'4px 8px',color:'var(--text-primary)',fontSize:12,outline:'none'}} />
              <button onClick={() => { applyTagToAll(tagInput); setShowSuggestions(false) }}
                style={{background:'var(--accent)',border:'none',borderRadius:5,padding:'4px 10px',color:'#fff',fontSize:12,cursor:'pointer',whiteSpace:'nowrap'}}>
                + Add
              </button>
            </div>
            {/* suggestions dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div style={{position:'absolute',top:'100%',left:0,right:40,zIndex:200,background:'var(--bg-secondary)',border:'1px solid var(--border)',borderRadius:6,boxShadow:'0 4px 16px rgba(0,0,0,0.4)',maxHeight:160,overflowY:'auto',marginTop:2}}>
                {suggestions.map(t => (
                  <div key={t} onMouseDown={() => { applyTagToAll(t); setShowSuggestions(false) }}
                    style={{padding:'5px 10px',cursor:'pointer',fontSize:12,color: partialTags.includes(t)?'var(--text-muted)':'var(--text-primary)',display:'flex',alignItems:'center',gap:6}}
                    onMouseEnter={e => (e.currentTarget.style.background='var(--bg-tertiary)')}
                    onMouseLeave={e => (e.currentTarget.style.background='')}>
                    <span style={{flex:1}}>{t}</span>
                    {partialTags.includes(t) && <span style={{fontSize:10,color:'var(--text-muted)'}}>some</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* current common tags with remove option */}
          {commonTags.length > 0 && (
            <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
              {commonTags.map(t => (
                <span key={t} style={{display:'inline-flex',alignItems:'center',gap:3,background:'var(--accent)',color:'#fff',borderRadius:4,fontSize:11,padding:'2px 7px',fontWeight:500}}>
                  {t}
                  <button onClick={() => removeTagFromAll(t)}
                    style={{background:'none',border:'none',color:'#fff',cursor:'pointer',padding:'0 0 0 2px',fontSize:12,lineHeight:1,opacity:0.7}}>×</button>
                </span>
              ))}
              {partialTags.slice(0,8).map(t => (
                <span key={t} onClick={() => applyTagToAll(t)}
                  style={{display:'inline-flex',alignItems:'center',gap:3,background:'var(--bg-tertiary)',color:'var(--text-muted)',border:'1px dashed var(--border)',borderRadius:4,fontSize:11,padding:'2px 7px',cursor:'pointer'}}
                  title={`Add "${t}" to all selected`}>
                  {t} <span style={{fontSize:10}}>+</span>
                </span>
              ))}
            </div>
          )}
          <p style={{margin:'6px 0 0',fontSize:10.5,color:'var(--text-muted)'}}>
            Solid = on all · Dashed = on some (click to add to all)
          </p>
        </div>
      )}

      {/* Folders panel */}
      {panel === 'folders' && (
        <div style={{borderTop:'1px solid var(--border)',padding:'8px 12px',background:'var(--bg-secondary)',maxHeight:200,overflowY:'auto'}}>
          <div style={{display:'flex',flexDirection:'column',gap:3}}>
            {topFolders.map(f => {
              const hasAll = selectedAssets.every(a => a.folders.includes(f.id))
              const hasSome = !hasAll && selectedAssets.some(a => a.folders.includes(f.id))
              return (
                <label key={f.id} style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',padding:'3px 4px',borderRadius:4,fontSize:12}}
                  onMouseEnter={e => (e.currentTarget.style.background='var(--bg-tertiary)')}
                  onMouseLeave={e => (e.currentTarget.style.background='')}>
                  <input type="checkbox" checked={hasAll}
                    ref={el => { if (el) el.indeterminate = hasSome }}
                    onChange={() => toggleFolderForAll(f.id, hasAll)}
                    style={{width:14,height:14,cursor:'pointer',accentColor:'var(--accent)'}} />
                  <span style={{fontSize:14}}>{f.icon}</span>
                  <span style={{color: hasAll?'var(--text-primary)':'var(--text-secondary)'}}>{f.name}</span>
                  {hasSome && <span style={{fontSize:10,color:'var(--text-muted)',marginLeft:'auto'}}>some</span>}
                </label>
              )
            })}
            {folders.filter(f => f.parentId).map(f => {
              const parent = folders.find(p => p.id === f.parentId)
              const hasAll = selectedAssets.every(a => a.folders.includes(f.id))
              const hasSome = !hasAll && selectedAssets.some(a => a.folders.includes(f.id))
              return (
                <label key={f.id} style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',padding:'3px 4px 3px 20px',borderRadius:4,fontSize:12}}
                  onMouseEnter={e => (e.currentTarget.style.background='var(--bg-tertiary)')}
                  onMouseLeave={e => (e.currentTarget.style.background='')}>
                  <input type="checkbox" checked={hasAll}
                    ref={el => { if (el) el.indeterminate = hasSome }}
                    onChange={() => toggleFolderForAll(f.id, hasAll)}
                    style={{width:14,height:14,cursor:'pointer',accentColor:'var(--accent)'}} />
                  <span style={{fontSize:14}}>{f.icon}</span>
                  <span style={{color: hasAll?'var(--text-primary)':'var(--text-secondary)'}}>{f.name}</span>
                  {parent && <span style={{fontSize:10,color:'var(--text-muted)',marginLeft:'auto'}}>{parent.icon} {parent.name}</span>}
                  {hasSome && <span style={{fontSize:10,color:'var(--text-muted)'}}>some</span>}
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main grid ─────────────────────────────────────────────────────────────────
export default function AssetGrid({ assets, thumbnailSize }: { assets: Asset[]; thumbnailSize: number; viewMode: string }) {
  const { toggleSelectAsset, setSelectedAssetIds, selectedAssetIds, setLightboxAsset, showToast } = useStore()
  const [ctxMenu, setCtxMenu] = useState<{x:number;y:number;asset:Asset}|null>(null)
  const lastClickedId = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [contW, setContW] = useState(900)
  const [viewH, setViewH] = useState(700)
  const scrollY = useRef(0)
  const prevLen = useRef(assets.length)
  const [, tick] = useState(0)

  useEffect(() => {
    const el = scrollRef.current; if (!el) return
    const ro = new ResizeObserver(([e]) => { const r = e.contentRect; setContW(r.width); setViewH(r.height) })
    ro.observe(el); return () => ro.disconnect()
  }, [])
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => { scrollY.current = (e.target as HTMLDivElement).scrollTop; tick(n=>n+1) }, [])
  useEffect(() => {
    if (assets.length > prevLen.current && scrollY.current > 50) scrollRef.current && (scrollRef.current.scrollTop = scrollY.current)
    prevLen.current = assets.length
  }, [assets.length])

  const GAP = 8
  const { items, totalH } = useMemo(() => computeLayout(assets, thumbnailSize, GAP, contW), [assets, thumbnailSize, contW])
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])
  const visible = useMemo(() => { const t=scrollY.current-600, b=scrollY.current+viewH+600; return items.filter(i=>i.y+i.h>t&&i.y<b) }, [items, viewH, scrollY.current])

  const handleClick = useCallback((id: string, shift: boolean, ctrl: boolean) => {
    // Always use latest ordered list via ref (avoids stale closure)
    const orderedIds = itemsRef.current.map(i => i.asset.id)

    if (shift && lastClickedId.current && orderedIds.includes(lastClickedId.current)) {
      // Windows-style: select the inclusive range between anchor and clicked item.
      // Deselects anything outside that range — exactly like Windows Explorer.
      const anchorIdx = orderedIds.indexOf(lastClickedId.current)
      const clickIdx  = orderedIds.indexOf(id)
      const lo = Math.min(anchorIdx, clickIdx)
      const hi = Math.max(anchorIdx, clickIdx)
      setSelectedAssetIds(orderedIds.slice(lo, hi + 1))
      // anchor does NOT move on shift-click
    } else if (ctrl) {
      // Ctrl/Cmd+click: toggle individual item; move anchor to clicked item
      toggleSelectAsset(id, true)
      lastClickedId.current = id
    } else {
      // Plain click: select only this; if already sole selection, deselect
      const { selectedAssetIds } = useStore.getState()
      const only = selectedAssetIds.length === 1 && selectedAssetIds[0] === id
      setSelectedAssetIds(only ? [] : [id])
      lastClickedId.current = id
    }
  }, [])  // stable — reads fresh data from refs
  const handleDblClick = useCallback((a: Asset) => { setLightboxAsset(a) }, [])
  const handleCtx      = useCallback((e: React.MouseEvent, a: Asset) => { e.preventDefault(); e.stopPropagation(); if (!selectedAssetIds.includes(a.id)) setSelectedAssetIds([a.id]); setCtxMenu({x:e.clientX,y:e.clientY,asset:a}) }, [selectedAssetIds])
  const handleBg = useCallback((e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('[data-card]')) {
      setSelectedAssetIds([])
      lastClickedId.current = null
    }
  }, [])

  // Native OS drag-out to file explorer, Photoshop, browsers, etc.
  // Key rules for Electron native drag:
  // 1. e.preventDefault() — MUST cancel the HTML5 drag; if HTML5 drag starts first,
  //    it competes with the OS drag and file explorer/apps receive nothing.
  // 2. icon — REQUIRED by Electron startDrag. Without it the drag fails silently on
  //    all platforms. We pass the asset's thumbnail as the drag icon.
  // 3. sendSync — ensures startDrag is called synchronously within the drag event,
  //    before the OS has a chance to start its own drag operation.
  const handleDragStart = useCallback((e: React.DragEvent, asset: Asset) => {
    e.preventDefault()   // Cancel HTML5 drag — native drag takes over completely
    e.stopPropagation()

    const ids = selectedAssetIds.includes(asset.id) ? selectedAssetIds : [asset.id]
    const allAssets = useStore.getState().assets
    const draggedAssets = ids.map(id => allAssets.find(a => a.id === id)).filter(Boolean) as Asset[]

    // Build icon path from thumbnailData (strip file:// prefix for nativeImage)
    // Fall back to the original file path (works for images on Windows/macOS)
    const iconSrc = asset.thumbnailData
      ? asset.thumbnailData.replace(/^file:\/\//, '')
      : asset.filePath

    if (draggedAssets.length === 1) {
      ;(window as any).electronAPI?.startDragWithIcon(draggedAssets[0].filePath, iconSrc)
    } else {
      const paths = draggedAssets.map(f => f.filePath)
      ;(window as any).electronAPI?.startDragMultiWithIcon(paths, iconSrc)
    }
  }, [selectedAssetIds])

  return (
    <div className={styles.wrapper}>
      <BulkActionsBar selectedIds={selectedAssetIds} />
      <div className={styles.scroller} ref={scrollRef} onScroll={onScroll} onClick={handleBg}>
        <div style={{ position: 'relative', height: totalH }}>
          {visible.map(({ asset, x, y, w }) => (
            <div key={asset.id} data-card="1" style={{ position: 'absolute', left: x, top: y, width: w }}>
              <AssetCard asset={asset} colWidth={w} isSelected={selectedAssetIds.includes(asset.id)}
                onClick={handleClick} onDoubleClick={handleDblClick}
                onContextMenu={handleCtx} onDragStart={handleDragStart} />
            </div>
          ))}
        </div>
        {ctxMenu && <CtxMenu x={ctxMenu.x} y={ctxMenu.y} asset={ctxMenu.asset}
          selCount={selectedAssetIds.length} selIds={selectedAssetIds}
          onClose={() => setCtxMenu(null)} />}
      </div>
    </div>
  )
}
