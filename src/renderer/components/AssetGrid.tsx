import { useRef, useCallback, memo, useState, useEffect, useMemo, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import mpegts from 'mpegts.js'
import { useStore } from '../store/useStore'
import { Asset, ViewMode } from '../types'
import { extractPaletteFromImageSrc, generateId, isImage, isVideo, isAudio, isFont } from '../utils/helpers'
import { shareAssets } from '../utils/share'
import styles from './AssetGrid.module.css'
import {
  Play, Pause, Search, ExternalLink, FolderOpen, Trash2, RotateCcw, Folder,
  FileText, Archive, Palette, Box, Copy, Globe2, Download, Pencil, Files,
  ChevronRight, RefreshCw, Image as ImageIcon, Share2, Sparkles, X, Lock, Unlock,
} from 'lucide-react'

const IS_3D = (ext: string) => ['glb','gltf','obj','fbx','dae','stl'].includes(ext)
const GAP = 12
const LOAD_MORE_ITEM_THRESHOLD = 36
const THUMBNAIL_OVERSCAN = 3
const LIST_OVERSCAN = 12
const IDLE_PRELOAD_RADIUS = 18
const MAX_PRELOADED_THUMB_KEYS = 900
const CONTAINER_GUTTER = 6
const SLOW_SCROLL_IDLE_DELAY = 220
const THUMB_DPR_CAP = 1.5
const THUMB_NAME_HEIGHT = 48
const MSE_VIDEO_EXTS = new Set(['ts', 'mts', 'm2ts', 'flv'])

interface ThumbnailLabelSettings {
  showThumbnailFilename: boolean
  showThumbnailExtensionInFilename: boolean
  showThumbnailExtensionBadge: boolean
}

const DEFAULT_THUMBNAIL_LABEL_SETTINGS: ThumbnailLabelSettings = {
  showThumbnailFilename: true,
  showThumbnailExtensionInFilename: true,
  showThumbnailExtensionBadge: true,
}

function thumbnailLabelHeight(settings: ThumbnailLabelSettings) {
  return settings.showThumbnailFilename ? THUMB_NAME_HEIGHT : 0
}

function thumbnailFileLabel(asset: Asset, settings: ThumbnailLabelSettings) {
  if (!settings.showThumbnailFilename) return ''
  if (asset.ext === 'url') return asset.name
  if (settings.showThumbnailExtensionInFilename) return `${asset.name}.${asset.ext}`
  if (settings.showThumbnailFilename) return asset.name
  return ''
}

function pickGridThumb(asset: Asset, displayW: number, displayH: number) {
  const variants = asset.thumbnailVariants
  const fallback = asset.thumbnailData
  if (!variants && !fallback) return undefined
  const dpr = typeof window !== 'undefined' ? Math.min(Math.max(window.devicePixelRatio || 1, 1), THUMB_DPR_CAP) : 1
  const needed = Math.ceil(Math.max(displayW || 0, displayH || 0) * dpr)
  const choices = [
    { width: 192, src: variants?.sm },
    { width: 384, src: variants?.md },
    { width: 640, src: variants?.lg },
    { width: 768, src: fallback },
  ].filter((choice): choice is { width: number; src: string } => !!choice.src)
  return choices.find(choice => choice.width >= needed)?.src || choices[choices.length - 1]?.src
}

// ── Video thumbnail — hover preview + mouse-position scrub ────────────────────
const VideoThumb = memo(({ asset, thumbSrc }: { asset: Asset; thumbSrc?: string }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamPlayerRef = useRef<any>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const seekFrameRef = useRef<number | null>(null)
  const pendingPctRef = useRef(0)
  const durationRef = useRef(0)
  const progressRef = useRef<HTMLDivElement>(null)
  const [videoMounted, setVideoMounted] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const url = `file://${asset.filePath.replace(/\\/g, '/')}`
  const usesMpegts = MSE_VIDEO_EXTS.has(asset.ext.toLowerCase())
  const canPreview = !!thumbSrc

  useEffect(() => {
    if (usesMpegts) return
    const video = videoRef.current
    if (!video) return
    if (previewing) {
      video.playbackRate = 1.6
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [previewing, usesMpegts])

  useEffect(() => {
    if (!videoMounted || !usesMpegts || !videoRef.current) return
    let cancelled = false
    const video = videoRef.current
    const api = (window as any).electronAPI

    ;(async () => {
      try {
        const [port, durationMs] = await Promise.all([
          api?.getBridgePort?.() ?? Promise.resolve(57432),
          api?.getVideoDuration?.(asset.filePath) ?? Promise.resolve(null),
        ])
        if (cancelled || !videoRef.current || !mpegts.isSupported()) return
        durationRef.current = durationMs ? durationMs / 1000 : 0
        const player = mpegts.createPlayer({
          type: asset.ext.toLowerCase() === 'flv' ? 'flv' : 'mpegts',
          isLive: false,
          url: `http://127.0.0.1:${port}/videostream?path=${encodeURIComponent(asset.filePath)}`,
          ...(durationMs ? { duration: durationMs } : {}),
        }, {
          enableWorker: true,
          enableStashBuffer: true,
          stashInitialSize: 512 * 1024,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
          seekType: 'range',
          rangeLoadZeroStart: true,
          accurateSeek: true,
        })
        streamPlayerRef.current = player
        player.attachMediaElement(video)
        player.load()
        player.on(mpegts.Events.ERROR, () => {
          if (!cancelled) setPreviewReady(false)
        })
        video.playbackRate = 1.6
        await video.play().catch(() => {})
      } catch {
        if (!cancelled) setPreviewReady(false)
      }
    })()

    return () => {
      cancelled = true
      try { streamPlayerRef.current?.destroy() } catch {}
      streamPlayerRef.current = null
    }
  }, [asset.ext, asset.filePath, usesMpegts, videoMounted])

  useEffect(() => () => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
    if (seekFrameRef.current !== null) window.cancelAnimationFrame(seekFrameRef.current)
    videoRef.current?.pause()
    try { streamPlayerRef.current?.destroy() } catch {}
    streamPlayerRef.current = null
  }, [])

  const startHoverPreview = () => {
    if (!canPreview) return
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = window.setTimeout(() => {
      setVideoMounted(true)
      setPreviewing(true)
      setPreviewReady(false)
      hoverTimerRef.current = null
    }, 500)
  }

  const stopHoverPreview = () => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    const video = videoRef.current
    if (video) {
      video.pause()
      video.currentTime = 0
    }
    if (seekFrameRef.current !== null) {
      window.cancelAnimationFrame(seekFrameRef.current)
      seekFrameRef.current = null
    }
    if (progressRef.current) progressRef.current.style.transform = 'scaleX(0)'
    durationRef.current = 0
    setPreviewReady(false)
    setPreviewing(false)
    setVideoMounted(false)
  }

  const seekFromPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!previewing) return
    const video = videoRef.current
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)))
    pendingPctRef.current = pct
    if (seekFrameRef.current !== null) return
    seekFrameRef.current = window.requestAnimationFrame(() => {
      seekFrameRef.current = null
      const nextPct = pendingPctRef.current
      if (progressRef.current) progressRef.current.style.transform = `scaleX(${nextPct})`
      const dur = durationRef.current
      if (video && dur > 0) video.currentTime = Math.max(0, Math.min(dur - 0.04, nextPct * dur))
    })
  }

  return (
    <div
      className={`${styles.videoThumb} ${previewing && previewReady ? styles.videoThumbPreviewing : ''}`}
      onMouseEnter={startHoverPreview}
      onMouseMove={seekFromPointer}
      onMouseLeave={stopHoverPreview}
    >
      {thumbSrc
        ? <img src={thumbSrc} className={styles.fill} alt="" draggable={false} decoding="async" loading="eager" fetchPriority="high" />
        : <div className={styles.placeholder}>
            <Play size={28} strokeWidth={1.5} style={{ opacity: 0.5 }} />
            <span className={styles.typeLabel}>{asset.ext.toUpperCase()}</span>
          </div>
      }
      {videoMounted && (
        <video
          ref={videoRef}
          className={styles.hoverVideo}
          src={usesMpegts ? undefined : url}
          muted
          loop
          playsInline
          preload="metadata"
          onCanPlay={e => {
            setPreviewReady(true)
            e.currentTarget.playbackRate = 1.6
            e.currentTarget.play().catch(() => {})
          }}
          onError={() => setPreviewReady(false)}
          onLoadedMetadata={e => {
            e.currentTarget.playbackRate = 1.6
            if (!usesMpegts && Number.isFinite(e.currentTarget.duration)) {
              durationRef.current = e.currentTarget.duration
            }
          }}
        />
      )}
      {previewing && <div className={styles.videoScrubProgress}><div ref={progressRef} /></div>}
      <div className={styles.videoPlayOverlay}><Play size={14} strokeWidth={2} /></div>
    </div>
  )
}, (prev, next) => prev.asset.id === next.asset.id && prev.thumbSrc === next.thumbSrc)

