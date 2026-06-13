import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store/useStore'
import type { Asset, SearchField, ViewMode } from '../types'
import styles from './TitleBar.module.css'
import SettingsPanel from './SettingsPanel'
import { createRendererLogger } from '../utils/logger'
import {
  Search, SlidersHorizontal, ArrowUpDown, Filter, Bot, Sun, Moon,
  X, Minus, Maximize2, Database, Eye, EyeOff, Settings,
  ChevronDown, GalleryHorizontalEnd, Grid3X3, LayoutGrid, List, FileImage, ImagePlus,
} from 'lucide-react'

const CONTACT_SHEET_IMAGE_EXTS = new Set(['jpg','jpeg','jpe','jfif','png','gif','webp','svg','bmp','ico','avif'])
const log = createRendererLogger('title-bar')

function loadSheetImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    if (!src) { resolve(null); return }
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

function contactSheetSource(asset: Asset) {
  if (asset.thumbnailVariants?.md) return asset.thumbnailVariants.md
  if (asset.thumbnailData) return asset.thumbnailData
  if (CONTACT_SHEET_IMAGE_EXTS.has(asset.ext.toLowerCase())) return `file://${asset.filePath.replace(/\\/g, '/')}`
  return ''
}

async function buildContactSheet(assets: Asset[]) {
  const items = assets.slice(0, 120)
  const cols = items.length <= 6 ? 3 : items.length <= 24 ? 4 : 5
  const pad = 48
  const gap = 20
  const thumbW = 300
  const thumbH = 210
  const labelH = 48
  const headerH = 116
  const rows = Math.max(1, Math.ceil(items.length / cols))
  const width = pad * 2 + cols * thumbW + (cols - 1) * gap
  const height = headerH + pad + rows * (thumbH + labelH + gap)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#12100f'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#f4eee7'
  ctx.font = '700 34px Inter, system-ui, sans-serif'
  ctx.fillText('Stag Contact Sheet', pad, 58)
  ctx.fillStyle = 'rgba(244,238,231,0.62)'
  ctx.font = '500 17px Inter, system-ui, sans-serif'
  ctx.fillText(`${items.length} selected asset${items.length === 1 ? '' : 's'}${assets.length > items.length ? `, first ${items.length} shown` : ''}`, pad, 88)

  for (let i = 0; i < items.length; i++) {
    const asset = items[i]
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = pad + col * (thumbW + gap)
    const y = headerH + row * (thumbH + labelH + gap)

    ctx.fillStyle = '#1b1816'
    ctx.fillRect(x, y, thumbW, thumbH)
    ctx.strokeStyle = 'rgba(244,238,231,0.12)'
    ctx.strokeRect(x + 0.5, y + 0.5, thumbW - 1, thumbH - 1)

    const img = await loadSheetImage(contactSheetSource(asset))
    if (img) {
      const scale = Math.min(thumbW / img.naturalWidth, thumbH / img.naturalHeight)
      const w = Math.max(1, img.naturalWidth * scale)
      const h = Math.max(1, img.naturalHeight * scale)
      ctx.drawImage(img, x + (thumbW - w) / 2, y + (thumbH - h) / 2, w, h)
    } else {
      ctx.fillStyle = 'rgba(192,91,42,0.18)'
      ctx.fillRect(x + 86, y + 58, 128, 82)
      ctx.fillStyle = '#d7a07c'
      ctx.font = '800 24px Inter, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(asset.ext.toUpperCase(), x + thumbW / 2, y + 108)
      ctx.textAlign = 'left'
    }

    ctx.fillStyle = '#f4eee7'
    ctx.font = '600 15px Inter, system-ui, sans-serif'
    const label = `${asset.name}.${asset.ext}`
    ctx.fillText(label.length > 36 ? `${label.slice(0, 34)}...` : label, x, y + thumbH + 24)
    ctx.fillStyle = 'rgba(244,238,231,0.48)'
    ctx.font = '500 12px Inter, system-ui, sans-serif'
    const size = asset.size ? `${(asset.size / 1024 / 1024).toFixed(asset.size > 10485760 ? 0 : 1)} MB` : asset.ext.toUpperCase()
    ctx.fillText(size, x, y + thumbH + 43)
  }

  return canvas.toDataURL('image/png')
}

