import { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { Asset } from '../types'
import { formatSize, formatDate, extractColors, rgbToHex, isImage, isVideo, isAudio, isFont, is3D, isDoc } from '../utils/helpers'
import styles from './Inspector.module.css'

function StarRating({ rating, onChange }: { rating: number; onChange: (r: number) => void }) {
  const [hov, setHov] = useState(0)
  return (
    <div className={styles.stars}>
      {[1,2,3,4,5].map(s => (
        <span key={s} className={`${styles.star} ${s<=(hov||rating)?styles.starFilled:''}`}
          onMouseEnter={()=>setHov(s)} onMouseLeave={()=>setHov(0)}
          onClick={()=>onChange(s===rating?0:s)}>★</span>
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
              <span style={{color:f.color}}>{f.icon}</span> {f.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Thumb for ANY file type in the inspector panel ────────────────────────────
function InspectorThumb({ asset }: { asset: Asset }) {
  const [fontLoaded, setFontLoaded] = useState(false)
  const fontId = `ins_font_${asset.id}`

  // Load font preview
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

  // Image — show thumbnail
  if (isImage(asset.ext) && asset.thumbnailData) {
    return <img src={asset.thumbnailData} className={styles.previewImg} alt="" />
  }
  // Video — show thumbnail if available
  if (isVideo(asset.ext) && asset.thumbnailData) {
    return (
      <div className={styles.previewThumbWrap}>
        <img src={asset.thumbnailData} className={styles.previewImg} alt="" />
        <div className={styles.previewPlayBadge}>▶</div>
      </div>
    )
  }
  // 3D — show thumbnail if available
  if (is3D(asset.ext) && asset.thumbnailData) {
    return (
      <div className={styles.previewThumbWrap}>
        <img src={asset.thumbnailData} className={styles.previewImg} alt="" />
        <div className={styles.preview3DBadge}>3D</div>
      </div>
    )
  }
  // Audio — waveform bars
  if (isAudio(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a1e2e,#0f1118)' }}>
        <div className={styles.miniWave}>
          {[4,8,6,10,5,9,7,11,6,8,4,7,10,5,8].map((h,i) => (
            <div key={i} style={{ height: h*3, width: 3, background: 'var(--accent)', borderRadius: 2, opacity: 0.7 }} />
          ))}
        </div>
        <span className={styles.previewTypeLabel}>🎵 {asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  // Font — show sample text
  if (isFont(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: '#fafafa' }}>
        {fontLoaded
          ? <div style={{ fontFamily: `"${fontId}"`, fontSize: 32, color: '#111', lineHeight:1 }}>Aa</div>
          : <span className={styles.bigPlaceholderIcon}>🔤</span>}
        <span className={styles.previewTypeLabel} style={{color:'#666'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  // PDF — show first-page icon with doc style
  if (asset.ext === 'pdf') {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a0a0a,#2a1010)' }}>
        <span className={styles.bigPlaceholderIcon}>📄</span>
        <span className={styles.previewTypeLabel} style={{color:'#e05252'}}>PDF</span>
      </div>
    )
  }
  // Code / text
  if (['txt','md','json','csv','xml','html','css','js','ts','jsx','tsx','py','sh'].includes(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#0a1a0a,#101810)' }}>
        <span className={styles.bigPlaceholderIcon}>📃</span>
        <span className={styles.previewTypeLabel} style={{color:'#6bcb77'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  // Design
  if (['psd','ai','fig','sketch','xd','eps','afdesign'].includes(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a0a1a,#210d21)' }}>
        <span className={styles.bigPlaceholderIcon}>🎨</span>
        <span className={styles.previewTypeLabel} style={{color:'#a259ff'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  // 3D no thumbnail yet
  if (is3D(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a1008,#221508)' }}>
        <span className={styles.bigPlaceholderIcon}>⬡</span>
        <span className={styles.previewTypeLabel} style={{color:'#ff922b'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  // Video no thumbnail yet
  if (isVideo(asset.ext)) {
    return (
      <div className={styles.previewIconBox} style={{ background: 'linear-gradient(135deg,#1a0808,#200d0d)' }}>
        <span className={styles.bigPlaceholderIcon}>🎬</span>
        <span className={styles.previewTypeLabel} style={{color:'#ff6b6b'}}>{asset.ext.toUpperCase()}</span>
      </div>
    )
  }
  // Fallback
  return (
    <div className={styles.previewIconBox}>
      <span className={styles.bigPlaceholderIcon}>📁</span>
      <span className={styles.previewTypeLabel}>{asset.ext.toUpperCase()}</span>
    </div>
  )
}

// ── Main inspector ────────────────────────────────────────────────────────────
export default function Inspector() {
  const { assets, selectedAssetIds, updateAsset, folders, tags: allTags, addTag, showToast, setLightboxAsset } = useStore()
  const [newTag, setNewTag] = useState('')
  const [editName, setEditName] = useState(false)
  const [nameVal, setNameVal] = useState('')
  const [copiedColor, setCopiedColor] = useState<string|null>(null)

  const asset: Asset|null = selectedAssetIds.length===1 ? assets.find(a=>a.id===selectedAssetIds[0])||null : null
  useEffect(() => { if (asset) { setNameVal(asset.name); setEditName(false) } }, [asset?.id])

  const saveName = () => {
    if (nameVal.trim() && nameVal.trim() !== asset?.name) updateAsset(asset!.id, { name: nameVal.trim() })
    setEditName(false)
  }
  const handleAddTag = (e: React.KeyboardEvent) => {
    if (e.key!=='Enter' || !newTag.trim()) return
    const tag = newTag.trim()
    if (asset && !asset.tags.includes(tag)) { updateAsset(asset.id, { tags:[...asset.tags,tag] }); addTag(tag) }
    setNewTag('')
  }
  const handleColorClick = (hex: string) => {
    navigator.clipboard?.writeText(hex).then(() => { setCopiedColor(hex); showToast(`Colour ${hex} copied!`,'success'); setTimeout(()=>setCopiedColor(null),1500) })
  }
  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    if (!asset) return
    if (!asset.colors.length) {
      try {
        const cols = extractColors(e.currentTarget).map((hex,i) => ({ hex: rgbToHex(hex), ratio:[0.35,0.25,0.2,0.12,0.08][i]||0.05 }))
        if (cols.length) updateAsset(asset.id, { colors: cols })
      } catch {}
    }
    if (!asset.width || !asset.height) updateAsset(asset.id, { width:e.currentTarget.naturalWidth, height:e.currentTarget.naturalHeight })
  }, [asset])

  if (!asset) return (
    <div className={styles.panel}>
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>🔍</div>
        <p>{selectedAssetIds.length>1?`${selectedAssetIds.length} items selected`:'Select an asset'}</p>
      </div>
    </div>
  )

  const getFolderName = (id: string) => folders.find(f=>f.id===id)?.name||id

  return (
    <div className={styles.panel}>
      {/* Clickable preview box */}
      <div className={styles.previewBox} onClick={() => setLightboxAsset(asset)} title="Click to preview">
        <InspectorThumb asset={asset} />
        <div className={styles.previewHoverOverlay}>🔍 Preview</div>
      </div>

      {/* Colour palette for images */}
      {asset.colors.length>0 && isImage(asset.ext) && (
        <div className={styles.palette}>
          {asset.colors.map((c,i) => (
            <div key={i} className={styles.swatchWrap} title={c.hex}>
              <div className={`${styles.swatch} ${copiedColor===c.hex?styles.swatchCopied:''}`}
                style={{background:c.hex}} onClick={()=>handleColorClick(c.hex)} />
              <span className={styles.swatchHex}>{c.hex}</span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.body}>
        {editName
          ? <input className={styles.nameInput} value={nameVal} onChange={e=>setNameVal(e.target.value)}
              onBlur={saveName} autoFocus onKeyDown={e=>{if(e.key==='Enter')saveName();if(e.key==='Escape')setEditName(false)}} />
          : <div className={styles.nameLabel} onClick={()=>setEditName(true)} title="Click to rename">{asset.name}</div>}

        <StarRating rating={asset.rating} onChange={r=>updateAsset(asset.id,{rating:r})} />
        <textarea className={styles.notes}
          placeholder="Add notes…"
          value={asset.notes || asset.aiDescription || ''}
          style={!asset.notes && asset.aiDescription ? {color:'var(--text-muted)'} : undefined}
          onChange={e => {
            // If user starts editing while only aiDescription is shown,
            // the textarea value already contains aiDescription as the starting point
            updateAsset(asset.id, {notes: e.target.value})
          }}
          onFocus={e => {
            // When user focuses and only aiDescription is displayed (notes empty),
            // seed notes with aiDescription so cursor position is correct
            if (!asset.notes && asset.aiDescription) {
              updateAsset(asset.id, {notes: asset.aiDescription})
              // Move cursor to end
              const el = e.target
              requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = el.value.length })
            }
          }} />

        <div className={styles.section}>
          <div className={styles.secLabel}>Tags</div>
          <div className={styles.chips}>
            {asset.tags.map(t=>(
              <span key={t} className={styles.chip}>{t}
                <button className={styles.chipX} onClick={()=>updateAsset(asset.id,{tags:asset.tags.filter(x=>x!==t)})}>×</button>
              </span>
            ))}
            <input className={styles.tagInput} placeholder="Tag, Enter…" value={newTag}
              onChange={e=>setNewTag(e.target.value)} onKeyDown={handleAddTag} list="inspector-tag-list" />
            <datalist id="inspector-tag-list">
              {allTags.filter(t=>!asset.tags.includes(t)).map(t=><option key={t} value={t}/>)}
            </datalist>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.secLabel}>Folders</div>
          <div className={styles.chips}>
            {asset.folders.map(fid=>(
              <span key={fid} className={`${styles.chip} ${styles.fchip}`}>📁 {getFolderName(fid)}
                <button className={styles.chipX} onClick={()=>updateAsset(asset.id,{folders:asset.folders.filter(f=>f!==fid)})}>×</button>
              </span>
            ))}
            <FolderPicker excludeIds={asset.folders} onSelect={fid=>updateAsset(asset.id,{folders:[...asset.folders,fid]})} />
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.secLabel}>Properties</div>
          <div className={styles.props}>
            {asset.width&&asset.height&&<Prop k="Dimensions" v={`${asset.width} × ${asset.height}`}/>}
            <Prop k="Size" v={formatSize(asset.size)}/>
            <Prop k="Type" v={asset.ext.toUpperCase()}/>
            <Prop k="Imported" v={formatDate(asset.importTime)}/>
            <Prop k="Modified" v={formatDate(asset.mtime)}/>
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        <button className={styles.footBtn} onClick={()=>(window as any).electronAPI?.showInFolder(asset.filePath)}>📂 Show</button>
        <button className={styles.footBtn} onClick={()=>(window as any).electronAPI?.openPath(asset.filePath)}>↗ Open</button>
      </div>
    </div>
  )
}

function Prop({ k, v }: { k:string; v:string }) {
  return <div className={styles.propRow}><span className={styles.propK}>{k}</span><span className={styles.propV}>{v}</span></div>
}