const GifThumb = memo(({ asset, thumbSrc }: { asset: Asset; thumbSrc: string }) => {
  const hoverTimerRef = useRef<number | null>(null)
  const hoveringRef = useRef(false)
  const [animatedSrc, setAnimatedSrc] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => () => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
  }, [])

  const startPreview = () => {
    hoveringRef.current = true
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = window.setTimeout(async () => {
      const src = animatedSrc || await (window as any).electronAPI?.getFileUrl?.(asset.filePath)
      if (src && hoveringRef.current) {
        setAnimatedSrc(src)
        setPreviewing(true)
      }
      hoverTimerRef.current = null
    }, 350)
  }

  const stopPreview = () => {
    hoveringRef.current = false
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setPreviewing(false)
    setReady(false)
  }

  return (
    <div className={styles.gifThumb} onMouseEnter={startPreview} onMouseLeave={stopPreview}>
      <img src={thumbSrc} className={styles.fill} alt={asset.name} draggable={false} decoding="async" />
      {previewing && animatedSrc && (
        <img
          key={`${asset.id}-${previewing}`}
          src={animatedSrc}
          className={`${styles.animatedGif} ${ready ? styles.animatedGifReady : ''}`}
          alt={asset.name}
          draggable={false}
          onLoad={() => setReady(true)}
          onError={() => setReady(false)}
        />
      )}
    </div>
  )
}, (prev, next) => prev.asset.id === next.asset.id && prev.thumbSrc === next.thumbSrc)

const COLORS_3D: Record<string,string> = { glb:'#ff922b',gltf:'#ff922b',obj:'#4ecdc4',fbx:'#ff6b9d',stl:'#c7f464',dae:'#88d8b0' }

// ── 3D thumbnail — pure display ───────────────────────────────────────────────
const Model3DThumb = memo(({ asset, thumbSrc }: { asset: Asset; thumbSrc?: string }) => {
  const col = COLORS_3D[asset.ext] || '#ff922b'
  if (thumbSrc) return (
    <div className={styles.model3dThumb}>
      <img src={thumbSrc} className={styles.fill} alt="" draggable={false} decoding="async" loading="eager" fetchPriority="high" />
      <div className={styles.model3dBadge}>3D</div>
    </div>
  )
  return (
    <div className={styles.placeholder}>
      <Box size={34} color={col} strokeWidth={1.2} />
      <span style={{ fontSize: 11, fontWeight: 800, color: col, letterSpacing: '0.08em' }}>{asset.ext.toUpperCase()}</span>
      <span className={styles.typeLabel}>3D Model</span>
    </div>
  )
}, (prev, next) => prev.asset.id === next.asset.id && prev.thumbSrc === next.thumbSrc)

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
      <button className={styles.playBtn} onClick={toggle}>
        {playing ? <Pause size={12} strokeWidth={2} /> : <Play size={12} strokeWidth={2} />}
      </button>
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
        ? <div className={styles.fontSample} style={{ fontFamily: `"${fontId}"` }}>Aa</div>
        : <FileText size={32} strokeWidth={1.1} style={{ opacity: 0.4 }} />}
      <span className={styles.typeLabel}>{asset.ext.toUpperCase()}</span>
    </div>
  )
})

// Module-level cache so lines survive component unmount/remount during fast scroll
const _docLineCache = new Map<string, string[]>()

// ── Doc/text/code thumbnail ───────────────────────────────────────────────────
const DocThumb = memo(({ asset }: { asset: Asset }) => {
  const [lines, setLines] = useState<string[]>(() => _docLineCache.get(asset.id) ?? [])
  useEffect(() => {
    const textExts = ['txt','md','json','csv','xml','html','css','js','ts','jsx','tsx','py','sh','yaml','yml','log','cfg','conf','sql']
    if (!textExts.includes(asset.ext)) return
    if (_docLineCache.has(asset.id)) return   // already fetched, skip IPC
    ;(window as any).electronAPI?.readText(asset.filePath, 400).then((r: any) => {
      if (r?.text) {
        const l = r.text.split('\n').slice(0, 8).filter((l: string) => l.trim())
        _docLineCache.set(asset.id, l)
        setLines(l)
      }
    })
  }, [asset.id])

  const COLORS: Record<string,string> = {
    pdf:'var(--danger)', doc:'var(--type-doc)', docx:'var(--type-doc)',
    xls:'var(--success)', xlsx:'var(--success)', ppt:'var(--type-model)', pptx:'var(--type-model)',
    json:'var(--accent)', md:'var(--success)', py:'var(--type-doc)', js:'var(--accent)', ts:'var(--type-doc)',
    html:'var(--type-model)', css:'var(--type-doc)', sql:'var(--type-audio)', sh:'var(--success)',
    zip:'var(--type-archive)', rar:'var(--type-archive)', '7z':'var(--type-archive)',
    psd:'var(--type-doc)', ai:'var(--type-model)', epub:'var(--type-model)'
  }
  const col = COLORS[asset.ext] || 'var(--accent)'
  const ext = asset.ext.toLowerCase()

  // Lucide icon for non-text doc types
  const getDocIcon = () => {
    if (['pdf','doc','docx','txt','md'].includes(ext)) return <FileText size={36} strokeWidth={1.1} color={col} />
    if (['zip','rar','7z'].includes(ext)) return <Archive size={36} strokeWidth={1.1} color={col} />
    if (['psd','ai','fig','sketch','xd','eps'].includes(ext)) return <Palette size={36} strokeWidth={1.1} color={col} />
    if (['blend','fbx','3ds'].includes(ext)) return <Box size={36} strokeWidth={1.1} color={col} />
    return <FileText size={36} strokeWidth={1.1} color={col} />
  }

  if (!lines.length) return (
    <div className={`${styles.placeholder} ${styles.unsupportedPlaceholder}`} style={{ ['--placeholder-accent' as any]: col }}>
      <div className={styles.placeholderIconWell}>{getDocIcon()}</div>
      <span className={styles.unsupportedExt}>{asset.ext.toUpperCase()}</span>
    </div>
  )

  if (lines.length) return (
    <div className={styles.docThumb}>
      <div className={styles.docLines}>
        {lines.map((l, i) => <div key={i} className={styles.docLine} style={{ opacity: 1 - i * 0.09, fontSize: i === 0 ? 9 : 8 }}>{l}</div>)}
      </div>
      <div className={styles.docExt} style={{ color: col }}>{asset.ext.toUpperCase()}</div>
    </div>
  )

  return (
    <div className={styles.placeholder}>
      <Folder size={34} strokeWidth={1.2} style={{ opacity: 0.4 }} />
      <span className={styles.typeLabel}>{asset.ext.toUpperCase()}</span>
    </div>
  )
})

// ── Thumbnail image ───────────────────────────────────────────────────────────
const ThumbnailImage = memo(({ src, alt }: { src: string; alt: string }) => {
  const [displaySrc, setDisplaySrc] = useState(src)
  useEffect(() => {
    if (!src || src === displaySrc) return
    let cancelled = false
    const img = new window.Image()
    img.onload = () => { if (!cancelled) setDisplaySrc(src) }
    img.onerror = () => { if (!cancelled) setDisplaySrc(src) }
    img.src = src
    return () => { cancelled = true }
  }, [src, displaySrc])
  return (
    <div className={styles.thumbImageWrap}>
      <img
        src={displaySrc}
        className={`${styles.img} ${styles.imgLoaded}`}
        alt={alt}
        draggable={false}
      />
    </div>
  )
}, (prev, next) => prev.src === next.src && prev.alt === next.alt)