function FilterPanel({ onClose }: { onClose: () => void }) {
  const {
    filterRating, setFilterRating, filterExts, toggleFilterExt, clearFilters,
    sensitiveTags, showSensitiveContent,
  } = useStore()
  const [extensionCounts, setExtensionCounts] = useState<Record<string, number>>({})
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => {
    let active = true
    const refreshExtensions = async () => {
      const counts = await (window as any).electronAPI?.dbGetCounts?.({
        sensitiveTags,
        showSensitiveContent,
      }).catch(() => null)
      if (active && counts?.extensions) setExtensionCounts(counts.extensions)
    }
    void refreshExtensions()
    const onAssetsMutated = () => { void refreshExtensions() }
    window.addEventListener('stag:assets-mutated', onAssetsMutated)
    return () => {
      active = false
      window.removeEventListener('stag:assets-mutated', onAssetsMutated)
    }
  }, [sensitiveTags, showSensitiveContent])

  const hasFilters = filterRating > 0 || filterExts.length > 0
  const availableExtensions = Object.entries(extensionCounts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))

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
          {availableExtensions.map(([ext, count]) => (
            <button key={ext}
              className={`${styles.extBtn} ${filterExts.includes(ext) ? styles.active : ''}`}
              onClick={() => toggleFilterExt(ext)}>
              <span>{ext}</span>
              <span className={styles.extCount}>{count}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const SORT_OPTIONS = [
  { value: 'date', label: 'Date' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'rating', label: 'Rating' },
]

const LAYOUT_OPTIONS: Array<{ value: ViewMode; label: string; Icon: typeof LayoutGrid }> = [
  { value: 'masonry', label: 'Masonry', Icon: LayoutGrid },
  { value: 'justified', label: 'Justified', Icon: GalleryHorizontalEnd },
  { value: 'grid', label: 'Grid', Icon: Grid3X3 },
  { value: 'list', label: 'List', Icon: List },
]

const SEARCH_FIELD_OPTIONS: Array<{ value: SearchField; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'description', label: 'Description' },
  { value: 'extension', label: 'Extension' },
  { value: 'tag', label: 'Tag' },
]

function SortDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const label = SORT_OPTIONS.find(o => o.value === value)?.label ?? value

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div className={styles.sortWrap} ref={ref}>
      <button className={styles.sortBtn} onClick={() => setOpen(o => !o)}>
        {label}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{ marginLeft: 2, flexShrink: 0 }}>
          <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className={styles.sortPanel}>
          {SORT_OPTIONS.map(o => (
            <button key={o.value}
              className={`${styles.sortItem} ${value === o.value ? styles.sortItemActive : ''}`}
              onClick={() => { onChange(o.value); setOpen(false) }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function LayoutDropdown({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = LAYOUT_OPTIONS.find(o => o.value === value) ?? LAYOUT_OPTIONS[0]
  const SelectedIcon = selected.Icon

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div className={styles.layoutWrap} ref={ref}>
      <button className={styles.layoutBtn} onClick={() => setOpen(o => !o)} data-tooltip="Layout" aria-label="Choose layout">
        <SelectedIcon size={12} strokeWidth={1.8} />
        <span>{selected.label}</span>
        <ChevronDown size={11} strokeWidth={1.8} />
      </button>
      {open && (
        <div className={styles.layoutPanel}>
          {LAYOUT_OPTIONS.map(option => {
            const Icon = option.Icon
            return (
              <button
                key={option.value}
                className={`${styles.layoutItem} ${value === option.value ? styles.layoutItemActive : ''}`}
                onClick={() => { onChange(option.value); setOpen(false) }}
              >
                <Icon size={12} strokeWidth={1.8} />
                {option.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function TitleBar() {
  const {
    aiSettings, setAiSettings, stopAiQueue,
    aiFeatureStatus, setAiFeatureStatus,
    assets, selectedAssetIds,
    folderName, displayCount,
    thumbnailSize, setThumbnailSize,
    viewMode, setViewMode,
    searchQuery, setSearchQuery, searchFields, setSearchFields,
    sortBy, setSortBy, toggleSortDir,
    filterRating, filterExts,
    aiSearchMode, setAiSearchMode,
    setAiSearchResultIds,
    setAiIndexProgress,
    setAiIndexStatus, markAssetsEmbedded,
    dinoIndexStatus, setDinoIndexStatus, setDinoIndexProgress,
    aiSearchLoading, setAiSearchLoading,
    showToast,
    sensitiveTags, showSensitiveContent, setSensitiveTags, setShowSensitiveContent,
  } = useStore()

  const [showFilter, setShowFilter] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSearchModeMenu, setShowSearchModeMenu] = useState(false)
  const [showSearchFieldMenu, setShowSearchFieldMenu] = useState(false)
  const [searchMode, setSearchMode] = useState<'default'|'ai-text'|'ai-image'>('default')
  const [aiQuery, setAiQuery] = useState('')
  const [imageQueryPath, setImageQueryPath] = useState('')
  const [imageQueryUrl, setImageQueryUrl] = useState('')
  const [imageQueryName, setImageQueryName] = useState('')
  const [exportingSheet, setExportingSheet] = useState(false)
  const [platform, setPlatform] = useState(() =>
    navigator.platform?.toLowerCase().includes('mac') ? 'darwin' : ''
  )
  const [aiEmbeddingEnabled, setAiEmbeddingEnabled] = useState(true)
  const dinoIndexEnabled = dinoIndexStatus?.enabled === true
  const tipsInstalled = !!aiFeatureStatus?.tipsv2.installed
  const dinoInstalled = !!aiFeatureStatus?.dinov3.installed
  const tipsAvailable = tipsInstalled && !!aiFeatureStatus?.tipsv2.enabled
  const dinoAvailable = dinoInstalled && !!aiFeatureStatus?.dinov3.enabled
  const taggingAvailable = !!aiFeatureStatus?.tagging.model
  const [theme, setTheme] = useState<'dark'|'light'>(() =>
    (localStorage.getItem('stag-theme') as 'dark'|'light') || 'dark'
  )
  const searchRef = useRef<HTMLInputElement>(null)
  const searchModeRef = useRef<HTMLDivElement>(null)
  const searchModeBtnRef = useRef<HTMLButtonElement>(null)
  const searchFieldRef = useRef<HTMLDivElement>(null)
  const api = (window as any).electronAPI
  const isMac = platform === 'darwin'

  useEffect(() => {
    api?.getPlatform?.().then((value: string) => {
      if (value) setPlatform(value)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (searchFieldRef.current && !searchFieldRef.current.contains(e.target as Node)) {
        setShowSearchFieldMenu(false)
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => {
    log.info('theme.apply', { theme })
    document.documentElement.dataset.theme = theme
    localStorage.setItem('stag-theme', theme)
    api?.loadSettings?.().then((existing: any) => {
      if (Array.isArray(existing?.sensitiveTags)) setSensitiveTags(existing.sensitiveTags)
      if (existing?.showSensitiveContent !== undefined) setShowSensitiveContent(!!existing.showSensitiveContent)
      api?.saveSettings?.({ ...(existing || {}), theme })
    }).catch(() => {})
  }, [theme])

  useEffect(() => {
    const onThemeChanged = (event: Event) => {
      const next = (event as CustomEvent).detail
      if (next === 'dark' || next === 'light') setTheme(next)
    }
    window.addEventListener('stag:themeChanged', onThemeChanged)
    return () => window.removeEventListener('stag:themeChanged', onThemeChanged)
  }, [])

  const hasFilters = filterRating > 0 || filterExts.length > 0
  const selectedCount = selectedAssetIds.length
  const selectedSearchLabels = SEARCH_FIELD_OPTIONS
    .filter(option => searchFields.includes(option.value))
    .map(option => option.label)
  const searchScopeLabel = selectedSearchLabels.length === SEARCH_FIELD_OPTIONS.length
    ? 'all fields'
    : selectedSearchLabels.join(', ')

  const toggleAi = async () => {
    const enabling = !aiSettings.enabled
    if (enabling) {
      const result = await api?.ollamaCheck?.(aiSettings.ollamaUrl).catch(() => null)
      const models: string[] = result?.models || []
      const active = !!result?.ok && !!aiSettings.model && models.includes(aiSettings.model)
      if (!active) {
        if (aiFeatureStatus) setAiFeatureStatus({
          ...aiFeatureStatus,
          tagging: { ...aiFeatureStatus.tagging, active: false, models },
        })
        showToast(
          result?.ok ? `Ollama model "${aiSettings.model}" is not installed.` : 'Cannot enable AI tagging because Ollama is not running.',
          'error',
          5000,
        )
        return
      }
    }
    const next = { ...aiSettings, enabled: enabling }
    log.info('ai.tagging.toggle', { enabled: next.enabled, model: next.model })
    await setAiSettings(next)
    if (!next.enabled) stopAiQueue()
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (
        searchModeBtnRef.current && !searchModeBtnRef.current.contains(e.target as Node) &&
        searchModeRef.current && !searchModeRef.current.contains(e.target as Node)
      ) setShowSearchModeMenu(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => {
    let tipsStatusTimer: number | null = null
    let dinoStatusTimer: number | null = null
    const refreshTipsStatus = (delay = 0) => {
      if (tipsStatusTimer !== null) window.clearTimeout(tipsStatusTimer)
      tipsStatusTimer = window.setTimeout(() => {
        api.getAiIndexStatus?.().then((status: any) => setAiIndexStatus(status)).catch(() => {})
      }, delay)
    }
    const refreshDinoStatus = (delay = 0) => {
      if (dinoStatusTimer !== null) window.clearTimeout(dinoStatusTimer)
      dinoStatusTimer = window.setTimeout(() => {
        api.getAiImageIndexStatus?.().then((status: any) => setDinoIndexStatus(status)).catch(() => {})
      }, delay)
    }
    api?.getAiFeatureStatus?.().then(async (features: any) => {
      if (!features) return
      const ollama = await api?.ollamaCheck?.(features.tagging?.ollamaUrl).catch(() => null)
      setAiFeatureStatus({
        ...features,
        tagging: {
          ...features.tagging,
          active: !!ollama?.ok && !!features.tagging?.model && (ollama?.models || []).includes(features.tagging.model),
          models: ollama?.models || [],
        },
      })
      setAiEmbeddingEnabled(!!features.tipsv2?.enabled)
    }).catch(() => {})
    api?.getAiIndexStatus?.().then((s: any) => {
      setAiIndexStatus(s)
      if (s?.running) setAiIndexProgress({ type: 'indexing', current: s.indexed ?? 0, total: s.total ?? 0 })
    }).catch(() => {})
    api?.getAiEmbeddingEnabled?.().then((enabled: boolean) => setAiEmbeddingEnabled(enabled !== false)).catch(() => {})
    api?.getAiImageIndexStatus?.().then((status: any) => setDinoIndexStatus(status)).catch(() => {})
    const offProgress = api?.onAiIndexProgress?.((data: any) => {
      const terminal = ['done', 'error', 'cancelled'].includes(data.type)
      setAiIndexProgress(terminal ? null : data)
      if (data.status) setAiIndexStatus(data.status)
      if (terminal) {
        refreshTipsStatus(80)
      }
    })
    const offEmbedded = api?.onAiEmbeddedUpdated?.((ids: string[]) => {
      markAssetsEmbedded(ids)
      refreshTipsStatus(150)
    })
    const offDinoProgress = api?.onAiImageIndexProgress?.((data: any) => {
      const terminal = ['done', 'error', 'cancelled', 'model_ready'].includes(data.type)
      setDinoIndexProgress(terminal ? null : data)
      if (data.status) setDinoIndexStatus(data.status)
      if (terminal) {
        refreshDinoStatus(100)
      }
    })
    const offModelProgress = api?.onAiModelDownloadProgress?.((data: any) => {
      if (data.type === 'done' || data.type === 'error' || data.type === 'cancelled') {
        api?.getAiFeatureStatus?.().then((features: any) => {
          const current = useStore.getState().aiFeatureStatus
          if (features) setAiFeatureStatus(current ? {
            ...features,
            tagging: { ...features.tagging, active: current.tagging.active, models: current.tagging.models },
          } : features)
        }).catch(() => {})
      }
    })
    const offFeatureStatus = api?.onAiFeatureStatusChanged?.((features: any) => {
      if (!features) return
      const current = useStore.getState().aiFeatureStatus
      setAiFeatureStatus(current ? {
        ...features,
        tagging: {
          ...features.tagging,
          active: current.tagging.active,
          models: current.tagging.models,
        },
      } : features)
      setAiEmbeddingEnabled(!!features.tipsv2?.enabled)
      if (features.dinov3) {
        setDinoIndexStatus({
          ...features.dinov3,
          enabled: !!features.dinov3.enabled,
          modelLoaded: useStore.getState().dinoIndexStatus?.modelLoaded || false,
          assetIds: useStore.getState().dinoIndexStatus?.assetIds || [],
        })
      }
    })
    return () => {
      if (tipsStatusTimer !== null) window.clearTimeout(tipsStatusTimer)
      if (dinoStatusTimer !== null) window.clearTimeout(dinoStatusTimer)
      offProgress?.()
      offEmbedded?.()
      offDinoProgress?.()
      offModelProgress?.()
      offFeatureStatus?.()
    }
  }, [markAssetsEmbedded])

  const switchToDefaultSearch = () => {
    log.info('search.mode.default')
    setSearchMode('default')
    setAiSearchMode(false)
    setShowSearchModeMenu(false)
    setAiSearchResultIds(null)
    setAiQuery('')
    api?.stopAiSearch?.().catch(() => {})
    api?.stopAiImageSearch?.().catch(() => {})
    searchRef.current?.focus()
  }

  const switchToAiSearch = () => {
    log.info('search.mode.ai')
    setSearchMode('ai-text')
    setAiSearchMode(true)
    setShowSearchModeMenu(false)
    setShowSearchFieldMenu(false)
    setSearchQuery('')
    setAiSearchResultIds(null)
    api?.stopAiImageSearch?.().catch(() => {})
    api?.getAiIndexStatus?.().then((s: any) => {
      setAiIndexStatus(s)
      if (!s?.hasIndex) showToast('Embedding index is not created. Creating it now.', 'info', 4000)
    }).catch(() => {})
    api?.startAiIndexing?.().catch(() => {})
    window.dispatchEvent(new CustomEvent('stag:foregroundProgress', {
      detail: {
        id: 'tips-model',
        label: 'Loading TIPSv2 model',
        detail: 'Preparing AI text search',
        color: 'var(--accent)',
        indeterminate: true,
      },
    }))
    api?.warmAiSearch?.()
      .then((result: any) => {
        if (!result?.ok && result?.error !== 'not-indexed') {
          showToast('TIPSv2 search model could not be loaded.', 'error', 5000)
        }
      })
      .catch(() => showToast('TIPSv2 search model could not be loaded.', 'error', 5000))
      .finally(() => {
        window.dispatchEvent(new CustomEvent('stag:foregroundProgress', { detail: null }))
      })
    searchRef.current?.focus()
  }

  const switchToAiImageSearch = () => {
    log.info('search.mode.ai_image')
    setSearchMode('ai-image')
    setAiSearchMode(true)
    setShowSearchModeMenu(false)
    setShowSearchFieldMenu(false)
    setSearchQuery('')
    setAiQuery('')
    setAiSearchResultIds(null)
    api?.warmAiImageSearch?.().then((result: any) => {
      if (result?.status) setDinoIndexStatus(result.status)
      if (!result?.ok) showToast('DINOv3 image search could not be prepared.', 'error', 5000)
    }).catch(() => showToast('DINOv3 image search could not be prepared.', 'error', 5000))
  }

  const toggleEmbedding = async () => {
    const next = !aiEmbeddingEnabled
    log.info('ai.embedding.toggle.start', { enabled: next })
    try {
      const result = await api?.setAiEmbeddingEnabled?.(next)
      if (result?.ok) {
        log.info('ai.embedding.toggle.done', { enabled: next, status: result.status })
        setAiEmbeddingEnabled(next)
        setAiIndexStatus(result.status)
        if (aiFeatureStatus) setAiFeatureStatus({
          ...aiFeatureStatus,
          tipsv2: { ...aiFeatureStatus.tipsv2, enabled: next },
        })
        showToast(next ? 'Image embedding enabled. Creating index in background.' : 'Image embedding disabled.', 'info', 3000)
        if (next) api?.startAiIndexing?.().catch(() => {})
      }
    } catch {
      log.error('ai.embedding.toggle.failed', { enabled: next })
      showToast('Could not update image embedding setting.', 'error')
    }
  }

  const toggleDinoIndexing = async () => {
    const next = !dinoIndexEnabled
    log.info('dino.index.toggle.start', { enabled: next })
    try {
      const result = await api?.setAiImageIndexEnabled?.(next)
      if (!result?.ok) throw new Error(result?.error || 'toggle-failed')
      setDinoIndexStatus(result.status)
      if (aiFeatureStatus) setAiFeatureStatus({
        ...aiFeatureStatus,
        dinov3: { ...aiFeatureStatus.dinov3, enabled: next },
      })
      if (!next) setDinoIndexProgress(null)
      showToast(
        next ? 'Automatic DINOv3 image indexing enabled.' : 'Automatic DINOv3 image indexing disabled. Image search still works on demand.',
        'info',
        3500
      )
    } catch {
      showToast('Could not update DINOv3 image indexing.', 'error')
    }
  }

  const toggleSensitiveContent = async () => {
    const next = !showSensitiveContent
    log.info('sensitive.visibility.toggle', { show: next, sensitiveTags })
    setShowSensitiveContent(next)
    showToast(next ? 'Sensitive content shown.' : 'Sensitive content hidden.', 'info')
    try {
      const existing = await api?.loadSettings?.()
      await api?.saveSettings?.({ ...(existing || {}), sensitiveTags, showSensitiveContent: next })
    } catch {}
  }

  const runAiSearch = async () => {
    const q = aiQuery.trim()
    if (!q || !api?.aiSearch) return
    log.info('ai.search.start', { query: q })
    setAiSearchLoading(true)
    try {
      const result = await api.aiSearch(q, 50)
      if (result?.ok) {
        log.info('ai.search.done', { query: q, count: result.assetIds?.length || 0, assetIds: result.assetIds })
        setAiSearchResultIds(result.assetIds)
      } else {
        log.warn('ai.search.failed', { query: q, error: result?.error })
        setAiSearchResultIds([])
        if (result?.error === 'not-indexed') {
          showToast('Embedding index is not created. Creating it now.', 'info', 4000)
          try {
            const enabled = await api?.setAiEmbeddingEnabled?.(true)
            if (enabled?.ok) {
              setAiEmbeddingEnabled(true)
              setAiIndexStatus(enabled.status)
            }
          } catch {}
          api?.startAiIndexing?.().catch(() => {})
        }
      }
    } catch {
      log.error('ai.search.exception', { query: q })
      setAiSearchResultIds([])
    } finally {
      setAiSearchLoading(false)
    }
  }

  const runAiImageSearch = async (imagePath: string) => {
    if (!imagePath || !api?.aiImageSearch) return
    log.info('ai.image_search.start', { imagePath })
    setAiSearchLoading(true)
    try {
      const result = await api.aiImageSearch(imagePath, 50)
      if (result?.ok) {
        log.info('ai.image_search.done', { imagePath, count: result.assetIds?.length || 0 })
        setAiSearchResultIds(result.assetIds)
      } else {
        log.warn('ai.image_search.failed', { imagePath, error: result?.error })
        setAiSearchResultIds([])
        if (result?.error === 'dinov3-dependencies-missing') {
          showToast('DINOv3 requires Python packages: faiss, torch, torchvision, transformers, Pillow, and numpy.', 'error', 7000)
        } else {
          showToast('Could not search with this image.', 'error')
        }
      }
    } catch {
      setAiSearchResultIds([])
      showToast('Could not search with this image.', 'error')
    } finally {
      setAiSearchLoading(false)
    }
  }

  const selectImageQuery = async (filePath: string) => {
    if (!filePath) return
    const fileUrl = await api?.getFileUrl?.(filePath).catch(() => '')
    setImageQueryPath(filePath)
    setImageQueryUrl(fileUrl || '')
    setImageQueryName(filePath.split(/[\\/]/).pop() || 'Query image')
    void runAiImageSearch(filePath)
  }

  const chooseImageQuery = async () => {
    const filePath = await api?.openSearchImage?.()
    if (filePath) await selectImageQuery(filePath)
  }

  useEffect(() => {
    const searchWithAsset = (event: Event) => {
      const filePath = String((event as CustomEvent).detail?.filePath || '')
      if (!filePath) return
      setSearchMode('ai-image')
      setAiSearchMode(true)
      setShowSearchModeMenu(false)
      setShowSearchFieldMenu(false)
      setSearchQuery('')
      setAiQuery('')
      setAiSearchResultIds(null)
      void selectImageQuery(filePath)
    }
    window.addEventListener('stag:dinoImageSearch', searchWithAsset)
    return () => window.removeEventListener('stag:dinoImageSearch', searchWithAsset)
  }, [])

  const exportContactSheet = async () => {
    if (!selectedAssetIds.length) {
      showToast('Select assets to export a contact sheet.', 'info')
      return
    }
    if (!api?.exportContactSheet) {
      showToast('Contact sheet export is not available in this build.', 'error')
      return
    }

    const selected = selectedAssetIds
      .map(id => assets.find(asset => asset.id === id))
      .filter(Boolean) as Asset[]

    if (!selected.length) {
      showToast('Selected assets are no longer available.', 'error')
      return
    }

    setExportingSheet(true)
    try {
      const dataUrl = await buildContactSheet(selected)
      const stamp = new Date().toISOString().slice(0, 10)
      const result = await api.exportContactSheet(dataUrl, `Stag Contact Sheet ${stamp}.png`)
      if (result?.ok) showToast('Contact sheet exported.', 'success')
      else if (result?.error) showToast(`Contact sheet export failed: ${result.error}`, 'error')
    } catch {
      showToast('Contact sheet export failed.', 'error')
    } finally {
      setExportingSheet(false)
    }
  }

  return (
    <>
    <div className={`${styles.titlebar} ${isMac ? styles.macTitlebar : ''}`}>

      {/* ── LEFT: window controls + folder name ── */}
      <div className={styles.left}>
        {!isMac && (
          <>
            <div className={styles.winControls}>
              <button className={`${styles.btn} ${styles.close}`}    onClick={() => api?.close()}    data-tooltip="Close" data-tooltip-align="left" aria-label="Close"><X size={8} strokeWidth={2.5} /></button>
              <button className={`${styles.btn} ${styles.minimize}`} onClick={() => api?.minimize()} data-tooltip="Minimize" data-tooltip-align="left" aria-label="Minimize"><Minus size={8} strokeWidth={2.5} /></button>
              <button className={`${styles.btn} ${styles.maximize}`} onClick={() => api?.maximize()} data-tooltip="Maximize" data-tooltip-align="left" aria-label="Maximize"><Maximize2 size={8} strokeWidth={2.5} /></button>
            </div>

            <div className={styles.leftDivider} />
          </>
        )}

        <div className={styles.folderSlot}>
          <span className={styles.folderName}>{folderName}</span>
          <span className={styles.folderCount}>{displayCount}</span>
        </div>

      </div>

      {/* ── CENTER: search + size slider + sort + filter ── */}
      <div className={styles.centerSearch}>
        <div className={styles.searchModeWrap}>
          <button
            ref={searchModeBtnRef}
            className={`${styles.searchModeBtn} ${aiSearchMode ? styles.searchModeBtnAi : ''}`}
            onClick={() => setShowSearchModeMenu(o => !o)}
            data-tooltip="Search method"
            aria-label="Search method"
          >
            {searchMode === 'ai-image'
              ? <ImagePlus size={12} strokeWidth={1.9} />
              : searchMode === 'ai-text'
                ? <Bot size={12} strokeWidth={1.9} />
                : <Search size={12} strokeWidth={1.9} />}
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
              <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {showSearchModeMenu && (
            <div ref={searchModeRef} className={styles.searchModeMenu}>
              <button className={`${styles.searchModeItem} ${searchMode === 'default' ? styles.searchModeItemActive : ''}`} onClick={switchToDefaultSearch}>
                <Search size={12} strokeWidth={1.8} />
                Simple Search
              </button>
              {tipsAvailable && (
                <button className={`${styles.searchModeItem} ${searchMode === 'ai-text' ? styles.searchModeItemActive : ''}`} onClick={switchToAiSearch}>
                  <Bot size={12} strokeWidth={1.8} />
                  AI Text Search
                </button>
              )}
              {dinoAvailable && (
                <button className={`${styles.searchModeItem} ${searchMode === 'ai-image' ? styles.searchModeItemActive : ''}`} onClick={switchToAiImageSearch}>
                  <ImagePlus size={12} strokeWidth={1.8} />
                  AI Image Search
                </button>
              )}
            </div>
          )}
        </div>

        <div
          className={`${styles.searchBox} ${aiSearchMode ? styles.searchBoxAi : ''} ${searchMode === 'ai-image' ? styles.searchBoxImage : ''}`}
          onDragOver={event => {
            if (searchMode !== 'ai-image') return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={event => {
            if (searchMode !== 'ai-image') return
            event.preventDefault()
            const file = event.dataTransfer.files?.[0]
            const filePath = file ? api?.getPathForFile?.(file) : ''
            if (filePath) void selectImageQuery(filePath)
          }}
        >
          {searchMode === 'ai-image' ? (
            <button className={styles.imageSearchInput} onClick={chooseImageQuery} disabled={aiSearchLoading}>
              {imageQueryUrl
                ? <img src={imageQueryUrl} className={styles.imageSearchThumb} alt="" />
                : <ImagePlus size={13} strokeWidth={1.8} />}
              <span>{imageQueryName || 'Choose or drop an image...'}</span>
            </button>
          ) : aiSearchMode ? (
            <Search size={11} strokeWidth={1.8} className={styles.searchIcon} />
          ) : (
            <div className={styles.searchFieldWrap} ref={searchFieldRef}>
              <button
                className={styles.searchFieldButton}
                onClick={() => setShowSearchFieldMenu(open => !open)}
                data-tooltip={`Search in ${searchScopeLabel}`}
                aria-label="Choose search fields"
              >
                <Search size={11} strokeWidth={1.8} />
                <ChevronDown size={8} strokeWidth={2} />
              </button>
              {showSearchFieldMenu && (
                <div className={styles.searchFieldMenu}>
                  {SEARCH_FIELD_OPTIONS.map(option => (
                    <label
                      key={option.value}
                      className={`${styles.searchFieldItem} ${searchFields.includes(option.value) ? styles.searchFieldItemActive : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={searchFields.includes(option.value)}
                        disabled={searchFields.length === 1 && searchFields.includes(option.value)}
                        onChange={() => {
                          const next = searchFields.includes(option.value)
                            ? searchFields.filter(field => field !== option.value)
                            : [...searchFields, option.value]
                          setSearchFields(next)
                          searchRef.current?.focus()
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {searchMode !== 'ai-image' && (
            <input
              ref={searchRef}
              className={styles.searchInput}
              placeholder={searchMode === 'ai-text'
                ? 'Describe image...'
                : `Search ${searchScopeLabel.toLowerCase()}...`}
              value={searchMode === 'ai-text' ? aiQuery : searchQuery}
              onChange={e => searchMode === 'ai-text' ? setAiQuery(e.target.value) : setSearchQuery(e.target.value)}
              onKeyDown={e => { if (searchMode === 'ai-text' && e.key === 'Enter') runAiSearch() }}
              disabled={aiSearchLoading}
            />
          )}
          {aiSearchMode && aiSearchLoading && <span className={styles.searchSpinner} aria-label="AI search in progress" />}
          {searchMode === 'ai-image'
            ? imageQueryPath && !aiSearchLoading && <button className={styles.searchClear} onClick={() => { setImageQueryPath(''); setImageQueryUrl(''); setImageQueryName(''); setAiSearchResultIds(null) }}>×</button>
            : searchMode === 'ai-text'
              ? aiQuery && !aiSearchLoading && <button className={styles.searchClear} onMouseDown={e => e.preventDefault()} onClick={() => { setAiQuery(''); setAiSearchResultIds(null) }}>×</button>
            : searchQuery && <button className={styles.searchClear} onMouseDown={e => e.preventDefault()} onClick={() => setSearchQuery('')}>×</button>}
        </div>

        <div className={styles.centerDivider} />

        <div className={styles.sizeSlider}>
          <SlidersHorizontal size={10} strokeWidth={1.8} style={{ color: 'var(--text-muted)' }} />
          <input type="range" min="80" max="320" value={thumbnailSize}
            onChange={e => setThumbnailSize(Number(e.target.value))}
            className={styles.slider} />
        </div>

        <button className={styles.iconBtn} onClick={toggleSortDir} data-tooltip="Toggle sort direction" aria-label="Toggle sort direction">
          <ArrowUpDown size={12} strokeWidth={1.8} />
        </button>

        <SortDropdown value={sortBy} onChange={v => setSortBy(v as any)} />

        <LayoutDropdown value={viewMode} onChange={setViewMode} />

        <button
          className={styles.iconBtn}
          onClick={exportContactSheet}
          disabled={!selectedCount || exportingSheet}
          data-tooltip={selectedCount ? `Export contact sheet (${selectedCount})` : 'Select assets for contact sheet'}
          aria-label="Export contact sheet"
        >
          <FileImage size={12} strokeWidth={1.8} />
        </button>

        <div className={styles.filterWrap}>
          <button className={`${styles.iconBtn} ${hasFilters ? styles.activeBtn : ''}`}
            onClick={() => setShowFilter(!showFilter)} data-tooltip="Filters" aria-label="Filters">
            <Filter size={12} strokeWidth={1.8} />
            {hasFilters && <span className={styles.filterDot} />}
          </button>
          {showFilter && <FilterPanel onClose={() => setShowFilter(false)} />}
        </div>
      </div>

      {/* ── RIGHT: visibility + theme | AI | settings ── */}
      <div className={styles.actions}>
        <button
          className={`${styles.aiToggle} ${showSensitiveContent ? styles.aiOn : styles.aiOff}`}
          onClick={toggleSensitiveContent}
          data-tooltip={showSensitiveContent ? 'Sensitive content visible' : 'Sensitive content hidden'}
          aria-label={showSensitiveContent ? 'Sensitive content visible' : 'Sensitive content hidden'}
        >
          {showSensitiveContent
            ? <Eye size={11} strokeWidth={1.8} className={styles.aiIcon} />
            : <EyeOff size={11} strokeWidth={1.8} className={styles.aiIcon} />}
          <span className={styles.aiDot} />
        </button>

        <button className={styles.iconBtn} onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          data-tooltip={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {theme === 'dark'
            ? <Sun size={12} strokeWidth={1.8} />
            : <Moon size={12} strokeWidth={1.8} />}
        </button>

        <div className={styles.groupDivider} />

        {tipsInstalled && <button
          className={`${styles.aiToggle} ${aiEmbeddingEnabled ? styles.aiOn : styles.aiOff}`}
          onClick={toggleEmbedding}
          data-tooltip={aiEmbeddingEnabled ? 'Image embedding ON' : 'Image embedding OFF'}
          aria-label={aiEmbeddingEnabled ? 'Image embedding ON' : 'Image embedding OFF'}
        >
          <Database size={11} strokeWidth={1.8} className={styles.aiIcon} />
          <span className={styles.aiDot} />
        </button>}

        {dinoInstalled && <button
          className={`${styles.aiToggle} ${dinoIndexEnabled ? styles.aiOn : styles.aiOff}`}
          onClick={toggleDinoIndexing}
          data-tooltip={dinoIndexEnabled ? 'Automatic DINOv3 indexing ON' : 'Automatic DINOv3 indexing OFF'}
          aria-label={dinoIndexEnabled ? 'Automatic DINOv3 indexing ON' : 'Automatic DINOv3 indexing OFF'}
        >
          <ImagePlus size={11} strokeWidth={1.8} className={styles.aiIcon} />
          <span className={styles.aiDot} />
        </button>}

        {taggingAvailable && <button
          className={`${styles.aiToggle} ${aiSettings.enabled ? styles.aiOn : styles.aiOff}`}
          onClick={toggleAi}
          data-tooltip={aiSettings.enabled ? 'AI tagging ON' : 'AI tagging OFF'}
          aria-label={aiSettings.enabled ? 'AI tagging ON' : 'AI tagging OFF'}
        >
          <Bot size={11} strokeWidth={1.8} className={styles.aiIcon} />
          <span className={styles.aiDot} />
        </button>}

        <div className={styles.groupDivider} />

        <button className={styles.iconBtn} onClick={() => setShowSettings(true)}
          data-tooltip="Settings"
          data-tooltip-align="right"
          aria-label="Settings">
          <Settings size={12} strokeWidth={1.9} />
        </button>
      </div>
    </div>
    {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </>
  )
}