function ImageExportDialog({ asset, onClose, showToast }: {
  asset: Asset
  onClose: () => void
  showToast: (message: string, type?: 'success'|'error'|'info', duration?: number) => void
}) {
  const api = (window as any).electronAPI
  const [format, setFormat] = useState('png')
  const [originalSize, setOriginalSize] = useState({
    width: Math.max(0, Number(asset.width) || 0),
    height: Math.max(0, Number(asset.height) || 0),
  })
  const [width, setWidth] = useState(String(Math.max(0, Number(asset.width) || 0) || ''))
  const [height, setHeight] = useState(String(Math.max(0, Number(asset.height) || 0) || ''))
  const [locked, setLocked] = useState(true)
  const [exporting, setExporting] = useState(false)
  const ratio = originalSize.width > 0 && originalSize.height > 0
    ? originalSize.width / originalSize.height
    : 0
  const previewSource = asset.thumbnailData || `file://${asset.filePath.replace(/\\/g, '/')}`

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const updateWidth = (value: string) => {
    const clean = value.replace(/\D/g, '')
    setWidth(clean)
    if (locked && ratio && clean) setHeight(String(Math.max(1, Math.round(Number(clean) / ratio))))
  }

  const updateHeight = (value: string) => {
    const clean = value.replace(/\D/g, '')
    setHeight(clean)
    if (locked && ratio && clean) setWidth(String(Math.max(1, Math.round(Number(clean) * ratio))))
  }

  const applyPreset = (maxEdge: number) => {
    if (!ratio) return
    if (ratio >= 1) {
      setWidth(String(maxEdge))
      setHeight(String(Math.max(1, Math.round(maxEdge / ratio))))
    } else {
      setHeight(String(maxEdge))
      setWidth(String(Math.max(1, Math.round(maxEdge * ratio))))
    }
  }

  const resetSize = () => {
    setWidth(originalSize.width ? String(originalSize.width) : '')
    setHeight(originalSize.height ? String(originalSize.height) : '')
  }

  const exportImage = async () => {
    setExporting(true)
    try {
      const result = await api?.exportImageAs?.(asset.filePath, {
        format,
        width: Number(width) || 0,
        height: Number(height) || 0,
        fit: locked ? 'inside' : 'fill',
      })
      if (result?.ok) {
        showToast('Image exported', 'success')
        onClose()
      } else if (!result?.canceled) {
        showToast(result?.error || 'Image could not be exported', 'error')
      }
    } finally {
      setExporting(false)
    }
  }

  return createPortal(
    <div className={styles.exportDialogOverlay} data-image-export-dialog onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className={styles.exportDialog} role="dialog" aria-modal="true" aria-label="Export image">
        <header className={styles.exportDialogHeader}>
          <div>
            <h2>Export image</h2>
            <p>{asset.name}.{asset.ext}</p>
          </div>
          <button className={styles.exportDialogClose} onClick={onClose} aria-label="Close export dialog"><X size={18} /></button>
        </header>

        <div className={styles.exportDialogBody}>
          <div className={styles.exportPreview}>
            <img
              src={previewSource}
              alt={asset.name}
              onLoad={event => {
                if (originalSize.width && originalSize.height) return
                const image = event.currentTarget
                const next = { width: image.naturalWidth, height: image.naturalHeight }
                setOriginalSize(next)
                setWidth(String(next.width))
                setHeight(String(next.height))
              }}
            />
          </div>

          <aside className={styles.exportOptions}>
            <label className={styles.exportField}>
              <span>Format</span>
              <select value={format} onChange={event => setFormat(event.target.value)}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
                <option value="tiff">TIFF</option>
              </select>
            </label>

            <div className={styles.exportDimensionsHeader}>
              <span>Dimensions</span>
              <button onClick={() => setLocked(value => !value)} aria-label={locked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}>
                {locked ? <Lock size={13} /> : <Unlock size={13} />}
                {locked ? 'Linked' : 'Unlinked'}
              </button>
            </div>

            <div className={styles.exportDimensionRow}>
              <label className={styles.exportField}>
                <span>Width</span>
                <div><input value={width} onChange={event => updateWidth(event.target.value)} inputMode="numeric" /><em>px</em></div>
              </label>
              <span className={styles.exportDimensionTimes}>×</span>
              <label className={styles.exportField}>
                <span>Height</span>
                <div><input value={height} onChange={event => updateHeight(event.target.value)} inputMode="numeric" /><em>px</em></div>
              </label>
            </div>

            <div className={styles.exportPresets}>
              {[512, 1024, 2048, 4096].map(size => (
                <button key={size} onClick={() => applyPreset(size)}>{size}px</button>
              ))}
              <button onClick={resetSize}>Original</button>
            </div>

            <div className={styles.exportSummary}>
              <span>Output</span>
              <strong>{width || 'Original'} × {height || 'Original'} px · {format.toUpperCase()}</strong>
            </div>
          </aside>
        </div>

        <footer className={styles.exportDialogFooter}>
          <button className={styles.exportCancelButton} onClick={onClose}>Cancel</button>
          <button className={styles.exportConfirmButton} onClick={exportImage} disabled={exporting}>
            <Download size={15} />
            {exporting ? 'Exporting…' : 'Export…'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────
const CtxMenu = memo(({ x, y, asset, selCount, selIds, onClose }: any) => {
  const {
    assets, setAssets, updateAsset, renameAsset, deleteAssets, setLightboxAsset,
    restoreAssets, permanentDeleteWithPrompt, activeFolderType, showToast,
    startAiQueue, aiSettings, ollamaSessionFailed,
    aiFeatureStatus,
  } = useStore()
  const inTrash = activeFolderType === 'trash'
  const ids = selCount > 1 ? selIds : [asset.id]
  const selectedAssets: Asset[] = ids
    .map((id: string) => assets.find((candidate: Asset) => candidate.id === id))
    .filter((candidate: Asset | undefined): candidate is Asset => !!candidate)
  const selectedFiles: Asset[] = selectedAssets.filter((candidate: Asset) => candidate.ext !== 'url')
  const selectedImages: Asset[] = selectedAssets.filter((candidate: Asset) => isImage(candidate.ext))
  const isMulti = selectedAssets.length > 1
  const ref = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const flyoutAnchorRef = useRef<DOMRect | null>(null)
  const [pos, setPos] = useState<{x:number;y:number}|null>(null)
  const [flyoutPos, setFlyoutPos] = useState<{x:number;y:number}>({ x: 0, y: 0 })
  const [query, setQuery] = useState('')
  const [section, setSection] = useState<'openWith'|'export'|'copy'|'more'|null>(null)
  const [openWithApps, setOpenWithApps] = useState<Array<{ name: string; path: string; icon?: string }>>([])
  const [openWithLoading, setOpenWithLoading] = useState(false)
  const [showImageExport, setShowImageExport] = useState(false)
  const api = (window as any).electronAPI
  const matches = (...labels: string[]) => !query.trim() || labels.some(label => label.toLowerCase().includes(query.trim().toLowerCase()))
  const closeAfter = (action: () => unknown | Promise<unknown>) => {
    Promise.resolve(action()).catch(() => showToast('Action could not be completed', 'error'))
    onClose()
  }
  const copyText = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value)
    showToast(`${label} copied`, 'success')
  }
  const openFlyout = (next: 'openWith'|'export'|'copy'|'more', button: HTMLButtonElement) => {
    if (section === next) {
      setSection(null)
      return false
    }
    const rect = button.getBoundingClientRect()
    flyoutAnchorRef.current = rect
    const width = next === 'export' ? 310 : 250
    const openLeft = rect.right + width + 8 > window.innerWidth
    setFlyoutPos({
      x: openLeft ? Math.max(8, rect.left - width - 6) : rect.right + 6,
      y: Math.max(8, Math.min(rect.top, window.innerHeight - 8)),
    })
    setSection(next)
    return true
  }
  const toggleOpenWith = async (event: React.MouseEvent<HTMLButtonElement>) => {
    const opened = openFlyout('openWith', event.currentTarget)
    if (!opened) return
    if (openWithApps.length || openWithLoading) return
    setOpenWithLoading(true)
    const result = await api?.getOpenWithApps?.(asset.filePath).catch(() => null)
    setOpenWithLoading(false)
    if (result?.apps?.length) setOpenWithApps(result.apps)
    else if (result?.useSystemChooser) {
      closeAfter(() => api?.openWith?.(asset.filePath))
    }
  }
  const refreshThumbnails = async () => {
    const targets = selectedFiles
    if (!targets.length) return
    const results = await api?.generateThumbBatch?.(
      targets.map(target => ({ id: target.id, filePath: target.filePath, ext: target.ext })),
      { progressType: 'batch' },
    )
    const byId = new Map((results || []).map((result: any) => [result.id, result]))
    let refreshed = 0
    for (const target of targets) {
      const result: any = byId.get(target.id)
      if (!result?.thumbUrl) continue
      const refreshedThumb = `${result.thumbUrl}${result.thumbUrl.includes('?') ? '&' : '?'}v=${Date.now()}`
      updateAsset(target.id, {
        thumbnailData: refreshedThumb,
        thumbnailVariants: result.thumbnailVariants,
        width: result.width ?? target.width,
        height: result.height ?? target.height,
      })
      refreshed += 1
    }
    if (!refreshed) {
      showToast('Thumbnail could not be refreshed', 'error')
      return
    }
    showToast(`${refreshed} thumbnail${refreshed === 1 ? '' : 's'} refreshed`, 'success')
  }
  const reanalyzeSelectedColors = async () => {
    let analyzed = 0
    for (const target of selectedImages) {
      const source = target.thumbnailData || await api?.getFileUrl?.(target.filePath)
      const colors = await extractPaletteFromImageSrc(source)
      if (!colors.length) continue
      updateAsset(target.id, { colors })
      analyzed += 1
    }
    if (!analyzed) {
      showToast('No colours could be detected', 'error')
      return
    }
    showToast(`Colours reanalyzed for ${analyzed} image${analyzed === 1 ? '' : 's'}`, 'success')
  }
  const retagSelected = () => {
    if (!selectedImages.length) return
    if (!aiSettings.enabled) {
      showToast('Enable AI tagging in Settings first', 'error')
      return
    }
    if (ollamaSessionFailed) {
      showToast('Ollama connection failed — restart app to retry', 'error')
      return
    }
    startAiQueue(selectedImages)
    showToast(`Re-tagging ${selectedImages.length} image${selectedImages.length === 1 ? '' : 's'}…`, 'info')
  }
  const copySelectedToFolder = async (label = 'Copied') => {
    if (!selectedFiles.length) return
    const destination = await api?.selectDestFolder?.()
    if (!destination) return
    const results = await api?.copyFilesToDest?.(selectedFiles.map(target => target.filePath), destination)
    const copied = (results || []).filter((result: any) => result?.ok).length
    showToast(`${label} ${copied}/${selectedFiles.length} files`, copied === selectedFiles.length ? 'success' : 'error')
  }
  const duplicateAsset = async () => {
    if (asset.ext === 'url') {
      const duplicate = { ...asset, id: generateId(), name: `${asset.name} copy`, importTime: Date.now() }
      const inserted = await api?.dbInsertAsset?.(duplicate)
      if (inserted) setAssets([...assets, duplicate])
      showToast(inserted ? 'Asset duplicated' : 'Could not duplicate asset', inserted ? 'success' : 'error')
      return
    }
    const result = await api?.duplicateFile?.(asset.filePath)
    if (!result?.ok) {
      showToast(result?.error || 'Could not duplicate asset', 'error')
      return
    }
    const duplicate: Asset = {
      ...asset,
      id: generateId(),
      name: result.name,
      filePath: result.filePath,
      size: result.size,
      mtime: result.mtime,
      btime: result.btime,
      importTime: Date.now(),
      thumbnailData: undefined,
      thumbnailVariants: undefined,
      colors: [],
      aiEmbedded: false,
      aiTagged: false,
    }
    const inserted = await api?.dbInsertAsset?.({ ...duplicate, hasThumb: false })
    if (!inserted) {
      showToast('Could not add duplicated asset', 'error')
      return
    }
    setAssets([...assets, duplicate])
    void api?.generateThumbBatch?.([{ id: duplicate.id, filePath: duplicate.filePath, ext: duplicate.ext }], { concurrency: 1 })
    showToast('Asset duplicated', 'success')
  }
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    })
  }, [x, y, query])
  useLayoutEffect(() => {
    const flyout = flyoutRef.current
    const anchor = flyoutAnchorRef.current
    if (!section || !flyout || !anchor) return
    const bounds = flyout.getBoundingClientRect()
    const gap = 6
    const openLeft = anchor.right + bounds.width + gap + 8 > window.innerWidth
    const next = {
      x: openLeft
        ? Math.max(8, anchor.left - bounds.width - gap)
        : Math.min(window.innerWidth - bounds.width - 8, anchor.right + gap),
      y: Math.max(8, Math.min(anchor.top, window.innerHeight - bounds.height - 8)),
    }
    setFlyoutPos(current => (
      Math.abs(current.x - next.x) < 1 && Math.abs(current.y - next.y) < 1
        ? current
        : next
    ))
  }, [section, openWithLoading, openWithApps.length])
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const target = e.target as Node
      if (target instanceof Element && target.closest('[data-image-export-dialog]')) return
      if (!ref.current?.contains(target) && !flyoutRef.current?.contains(target)) onClose()
    }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <>
    <div className={styles.ctxMenu} ref={ref} style={{ left: pos?.x??x, top: pos?.y??y, visibility: pos?'visible':'hidden' }}>
      <div className={styles.ctxSearch}>
        <Search size={12} strokeWidth={1.8}/>
        <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search actions..." />
      </div>
      {!inTrash && <>
        {!isMulti && matches('preview') && <button className={styles.ctxItem} onClick={() => closeAfter(() => setLightboxAsset(asset))}><Search size={12}/> Preview</button>}
        {!isMulti && asset.ext === 'url' ? <>
          {matches('copy url') && <button className={styles.ctxItem} onClick={() => closeAfter(() => copyText(asset.url, 'URL'))}><Copy size={12}/> Copy URL</button>}
          {matches('open browser default app') && <button className={styles.ctxItem} onClick={() => closeAfter(() => api?.openExternalUrl(asset.url))}><ExternalLink size={12}/> Open in browser</button>}
        </> : !isMulti ? <>
          {matches('open default app') && <button className={styles.ctxItem} onClick={() => closeAfter(() => api?.openPath(asset.filePath))}><ExternalLink size={12}/> Open with default app</button>}
          {matches('open with application') && <button className={styles.ctxItem} onClick={toggleOpenWith}><ExternalLink size={12}/> Open with <ChevronRight size={12} className={section === 'openWith' ? styles.ctxChevronOpen : styles.ctxChevron}/></button>}
          {matches('show folder') && <button className={styles.ctxItem} onClick={() => closeAfter(() => api?.showInFolder(asset.filePath))}><FolderOpen size={12}/> Show in folder</button>}
        </> : null}
        <div className={styles.ctxDiv} />
        {matches('export computer format dimensions') && <button className={styles.ctxItem} onClick={event => openFlyout('export', event.currentTarget)}><Download size={12}/> Export <ChevronRight size={12} className={section === 'export' ? styles.ctxChevronOpen : styles.ctxChevron}/></button>}
        {matches('share') && <button className={styles.ctxItem} onClick={() => closeAfter(() => shareAssets(selectedAssets, showToast))}><Share2 size={12}/> Share{isMulti ? ` (${selectedAssets.length})` : ''}</button>}
        {!!selectedImages.length && aiFeatureStatus?.tagging.active && aiSettings.enabled && matches('ai retag tagging') && <button className={styles.ctxItem} onClick={() => closeAfter(retagSelected)}><Sparkles size={12}/> Re-tag with AI{isMulti ? ` (${selectedImages.length})` : ''}</button>}
        {!isMulti && matches('copy clipboard') && <button className={styles.ctxItem} onClick={() => closeAfter(async () => {
          const copied = asset.ext === 'url'
            ? await navigator.clipboard.writeText(asset.url).then(() => true).catch(() => false)
            : await api?.copyAssetToClipboard?.(asset.filePath)
          showToast(copied ? 'Copied to clipboard' : 'Could not copy to clipboard', copied ? 'success' : 'error')
        })}><Copy size={12}/> Copy to clipboard</button>}
        {!isMulti && matches('rename') && <button className={styles.ctxItem} onClick={() => {
          const name = window.prompt('Rename asset', asset.name)
          if (name?.trim()) closeAfter(() => renameAsset(asset.id, name))
        }}><Pencil size={12}/> Rename</button>}
        {matches('copy path folder thumbnail base64 name') && <button className={styles.ctxItem} onClick={event => openFlyout('copy', event.currentTarget)}><Copy size={12}/> Copy <ChevronRight size={12} className={section === 'copy' ? styles.ctxChevronOpen : styles.ctxChevron}/></button>}
        {!isMulti && matches('duplicate') && <button className={styles.ctxItem} onClick={() => closeAfter(duplicateAsset)}><Files size={12}/> Duplicate</button>}
        {!isMulti && isImage(asset.ext) && matches('search image google lens') && <button className={styles.ctxItem} onClick={() => closeAfter(async () => {
          window.dispatchEvent(new CustomEvent('stag:foregroundProgress', {
            detail: {
              id: 'google-lens',
              label: 'Google Lens',
              detail: `Uploading ${asset.name}.${asset.ext}`,
              color: '#62a8ff',
              indeterminate: true,
            },
          }))
          try {
            const result = await api?.googleImageSearch?.(asset.filePath)
            showToast(result?.ok ? 'Image opened in Google Lens' : result?.error || 'Google Lens upload failed', result?.ok ? 'success' : 'error', 5000)
          } finally {
            window.dispatchEvent(new CustomEvent('stag:foregroundProgress', { detail: null }))
          }
        })}><ImageIcon size={12}/> Search by image (Google)</button>}
        {!isMulti && isImage(asset.ext) && aiFeatureStatus?.dinov3.installed && aiFeatureStatus?.dinov3.enabled && matches('search image dinov3 similar ai') && <button className={styles.ctxItem} onClick={() => closeAfter(() => {
          window.dispatchEvent(new CustomEvent('stag:dinoImageSearch', {
            detail: { filePath: asset.filePath },
          }))
        })}><ImageIcon size={12}/> Find similar with DINOv3</button>}
        {matches('more refresh thumbnail reanalyze colors') && <button className={styles.ctxItem} onClick={event => openFlyout('more', event.currentTarget)}><ChevronRight size={12}/> More</button>}
        <div className={styles.ctxDiv} />
      </>}
      {inTrash ? <>
        <button className={styles.ctxItem} onClick={() => { restoreAssets(ids); onClose() }}><RotateCcw size={12} strokeWidth={1.8}/> Restore</button>
        <button className={`${styles.ctxItem} ${styles.ctxDanger}`}
          onClick={() => { permanentDeleteWithPrompt(ids); onClose() }}>
          <Trash2 size={12} strokeWidth={1.8}/> Delete permanently{selCount>1?` (${selCount})`:''}
        </button>
      </> : (
        <button className={`${styles.ctxItem} ${styles.ctxDanger}`}
          onClick={() => { deleteAssets(ids); onClose() }}>
          <Trash2 size={12} strokeWidth={1.8}/> Trash{selCount>1?` (${selCount})`:''}
        </button>
      )}
    </div>
    {section && createPortal(
      <div
        ref={flyoutRef}
        className={`${styles.ctxMenu} ${styles.ctxFlyout}`}
        style={{
          left: flyoutPos.x,
          top: flyoutPos.y,
          maxHeight: Math.max(160, window.innerHeight - flyoutPos.y - 8),
        }}
      >
        {section === 'openWith' && <>
          {openWithLoading && <div className={styles.ctxSubStatus}>Finding compatible apps...</div>}
          {!openWithLoading && openWithApps.map(application => (
            <button key={application.path} className={styles.ctxItem} onClick={() => closeAfter(() => api?.openWith(asset.filePath, application.path))}>
              {application.icon
                ? <img className={styles.ctxAppIcon} src={application.icon} alt="" />
                : <Box size={16} />}
              <span>{application.name}</span>
            </button>
          ))}
          {!openWithLoading && openWithApps.length === 0 && (
            <button className={styles.ctxItem} onClick={() => closeAfter(() => api?.openWith(asset.filePath))}>Choose another app...</button>
          )}
        </>}
        {section === 'export' && <>
          <button className={styles.ctxItem} onClick={() => closeAfter(() => isMulti ? copySelectedToFolder('Exported') : api?.exportFile(asset.filePath))}>Export to computer</button>
          {!isMulti && isImage(asset.ext) && <>
            <button className={styles.ctxItem} onClick={() => {
              setSection(null)
              setShowImageExport(true)
            }}>Export format/dimensions…</button>
          </>}
        </>}
        {section === 'copy' && <>
          {!!selectedFiles.length && <button className={styles.ctxItem} onClick={() => closeAfter(() => copySelectedToFolder())}>File{isMulti ? 's' : ''} to folder...</button>}
          {!!selectedFiles.length && <button className={styles.ctxItem} onClick={() => closeAfter(() => copyText(selectedFiles.map(target => target.filePath).join('\n'), isMulti ? 'File paths' : 'File path'))}>File path{isMulti ? 's' : ''}</button>}
          {!!selectedFiles.length && <button className={styles.ctxItem} onClick={() => closeAfter(async () => copyText((await Promise.all(selectedFiles.map(target => api?.dirname?.(target.filePath)))).join('\n'), isMulti ? 'Folder paths' : 'Folder path'))}>Folder path{isMulti ? 's' : ''}</button>}
          {!isMulti && <button className={styles.ctxItem} disabled={!asset.thumbnailData} onClick={() => closeAfter(async () => {
            const copied = await api?.copyThumbnail?.(asset.id)
            showToast(copied ? 'Thumbnail copied' : 'Could not copy thumbnail', copied ? 'success' : 'error')
          })}>Thumbnail</button>}
          {!isMulti && asset.ext !== 'url' && <button className={styles.ctxItem} onClick={() => closeAfter(async () => {
            const base64 = await api?.readBinary?.(asset.filePath)
            if (!base64) throw new Error('Could not read file')
            await copyText(base64, 'Base64')
          })}>Base64</button>}
          <button className={styles.ctxItem} onClick={() => closeAfter(() => copyText(selectedAssets.map(target => target.ext === 'url' ? target.name : `${target.name}.${target.ext}`).join('\n'), isMulti ? 'Names' : 'Name'))}>Name{isMulti ? 's' : ''}</button>
        </>}
        {section === 'more' && <>
          {!!selectedFiles.length && <button className={styles.ctxItem} onClick={() => closeAfter(refreshThumbnails)}><RefreshCw size={12}/> Refresh thumbnail{selectedFiles.length === 1 ? '' : 's'}</button>}
          {!!selectedImages.length && <button className={styles.ctxItem} onClick={() => closeAfter(reanalyzeSelectedColors)}><Palette size={12}/> Reanalyze colors{selectedImages.length > 1 ? ` (${selectedImages.length})` : ''}</button>}
        </>}
      </div>,
      document.body,
    )}
    {showImageExport && (
      <ImageExportDialog
        asset={asset}
        showToast={showToast}
        onClose={() => {
          setShowImageExport(false)
          onClose()
        }}
      />
    )}
    </>
  )
})

// ── Layout ────────────────────────────────────────────────────────────────────
function cardH(a: Asset, w: number) {
  if (a.ext === 'url') return Math.round(w * 9 / 16)
  // Preserve aspect ratio for PDF/EPUB thumbnails when actual dimensions are known.
  if ((a.ext === 'pdf' || a.ext === 'epub') && a.width && a.height && a.width > 0) {
    return Math.max(60, Math.min(Math.round((a.height / a.width) * w), w * 2.8))
  }
  if (isImage(a.ext) && a.width && a.height && a.width > 0) return Math.max(60, Math.min(Math.round(a.height / a.width * w), w * 2.8))
  if (isAudio(a.ext)) return 90
  if (isVideo(a.ext)) {
    if (a.width && a.height && a.width > 0) return Math.max(60, Math.min(Math.round(a.height / a.width * w), w * 2.8))
    return Math.round(w * 9 / 16)  // fallback before dimensions are known
  }
  if (IS_3D(a.ext))   return w
  if (isFont(a.ext))  return Math.round(w * 0.75)
  return Math.round(w * 0.85)
}
interface LI { asset: Asset; x: number; y: number; w: number; h: number }
interface JustifiedRow { items: Array<Omit<LI, 'y'>>; h: number }

function columnMetrics(viewMode: ViewMode, thumbW: number, gap: number, containerW: number) {
  if (viewMode === 'list') return { cols: 1, cardW: Math.max(0, containerW), colStep: containerW + gap }
  if (containerW < 10 || thumbW < 10) return { cols: 1, cardW: Math.max(0, containerW), colStep: containerW + gap }
  const cols = Math.max(1, Math.floor((containerW + gap) / (thumbW + gap)))
  const cardW = Math.floor((containerW - (cols - 1) * gap) / cols)
  return { cols, cardW, colStep: cardW + gap }
}

function virtualCardHeight(asset: Asset, width: number, viewMode: ViewMode, labelHeight = 0) {
  if (viewMode === 'list') return 58
  if (viewMode === 'grid') return width + labelHeight
  return cardH(asset, width) + labelHeight
}

function assetRatio(a: Asset) {
  if ((isImage(a.ext) || isVideo(a.ext) || a.ext === 'pdf' || a.ext === 'epub' || a.ext === 'url') && a.width && a.height && a.height > 0) {
    return Math.max(0.24, Math.min(a.width / a.height, 5))
  }
  if (isAudio(a.ext)) return 1.7
  if (isFont(a.ext)) return 1.35
  return 1
}

function computeJustifiedRows(assets: Asset[], targetH: number, gap: number, cW: number) {
  if (cW < 10) return [] as JustifiedRow[]
  const rows: JustifiedRow[] = []
  let row: Array<{ asset: Asset; ratio: number }> = []
  let rowRatio = 0
  const minH = Math.max(92, Math.round(targetH * 0.62))
  const maxH = Math.max(minH, Math.round(targetH * 1.22))
  const flush = (isLast: boolean) => {
    if (!row.length) return
    const gaps = gap * (row.length - 1)
    const rawH = (cW - gaps) / rowRatio
    const h = Math.round(isLast ? Math.min(targetH, rawH) : Math.max(minH, Math.min(maxH, rawH)))
    let x = 0
    const items: JustifiedRow['items'] = []
    row.forEach((entry, idx) => {
      const isRowLast = idx === row.length - 1
      const w = isRowLast ? Math.max(40, cW - x) : Math.max(40, Math.round(h * entry.ratio))
      items.push({ asset: entry.asset, x, w, h })
      x += w + gap
    })
    rows.push({ items, h })
    row = []
    rowRatio = 0
  }
  for (const asset of assets) {
    const ratio = assetRatio(asset)
    row.push({ asset, ratio })
    rowRatio += ratio
    if (rowRatio * targetH + gap * (row.length - 1) >= cW) flush(false)
  }
  flush(true)
  return rows
}

// ── Pick which thumb to show ──────────────────────────────────────────────────
const ThumbContent = memo(function ThumbContent({ asset, thumbSrc }: { asset: Asset; thumbSrc?: string }) {
  if (isAudio(asset.ext)) return <AudioThumb asset={asset} />
  if (isVideo(asset.ext)) return <VideoThumb asset={asset} thumbSrc={thumbSrc} />
  if (IS_3D(asset.ext))   return <Model3DThumb asset={asset} thumbSrc={thumbSrc} />
  if (isFont(asset.ext))  return <FontThumb asset={asset} />
  if (asset.ext === 'url' && !thumbSrc) {
    return <div className={styles.docThumb}><Globe2 size={42} strokeWidth={1.2} /><span className={styles.typeLabel}>URL</span></div>
  }
  // Images: show thumbnail when ready, skeleton while generating
  if (isImage(asset.ext)) {
    if (!thumbSrc) return <div className={styles.shimmer} />
    if (asset.ext === 'gif') return <GifThumb asset={asset} thumbSrc={thumbSrc} />
    return <ThumbnailImage src={thumbSrc} alt={asset.name} />
  }
  if (thumbSrc) return <ThumbnailImage src={thumbSrc} alt={asset.name} />
  // Documents, code, design, archives
  return <DocThumb asset={asset} />
}, (p, n) => p.asset.id === n.asset.id && p.thumbSrc === n.thumbSrc && p.asset.ext === n.asset.ext)

// ── Asset card ────────────────────────────────────────────────────────────────
const AssetCard = memo(({ asset, colWidth, cardHeight, viewMode, labelSettings, isSelected, onClick, onDoubleClick, onContextMenu }: {
  asset: Asset; colWidth: number; cardHeight: number; viewMode: ViewMode; isSelected: boolean
  labelSettings: ThumbnailLabelSettings
  onClick: (id: string, shift: boolean, ctrl: boolean) => void
  onDoubleClick: (a: Asset) => void
  onContextMenu: (e: React.MouseEvent, a: Asset) => void
}) => {
  const h = viewMode === 'masonry' ? cardH(asset, colWidth) : cardHeight
  const thumbSrc = viewMode === 'list'
    ? pickGridThumb(asset, 48, 48)
    : pickGridThumb(asset, colWidth, h)
  if (viewMode === 'list') {
    return (
      <div id={`asset-${asset.id}`}
        data-asset-id={asset.id}
        className={`${styles.listCard} ${isSelected ? styles.selected : ''}`}
        draggable
        onClick={e => onClick(asset.id, e.shiftKey, e.metaKey||e.ctrlKey)}
        onDoubleClick={() => onDoubleClick(asset)}
        onContextMenu={e => onContextMenu(e, asset)}>
        <div className={styles.listThumb}>
          <ThumbContent asset={asset} thumbSrc={thumbSrc} />
        </div>
        <div className={styles.listMeta}>
          <div className={styles.listName}>{asset.ext === 'url' ? asset.name : `${asset.name}.${asset.ext}`}</div>
          <div className={styles.listDetails}>
            <span>{asset.ext.toUpperCase()}</span>
            <span>{asset.width && asset.height ? `${asset.width} x ${asset.height}` : 'No dimensions'}</span>
            <span>{formatBytes(asset.size)}</span>
          </div>
        </div>
        {asset.rating > 0 && <div className={styles.listRating}>{'★'.repeat(asset.rating)}</div>}
      </div>
    )
  }
  const fileLabel = thumbnailFileLabel(asset, labelSettings)
  return (
    <div id={`asset-${asset.id}`}
      data-asset-id={asset.id}
      className={`${styles.card} ${styles[`${viewMode}Card`]} ${isSelected ? styles.selected : ''}`}
      style={{ width: colWidth }} draggable
      onClick={e => onClick(asset.id, e.shiftKey, e.metaKey||e.ctrlKey)}
      onDoubleClick={() => onDoubleClick(asset)}
      onContextMenu={e => onContextMenu(e, asset)}>
      <div className={styles.thumb} style={{ height: h }}>
        <ThumbContent asset={asset} thumbSrc={thumbSrc} />
        {labelSettings.showThumbnailExtensionBadge && <div className={styles.extBadge}>{asset.ext.toUpperCase()}</div>}
        {asset.rating > 0 && <div className={styles.ratingBadge}>{'★'.repeat(asset.rating)}</div>}
      </div>
      {fileLabel && (
        <div className={styles.thumbnailMeta}>
          <div className={styles.thumbnailName}>{fileLabel}</div>
        </div>
      )}
    </div>
  )
}, (p, n) => p.asset === n.asset && p.colWidth === n.colWidth && p.cardHeight === n.cardHeight && p.viewMode === n.viewMode && p.labelSettings === n.labelSettings && p.isSelected === n.isSelected)
AssetCard.displayName = 'AssetCard'

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// ── Main grid ─────────────────────────────────────────────────────────────────
interface AssetGridProps {
  assets: Asset[]
  thumbnailSize: number
  viewMode: ViewMode
  onLoadMore?: (direction: 'next' | 'prev') => void
  hasMore?: boolean
  loadingMore?: boolean
}

export default function AssetGrid({ assets, thumbnailSize, viewMode, onLoadMore, hasMore = false, loadingMore = false }: AssetGridProps) {
  const toggleSelectAsset = useStore(s => s.toggleSelectAsset)
  const setSelectedAssetIds = useStore(s => s.setSelectedAssetIds)
  const selectedAssetIds = useStore(s => s.selectedAssetIds)
  const setLightboxAsset = useStore(s => s.setLightboxAsset)
  const [ctxMenu, setCtxMenu] = useState<{x:number;y:number;asset:Asset}|null>(null)
  const lastClickedId = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [contW, setContW] = useState(0)
  const loadRequestKeyRef = useRef('')
  const hasPaintedAssetsRef = useRef(false)
  const preloadedThumbsRef = useRef(new Set<string>())
  const queuedVariantIdsRef = useRef(new Set<string>())
  const [labelSettings, setLabelSettings] = useState<ThumbnailLabelSettings>(DEFAULT_THUMBNAIL_LABEL_SETTINGS)

  useEffect(() => {
    let active = true
    ;(window as any).electronAPI?.loadSettings?.().then((settings: any) => {
      if (!active || !settings) return
      const legacyExtension = settings.showThumbnailExtension !== false
      setLabelSettings({
        showThumbnailFilename: settings.showThumbnailFilename !== false,
        showThumbnailExtensionInFilename: settings.showThumbnailExtensionInFilename ?? legacyExtension,
        showThumbnailExtensionBadge: settings.showThumbnailExtensionBadge ?? legacyExtension,
      })
    }).catch(() => {})
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent<ThumbnailLabelSettings>).detail
      if (detail) setLabelSettings(detail)
    }
    window.addEventListener('stag:thumbnailLabelSettings', onSettings)
    return () => {
      active = false
      window.removeEventListener('stag:thumbnailLabelSettings', onSettings)
    }
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current; if (!el) return
    const measureContentWidth = () => {
      const cs = window.getComputedStyle(el)
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      return Math.max(0, el.clientWidth - padX)
    }
    const applySize = (width: number) => {
      const w = Math.max(0, Math.round(width - CONTAINER_GUTTER * 2))
      setContW(prev => Math.abs(prev - w) > 1 ? w : prev)
    }
    applySize(measureContentWidth())
    const ro = new ResizeObserver(() => applySize(measureContentWidth()))
    ro.observe(el); return () => ro.disconnect()
  }, [])

  // Native drag-out: use capture on the document so preventDefault() fires in
  // the capture phase — before Chromium commits to any HTML5 drag decision.
  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      const card = (e.target as HTMLElement).closest?.('[data-asset-id]') as HTMLElement | null
      if (!card) return
      const assetId = card.dataset.assetId
      if (!assetId) return

      // Block HTML5 drag immediately — native OS drag takes over
      e.preventDefault()
      e.stopPropagation()

      const { assets, selectedAssetIds } = useStore.getState()
      const ids = selectedAssetIds.includes(assetId) ? selectedAssetIds : [assetId]
      const dragged = ids.map(id => assets.find(a => a.id === id)).filter(Boolean) as Asset[]
      if (!dragged.length) return
      if (dragged.some(asset => asset.ext === 'url')) return

      // Mark this as an internal library drag before Electron converts it into
      // an OS file drag, so the app-level import target can ignore it.
      try {
        e.dataTransfer?.setData('application/x-stag-assets', dragged.map(asset => asset.id).join(','))
        e.dataTransfer?.setData('text/x-stag-assets', dragged.map(asset => asset.id).join(','))
      } catch {}
      ;(window as any).__nativeDragOut = true
      const clearNativeDrag = () => {
        ;(window as any).__nativeDragOut = false
        ;(window as any).__nativeDragCooldownUntil = Date.now() + 1000
        useStore.getState().setDragOver(false)
        document.removeEventListener('dragend', clearNativeDrag, true)
        window.removeEventListener('mouseup', clearNativeDrag, true)
        window.removeEventListener('blur', clearNativeDrag)
      }
      document.addEventListener('dragend', clearNativeDrag, true)
      window.addEventListener('mouseup', clearNativeDrag, true)
      window.addEventListener('blur', clearNativeDrag)
      window.setTimeout(clearNativeDrag, 30000)

      const thumbFor = (a: Asset): string | undefined => {
        const td = a.thumbnailData
        if (!td) return undefined
        // file:// path → strip prefix and normalise slashes for Windows
        if (td.startsWith('file://')) return td.replace(/^file:\/\//, '').replace(/\//g, '\\')
        return undefined
      }

      if (dragged.length === 1) {
        ;(window as any).electronAPI?.startDrag(dragged[0].filePath, thumbFor(dragged[0]))
      } else {
        ;(window as any).electronAPI?.startDragMulti(
          dragged.map(a => a.filePath),
          dragged.map(thumbFor),
        )
      }
    }
    // capture:true — fires as event descends, before target/bubble handlers
    document.addEventListener('dragstart', onDragStart, { capture: true })
    return () => document.removeEventListener('dragstart', onDragStart, { capture: true })
  }, [])

  const isJustified = viewMode === 'justified'
  const isGrid = viewMode === 'grid'
  const isList = viewMode === 'list'
  const labelHeight = viewMode === 'list' ? 0 : thumbnailLabelHeight(labelSettings)
  const isRowVirtual = isJustified || isGrid || isList
  const { cols, cardW, colStep } = useMemo(
    () => columnMetrics(viewMode, thumbnailSize, GAP, contW),
    [viewMode, thumbnailSize, contW],
  )
  const justifiedRows = useMemo(
    () => isJustified ? computeJustifiedRows(assets, thumbnailSize, GAP, contW) : [],
    [assets, thumbnailSize, contW, isJustified],
  )
  const justifiedRowByAssetId = useMemo(() => {
    const rows = new Map<string, number>()
    justifiedRows.forEach((row, rowIndex) => row.items.forEach(item => rows.set(item.asset.id, rowIndex)))
    return rows
  }, [justifiedRows])
  const justifiedItemByAssetId = useMemo(() => {
    const items = new Map<string, { w: number; h: number }>()
    justifiedRows.forEach(row => row.items.forEach(item => items.set(item.asset.id, { w: item.w, h: item.h })))
    return items
  }, [justifiedRows])
  const assetIndexById = useMemo(() => {
    const indexes = new Map<string, number>()
    assets.forEach((asset, index) => indexes.set(asset.id, index))
    return indexes
  }, [assets])
  const gridRowCount = isGrid ? Math.ceil(assets.length / Math.max(1, cols)) : 0
  const virtualCount = isGrid ? gridRowCount : isJustified ? justifiedRows.length : assets.length
  const estimateVirtualSize = useCallback((index: number) => {
    if (isGrid) return cardW + labelHeight
    if (isList) return 58
    if (isJustified) return (justifiedRows[index]?.h ?? thumbnailSize) + labelHeight
    const asset = assets[index]
    return asset ? virtualCardHeight(asset, cardW, viewMode, labelHeight) : thumbnailSize + labelHeight
  }, [assets, cardW, isGrid, isJustified, isList, justifiedRows, labelHeight, thumbnailSize, viewMode])
  const getVirtualItemKey = useCallback((index: number) => {
    if (isGrid) return `grid-row-${index}:${assets[index * Math.max(1, cols)]?.id ?? ''}`
    if (isJustified) return justifiedRows[index]?.items[0]?.asset.id ?? `row-${index}`
    return assets[index]?.id ?? index
  }, [assets, cols, isGrid, isJustified, justifiedRows])

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimateVirtualSize,
    getItemKey: getVirtualItemKey,
    gap: GAP,
    lanes: isRowVirtual ? 1 : cols,
    overscan: viewMode === 'list' ? LIST_OVERSCAN : THUMBNAIL_OVERSCAN,
    isScrollingResetDelay: 220,
    useScrollendEvent: true,
    useAnimationFrameWithResizeObserver: true,
    useFlushSync: false,
  })

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [virtualizer, labelHeight, cardW, viewMode, justifiedRows])

  const virtualItems = virtualizer.getVirtualItems()
  const firstVirtualIndex = virtualItems[0]?.index ?? -1
  const lastVirtualIndex = virtualItems[virtualItems.length - 1]?.index ?? -1
  const totalH = virtualizer.getTotalSize()
  const surfaceW = contW + CONTAINER_GUTTER * 2
  const surfaceH = totalH + CONTAINER_GUTTER * 2
  const isScrolling = virtualizer.isScrolling
  const allowIntroAnimation = !hasPaintedAssetsRef.current && assets.length > 0
  useEffect(() => {
    if (assets.length > 0) hasPaintedAssetsRef.current = true
  }, [assets.length])

  // O(1) selection lookup — avoids O(n) Array.includes on every card render
  const selectedSet = useMemo(() => new Set(selectedAssetIds), [selectedAssetIds])

  useEffect(() => {
    loadRequestKeyRef.current = ''
  }, [assets.length, assets[0]?.id, assets[assets.length - 1]?.id, viewMode])

  useEffect(() => {
    if (!onLoadMore || loadingMore || firstVirtualIndex < 0 || lastVirtualIndex < 0) return
    const loadMoreThreshold = isGrid
      ? Math.max(2, Math.ceil(LOAD_MORE_ITEM_THRESHOLD / Math.max(1, cols)))
      : LOAD_MORE_ITEM_THRESHOLD
    const request = (direction: 'next' | 'prev') => {
      const key = `${direction}:${assets[0]?.id ?? ''}:${assets[assets.length - 1]?.id ?? ''}:${assets.length}`
      if (loadRequestKeyRef.current === key) return
      loadRequestKeyRef.current = key
      onLoadMore(direction)
    }
    if (hasMore && lastVirtualIndex >= virtualCount - loadMoreThreshold) {
      request('next')
    } else if (firstVirtualIndex <= loadMoreThreshold) {
      request('prev')
    }
  }, [assets, cols, firstVirtualIndex, hasMore, isGrid, lastVirtualIndex, loadingMore, onLoadMore, virtualCount])

  useEffect(() => {
    if (isScrolling || firstVirtualIndex < 0 || lastVirtualIndex < 0 || !assets.length) return
    const preloadVisibleNeighborhood = () => {
      const missingVariantIds: string[] = []
      let visibleStart = firstVirtualIndex
      let visibleEnd = lastVirtualIndex
      if (isGrid) {
        visibleStart = firstVirtualIndex * Math.max(1, cols)
        visibleEnd = ((lastVirtualIndex + 1) * Math.max(1, cols)) - 1
      } else if (isJustified) {
        const firstAsset = justifiedRows[firstVirtualIndex]?.items[0]?.asset
        const lastRowItems = justifiedRows[lastVirtualIndex]?.items
        const lastAsset = lastRowItems?.[lastRowItems.length - 1]?.asset
        const firstIdx = firstAsset ? assetIndexById.get(firstAsset.id) ?? -1 : -1
        const lastIdx = lastAsset ? assetIndexById.get(lastAsset.id) ?? -1 : -1
        visibleStart = firstIdx >= 0 ? firstIdx : 0
        visibleEnd = lastIdx >= 0 ? lastIdx : visibleStart
      }
      const start = Math.max(0, visibleStart - IDLE_PRELOAD_RADIUS)
      const end = Math.min(assets.length - 1, visibleEnd + IDLE_PRELOAD_RADIUS)
      for (let i = start; i <= end; i++) {
        const asset = assets[i]
        if (!asset) continue
        let preloadW = cardW
        let preloadH = viewMode === 'grid' ? cardW : cardH(asset, cardW)
        if (isList) {
          preloadW = 48
          preloadH = 48
        } else if (isJustified) {
          const item = justifiedItemByAssetId.get(asset.id)
          preloadW = item?.w ?? thumbnailSize
          preloadH = item?.h ?? thumbnailSize
        }
        if (
          asset.thumbnailData &&
          (!asset.thumbnailVariants?.sm || !asset.thumbnailVariants?.md || !asset.thumbnailVariants?.lg) &&
          !queuedVariantIdsRef.current.has(asset.id)
        ) {
          queuedVariantIdsRef.current.add(asset.id)
          missingVariantIds.push(asset.id)
        }
        if (i >= visibleStart && i <= visibleEnd) continue
        const src = pickGridThumb(asset, preloadW, preloadH)
        if (!src || preloadedThumbsRef.current.has(src)) continue
        preloadedThumbsRef.current.add(src)
        if (preloadedThumbsRef.current.size > MAX_PRELOADED_THUMB_KEYS) {
          const oldest = preloadedThumbsRef.current.values().next().value
          if (oldest) preloadedThumbsRef.current.delete(oldest)
        }
        const img = new window.Image()
        img.src = src
      }
      if (missingVariantIds.length) {
        const queuePromise = (window as any).electronAPI?.queueThumbVariants?.(missingVariantIds, { notify: true })
        queuePromise?.catch?.(() => {
          for (const id of missingVariantIds) queuedVariantIdsRef.current.delete(id)
        })
      }
    }
    let cancelled = false
    let idleId: any = null
    const requestIdle = (window as any).requestIdleCallback
    const cancelIdle = (window as any).cancelIdleCallback
    const settleTimer = window.setTimeout(() => {
      if (cancelled) return
      if (requestIdle) {
        idleId = requestIdle(() => {
          if (!cancelled) preloadVisibleNeighborhood()
        }, { timeout: 900 })
      } else {
        idleId = window.setTimeout(() => {
          if (!cancelled) preloadVisibleNeighborhood()
        }, 120)
      }
    }, SLOW_SCROLL_IDLE_DELAY)
    return () => {
      cancelled = true
      window.clearTimeout(settleTimer)
      if (idleId !== null) {
        if (requestIdle) cancelIdle?.(idleId)
        else window.clearTimeout(idleId)
      }
    }
  }, [assetIndexById, assets, cardW, cols, firstVirtualIndex, isGrid, isJustified, isList, isScrolling, justifiedItemByAssetId, justifiedRows, lastVirtualIndex, thumbnailSize, viewMode])

  const scrollToAssetIndex = useCallback((index: number) => {
    if (index < 0) return
    if (isGrid) {
      virtualizer.scrollToIndex(Math.floor(index / Math.max(1, cols)), { align: 'auto' })
      return
    }
    if (isJustified) {
      const assetId = assets[index]?.id
      const rowIndex = assetId ? justifiedRowByAssetId.get(assetId) : undefined
      virtualizer.scrollToIndex(rowIndex ?? 0, { align: 'auto' })
      return
    }
    virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [assets, cols, isGrid, isJustified, justifiedRowByAssetId, virtualizer])

  // Arrow-key navigation follows asset order and lets TanStack Virtual perform the scroll.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown'].includes(e.key)) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const { selectedAssetIds, lightboxAsset } = useStore.getState()
      if (lightboxAsset || selectedAssetIds.length !== 1) return

      if (!assets.length) return

      const curId   = selectedAssetIds[0]
      const curIdx = assets.findIndex(a => a.id === curId)
      if (curIdx === -1) return

      e.preventDefault()

      const step = e.key === 'ArrowDown' ? Math.max(1, cols)
        : e.key === 'ArrowUp' ? -Math.max(1, cols)
        : e.key === 'ArrowRight' ? 1
        : -1
      const targetIdx = Math.max(0, Math.min(assets.length - 1, curIdx + step))
      if (targetIdx === curIdx) return
      useStore.getState().setSelectedAssetIds([assets[targetIdx].id])
      scrollToAssetIndex(targetIdx)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [assets, cols, scrollToAssetIndex])

  const handleClick = useCallback((id: string, shift: boolean, ctrl: boolean) => {
    if (shift && lastClickedId.current) {
      const orderedIds = assets.map(a => a.id)
      if (!orderedIds.includes(lastClickedId.current)) return
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
  }, [assets, setSelectedAssetIds, toggleSelectAsset])
  const handleDblClick = useCallback((a: Asset) => { setLightboxAsset(a) }, [])
  const handleCtx      = useCallback((e: React.MouseEvent, a: Asset) => { e.preventDefault(); e.stopPropagation(); if (!selectedAssetIds.includes(a.id)) setSelectedAssetIds([a.id]); setCtxMenu({x:e.clientX,y:e.clientY,asset:a}) }, [selectedAssetIds])
  const handleBg = useCallback((e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('[data-card]')) {
      setSelectedAssetIds([])
      lastClickedId.current = null
    }
  }, [])


  return (
    <div className={styles.wrapper}>
      <div className={`${styles.scroller} ${isScrolling ? styles.virtualScrolling : ''}`} ref={scrollRef} onClick={handleBg}>
        <div className={`${styles.layoutSurface} ${styles[`${viewMode}Surface`]}`} style={{ height: surfaceH, width: surfaceW }}>
          {isJustified ? virtualItems.map((rowVirtual, rowRenderIndex) => {
            const row = justifiedRows[rowVirtual.index]
            if (!row) return null
            return row.items.map(({ asset, x, w, h }, itemIndex) => (
              <div key={asset.id} data-card="1" style={{
                position: 'absolute', left: 0, top: 0, width: w,
                transform: `translate3d(${x + CONTAINER_GUTTER}px, ${rowVirtual.start + CONTAINER_GUTTER}px, 0)`,
                '--card-delay': allowIntroAnimation && rowRenderIndex < 4 ? `${Math.min(rowRenderIndex + itemIndex, 14) * 18}ms` : '0ms',
                '--card-anim-duration': allowIntroAnimation && rowRenderIndex < 4 ? '0.3s' : '0s',
              } as React.CSSProperties}>
                <AssetCard asset={asset} colWidth={w} cardHeight={h} viewMode={viewMode} isSelected={selectedSet.has(asset.id)}
                  labelSettings={labelSettings}
                  onClick={handleClick} onDoubleClick={handleDblClick}
                  onContextMenu={handleCtx} />
              </div>
            ))
          }) : isGrid ? virtualItems.map((rowVirtual, rowRenderIndex) => {
            const rowStart = rowVirtual.index * Math.max(1, cols)
            return assets.slice(rowStart, rowStart + Math.max(1, cols)).map((asset, itemIndex) => {
              const x = itemIndex * colStep
              return (
                <div key={asset.id} data-card="1" style={{
                  position: 'absolute', left: 0, top: 0, width: cardW,
                  transform: `translate3d(${x + CONTAINER_GUTTER}px, ${rowVirtual.start + CONTAINER_GUTTER}px, 0)`,
                  '--card-delay': allowIntroAnimation && rowRenderIndex < 4 ? `${Math.min(rowRenderIndex + itemIndex, 14) * 18}ms` : '0ms',
                  '--card-anim-duration': allowIntroAnimation && rowRenderIndex < 4 ? '0.3s' : '0s',
                } as React.CSSProperties}>
                  <AssetCard asset={asset} colWidth={cardW} cardHeight={cardW} viewMode={viewMode} isSelected={selectedSet.has(asset.id)}
                    labelSettings={labelSettings}
                    onClick={handleClick} onDoubleClick={handleDblClick}
                    onContextMenu={handleCtx} />
                </div>
              )
            })
          }) : virtualItems.map((item, renderIndex) => {
            const asset = assets[item.index]
            if (!asset) return null
            const x = item.lane * colStep
            return (
              <div key={asset.id} data-card="1" style={{
                position: 'absolute', left: 0, top: 0, width: cardW,
                transform: `translate3d(${x + CONTAINER_GUTTER}px, ${item.start + CONTAINER_GUTTER}px, 0)`,
                '--card-delay': allowIntroAnimation && renderIndex < 14 ? `${renderIndex * 18}ms` : '0ms',
                '--card-anim-duration': allowIntroAnimation && renderIndex < 14 ? '0.3s' : '0s',
              } as React.CSSProperties}>
                <AssetCard asset={asset} colWidth={cardW} cardHeight={item.size} viewMode={viewMode} isSelected={selectedSet.has(asset.id)}
                  labelSettings={labelSettings}
                  onClick={handleClick} onDoubleClick={handleDblClick}
                  onContextMenu={handleCtx} />
              </div>
            )
          })}
          {loadingMore && (
            <div style={{
              position: 'absolute', left: 0, right: 0, bottom: 16,
              display: 'flex', justifyContent: 'center', pointerEvents: 'none',
              color: 'var(--text-muted)', fontSize: 12,
            }}>
              Loading more...
            </div>
          )}
        </div>
      </div>
      {ctxMenu && <CtxMenu x={ctxMenu.x} y={ctxMenu.y} asset={ctxMenu.asset}
        selCount={selectedAssetIds.length} selIds={selectedAssetIds}
        onClose={() => setCtxMenu(null)} />}
    </div>
  )
}
