import { useState, useEffect } from 'react'
import { Bot, EyeOff, ImagePlus, RefreshCw, RotateCcw, Search, Tag, Trash2, X, Palette, Library, Cpu, Keyboard, Download, FolderOpen } from 'lucide-react'
import { AiFeatureStatus, AiSettings } from '../types'
import { useStore } from '../store/useStore'
import styles from './SettingsPanel.module.css'
import { createRendererLogger } from '../utils/logger'

const log = createRendererLogger('settings-panel')

interface Settings {
  threads: number
  bgColor: string; accentColor: string
  glassOpacity: number
  blurStrength: number
  aiSettings?: AiSettings
  aiEmbeddingEnabled?: boolean
  sensitiveTags?: string[]
  showSensitiveContent?: boolean
  showThumbnailFilename?: boolean
  showThumbnailExtension?: boolean
  showThumbnailExtensionInFilename?: boolean
  showThumbnailExtensionBadge?: boolean
}

interface Props { onClose: () => void }

const DEFAULT_ACCENT = '#7c6ff0'

function notifyManagedFolderMigration() {
  window.dispatchEvent(new CustomEvent('stag:assets-mutated', {
    detail: { reason: 'managed-folder-migration', phase: 'committed', time: Date.now() },
  }))
}

function hexToRgb(hex: string): [number,number,number] {
  const h = hex.replace('#','')
  const n = parseInt(h.length === 3 ? h.split('').map(c=>c+c).join('') : h, 16)
  return [(n>>16)&255,(n>>8)&255,n&255]
}

function applyTheme(s: { bgColor: string; accentColor: string; glassOpacity: number; blurStrength: number }) {
  const r = document.documentElement
  const [ar,ag,ab] = hexToRgb(s.accentColor)
  // Neumorphic: accent only — bg surfaces come from CSS theme tokens
  r.style.setProperty('--accent',       s.accentColor)
  r.style.setProperty('--accent-hover', `rgba(${Math.min(255,ar+20)},${Math.min(255,ag+15)},${Math.min(255,ab+5)},1)`)
  r.style.setProperty('--accent-dim',   `rgba(${ar},${ag},${ab},0.13)`)
  r.style.setProperty('--accent-glow',  `rgba(${ar},${ag},${ab},0.32)`)
  r.style.setProperty('--neu-raise-accent',    `-3px -3px 8px rgba(${ar},${ag},${ab},0.26), 3px 3px 10px rgba(0,0,0,0.78)`)
  r.style.setProperty('--neu-raise-accent-lg', `-4px -4px 12px rgba(${ar},${ag},${ab},0.32), 5px 5px 14px rgba(0,0,0,0.82)`)
  // Always neumorphic
  r.style.setProperty('--blur-strength', '0px')
  r.style.setProperty('--glass-opacity', '0')
}

export default function SettingsPanel({ onClose }: Props) {
  const [s, setS] = useState<Settings>({
    threads: 8, bgColor: '#0e0d14', accentColor: '#7c6ff0',
    glassOpacity: 0, blurStrength: 0,
    showThumbnailFilename: true,
    showThumbnailExtensionInFilename: true,
    showThumbnailExtensionBadge: true,
  })
  const [webGrabPath, setWebGrabPath] = useState('')
  const [webGrabMsg, setWebGrabMsg] = useState('')
  const [saved, setSaved] = useState(false)
  const [ai, setAi] = useState<AiSettings>({ enabled: false, ollamaUrl: 'http://localhost:11434', model: 'llava' })
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaStatus, setOllamaStatus] = useState<'idle'|'checking'|'ok'|'error'>('idle')
  const [ollamaMsg, setOllamaMsg] = useState('')
  const [tab, setTab] = useState<'appearance'|'library'|'performance'|'ai-tagging'|'ai-text'|'ai-image'|'shortcuts'>('appearance')
  const [copyPath, setCopyPath] = useState('')
  const [copyMsg, setCopyMsg] = useState('')
  const [cpuCount, setCpuCount] = useState(16)
  const [indexBusy, setIndexBusy] = useState(false)
  const [indexMsg, setIndexMsg] = useState('')
  const [featureStatus, setFeatureStatus] = useState<AiFeatureStatus | null>(null)
  const [modelProgress, setModelProgress] = useState<Record<string, any>>({})
  const [ollamaPull, setOllamaPull] = useState<any>(null)
  const [customOllamaModel, setCustomOllamaModel] = useState('')
  const [runtimeStatus, setRuntimeStatus] = useState<any>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [sensitiveTagQuery, setSensitiveTagQuery] = useState('')
  const allTags = useStore(state => state.tags)
  const deleteAllTags = useStore(state => state.deleteAllTags)
  const showToast = useStore(state => state.showToast)

  useEffect(() => {
    ;(async () => {
      log.info('settings.load.start')
      const [saved, wgp, cpus, features] = await Promise.all([
        (window as any).electronAPI?.loadSettings(),
        (window as any).electronAPI?.getWebGrabPath?.(),
        (window as any).electronAPI?.getCpuCount?.(),
        (window as any).electronAPI?.getAiFeatureStatus?.(),
      ])
      if (cpus) setCpuCount(cpus)
      if (saved) {
        const legacyExtension = saved.showThumbnailExtension !== false
        setS(prev => ({
          ...prev,
          ...saved,
          showThumbnailExtensionInFilename: saved.showThumbnailExtensionInFilename ?? legacyExtension,
          showThumbnailExtensionBadge: saved.showThumbnailExtensionBadge ?? legacyExtension,
        }))
        applyTheme({ ...s, ...saved })
      }
      if (saved?.aiSettings) setAi(saved.aiSettings)
      if (features) {
        const current = useStore.getState().aiFeatureStatus
        const merged = current ? {
          ...features,
          tagging: {
            ...features.tagging,
            active: current.tagging.active,
            models: current.tagging.models,
          },
        } : features
        setFeatureStatus(merged)
        useStore.getState().setAiFeatureStatus(merged)
      }
      if (wgp) setWebGrabPath(wgp)
      if (saved?.importCopyPath) setCopyPath(saved.importCopyPath)
      log.info('settings.load.done', { saved, webGrabPath: wgp, cpuCount: cpus })
    })()
  }, [])

  useEffect(() => {
    const api = (window as any).electronAPI
    api?.getRuntimeStatus?.().then(setRuntimeStatus).catch(() => {})
    const offRuntime = api?.onRuntimeProgress?.((progress: any) => setRuntimeStatus(progress))
    const offModels = api?.onAiModelDownloadProgress?.((progress: any) => {
      setModelProgress(current => ({ ...current, [progress.feature]: progress }))
      if (['done', 'error', 'cancelled'].includes(progress.type)) {
        api?.getAiFeatureStatus?.().then((features: AiFeatureStatus) => {
          const current = useStore.getState().aiFeatureStatus
          const merged = current ? { ...features, tagging: { ...features.tagging, active: current.tagging.active, models: current.tagging.models } } : features
          setFeatureStatus(merged)
          useStore.getState().setAiFeatureStatus(merged)
        })
      }
    })
    const offOllama = api?.onOllamaModelPullProgress?.((progress: any) => setOllamaPull(progress))
    const refreshAfterProcessing = (progress: any) => {
      if (progress?.type === 'done') void refreshFeatureStatus()
    }
    const offTipsIndex = api?.onAiIndexProgress?.(refreshAfterProcessing)
    const offDinoIndex = api?.onAiImageIndexProgress?.(refreshAfterProcessing)
    return () => { offRuntime?.(); offModels?.(); offOllama?.(); offTipsIndex?.(); offDinoIndex?.() }
  }, [])

  // Live preview accent colour changes
  useEffect(() => { applyTheme(s) }, [s.accentColor])

  const reinstallRuntime = async () => {
    const api = (window as any).electronAPI
    setRuntimeBusy(true)
    try {
      const result = await api?.reinstallRuntime?.()
      setRuntimeStatus(await api?.getRuntimeStatus?.())
      showToast(
        result?.ok ? 'Application dependencies reinstalled and verified.' : result?.error || 'Dependency installation failed.',
        result?.ok ? 'success' : 'error',
        6000,
      )
    } catch (error: any) {
      showToast(error?.message || 'Dependency installation failed.', 'error', 6000)
    } finally {
      setRuntimeBusy(false)
    }
  }

  // Ollama is only considered available after its API responds.
  useEffect(() => {
    if (tab !== 'ai-tagging') return
    ;(async () => {
      setOllamaStatus('checking')
      const result = await (window as any).electronAPI?.ollamaCheck?.(ai.ollamaUrl)
      if (result?.ok) {
        const models: string[] = result.models || []
        setOllamaModels(models)
        setOllamaStatus('ok')
        setOllamaMsg(`${models.length} installed model${models.length === 1 ? '' : 's'} found`)
        if (!ai.model || !models.includes(ai.model)) {
          const vision = models.find((m: string) => /llava|bakllava|moondream|cogvlm|minicpm|qwen.*vl|gemma.*vision|vision/i.test(m))
          if (models.length) setAi((x: any) => ({...x, model: vision || models[0]}))
        }
      } else {
        setOllamaStatus('error')
        setOllamaMsg(result?.error || 'Ollama is not running')
        setOllamaModels([])
      }
    })()
  }, [tab, ai.ollamaUrl])

  const refreshFeatureStatus = async () => {
    const features = await (window as any).electronAPI?.getAiFeatureStatus?.()
    if (features) {
      const current = useStore.getState().aiFeatureStatus
      const merged = current ? { ...features, tagging: { ...features.tagging, active: current.tagging.active, models: current.tagging.models } } : features
      setFeatureStatus(merged)
      useStore.getState().setAiFeatureStatus(merged)
      return merged
    }
    return null
  }

  const downloadModel = async (feature: 'tipsv2'|'dinov3') => {
    setModelProgress(current => ({ ...current, [feature]: { type: 'preparing' } }))
    const result = await (window as any).electronAPI?.downloadAiModel?.(feature)
    if (!result?.ok && result?.error !== 'cancelled') showToast(result?.error || 'Model download failed', 'error')
    await refreshFeatureStatus()
  }

  const setFeatureEnabled = async (feature: 'tipsv2'|'dinov3', enabled: boolean) => {
    const result = feature === 'tipsv2'
      ? await (window as any).electronAPI?.setAiEmbeddingEnabled?.(enabled)
      : await (window as any).electronAPI?.setAiImageIndexEnabled?.(enabled)
    if (!result?.ok) {
      showToast(result?.error === 'model-not-installed' ? 'Download the model first.' : result?.error || 'Could not update AI feature.', 'error')
      return
    }
    await refreshFeatureStatus()
    if (enabled) {
      if (feature === 'tipsv2') await (window as any).electronAPI?.startAiIndexing?.()
      else await (window as any).electronAPI?.startAiImageIndexing?.()
    }
  }

  const pullOllamaModel = async () => {
    const model = customOllamaModel.trim()
    if (!model || ollamaStatus !== 'ok') return
    setOllamaPull({ model, status: 'preparing', completed: 0, total: 0 })
    const result = await (window as any).electronAPI?.ollamaPullModel?.(model, ai.ollamaUrl)
    if (!result?.ok) {
      if (result?.error !== 'cancelled') showToast(result?.error || 'Ollama model download failed', 'error')
      return
    }
    const models = await (window as any).electronAPI?.ollamaGetModels?.(ai.ollamaUrl) || []
    setOllamaModels(models)
    setAi(x => ({ ...x, model, enabled: true }))
    setCustomOllamaModel('')
  }

  const save = async () => {
    const validatedAi = {
      ...ai,
      enabled: ai.enabled && ollamaStatus === 'ok' && ollamaModels.includes(ai.model),
    }
    log.info('settings.save.start', { settings: s, ai: validatedAi })
    const settingsToSave: Record<string, unknown> = {
      ...s,
      aiSettings: validatedAi,
    }
    delete settingsToSave.showThumbnailFileType
    delete settingsToSave.showThumbnailExtension
    delete settingsToSave.aiEmbeddingEnabled
    delete settingsToSave.dinoImageIndexEnabled
    delete settingsToSave.dinoImageIndexUserConfigured
    await (window as any).electronAPI?.saveSettings(settingsToSave)
    window.dispatchEvent(new CustomEvent('stag:thumbnailLabelSettings', {
      detail: {
        showThumbnailFilename: s.showThumbnailFilename !== false,
        showThumbnailExtensionInFilename: s.showThumbnailExtensionInFilename !== false,
        showThumbnailExtensionBadge: s.showThumbnailExtensionBadge !== false,
      },
    }))
    const store = useStore.getState()
    store.setSensitiveTags(s.sensitiveTags || [])
    if (s.showSensitiveContent !== undefined) store.setShowSensitiveContent(!!s.showSensitiveContent)
    await store.setAiSettings(validatedAi)
    if (featureStatus) {
      const nextFeatures = {
        ...featureStatus,
        tagging: {
          ...featureStatus.tagging,
          enabled: validatedAi.enabled,
          active: ollamaStatus === 'ok' && ollamaModels.includes(validatedAi.model),
          model: validatedAi.model,
          models: ollamaModels,
        },
      }
      setFeatureStatus(nextFeatures)
      store.setAiFeatureStatus(nextFeatures)
    }
    setSaved(true); setTimeout(() => setSaved(false), 2000)
    log.info('settings.save.done', { aiEnabled: ai.enabled, sensitiveTags: s.sensitiveTags })
  }

  const toggleSensitiveTag = (tag: string) => {
    setS(x => {
      const current = x.sensitiveTags || []
      return {
        ...x,
        sensitiveTags: current.includes(tag)
          ? current.filter(t => t !== tag)
          : [...current, tag],
      }
    })
  }

  const handleDeleteAllTags = async () => {
    log.warn('settings.tags.delete_all.prompt')
    const ok = window.confirm('Delete all tags from the library? Files will not be deleted.')
    if (!ok) { log.info('settings.tags.delete_all.cancelled'); return }
    log.warn('settings.tags.delete_all.confirmed')
    deleteAllTags()
    const nextSettings = { ...s, sensitiveTags: [] }
    setS(nextSettings)
    const settingsToSave: Record<string, unknown> = {
      ...nextSettings,
      aiSettings: ai,
    }
    delete settingsToSave.aiEmbeddingEnabled
    delete settingsToSave.dinoImageIndexEnabled
    delete settingsToSave.dinoImageIndexUserConfigured
    await (window as any).electronAPI?.saveSettings?.(settingsToSave)
    showToast('All tags deleted. Files were not deleted.', 'success')
  }

  const selectedSensitiveTags = s.sensitiveTags || []
  const sensitiveTagMatches = sensitiveTagQuery.trim()
    ? allTags
        .filter(tag => !selectedSensitiveTags.includes(tag))
        .filter(tag => tag.toLowerCase().includes(sensitiveTagQuery.trim().toLowerCase()))
        .slice(0, 8)
    : []

  const chooseWebGrabPath = async () => {
    log.info('settings.web_grab.choose.start')
    const dir = await (window as any).electronAPI?.selectDirectory()
    if (!dir) { log.info('settings.web_grab.choose.cancelled'); return }
    log.info('settings.web_grab.save.start', { dir })
    setWebGrabMsg('Migrating…')
    const res = await (window as any).electronAPI?.setWebGrabPath?.(dir)
    if (res?.ok) {
      setWebGrabPath(res.path)
      setWebGrabMsg(`✓ Folder changed${res.migrated ? ` — ${res.migrated} files moved` : ''}`)
      notifyManagedFolderMigration()
    }
    else setWebGrabMsg('✕ ' + (res?.error || 'Failed'))
    log.info('settings.web_grab.save.done', res)
    setTimeout(() => setWebGrabMsg(''), 3000)
  }

  const chooseLocalImportPath = async () => {
    const dir = await (window as any).electronAPI?.selectDirectory()
    if (!dir) return
    setCopyMsg('Migrating…')
    const res = await (window as any).electronAPI?.setLocalImportPath?.(dir)
    if (res?.ok) {
      setCopyPath(res.path)
      setCopyMsg(`✓ Folder changed${res.migrated ? ` — ${res.migrated} files moved` : ''}`)
      notifyManagedFolderMigration()
    } else {
      setCopyMsg('✕ ' + (res?.error || 'Failed'))
    }
    setTimeout(() => setCopyMsg(''), 4000)
  }

  const deleteCurrentIndex = async () => {
    log.warn('settings.ai_index.delete.start')
    setIndexBusy(true)
    setIndexMsg('')
    const res = await (window as any).electronAPI?.deleteAiIndex?.()
    if (res?.ok) {
      setIndexMsg('Index deleted')
      showToast('Image embedding index deleted.', 'success')
    } else {
      const msg = res?.error || 'Failed to delete index'
      setIndexMsg(msg)
      showToast(msg, 'error')
    }
    setIndexBusy(false)
    log.info('settings.ai_index.delete.done', res)
  }

  const reindexAll = async () => {
    log.warn('settings.ai_index.reindex_all.start')
    setIndexBusy(true)
    setIndexMsg('')
    const res = await (window as any).electronAPI?.reindexAiAll?.()
    if (res?.ok) {
      setS(x => ({ ...x, aiEmbeddingEnabled: true }))
      setIndexMsg('Reindex started')
      showToast('Embedding index is being rebuilt for all files.', 'info', 3500)
    } else {
      const msg = res?.error || 'Failed to start reindex'
      setIndexMsg(msg)
      showToast(msg, 'error')
    }
    setIndexBusy(false)
    log.info('settings.ai_index.reindex_all.done', res)
  }

  const deleteCurrentDinoIndex = async () => {
    setIndexBusy(true)
    setIndexMsg('')
    const res = await (window as any).electronAPI?.deleteAiImageIndex?.()
    if (res?.ok) {
      setIndexMsg('DINOv3 index deleted')
      showToast('DINOv3 image index deleted.', 'success')
      await refreshFeatureStatus()
    } else {
      const msg = res?.error || 'Failed to delete DINOv3 index'
      setIndexMsg(msg)
      showToast(msg, 'error')
    }
    setIndexBusy(false)
  }

  const reindexAllDino = async () => {
    setIndexBusy(true)
    setIndexMsg('')
    const res = await (window as any).electronAPI?.reindexAiImageAll?.()
    if (res?.ok) {
      setIndexMsg('DINOv3 reindex started')
      showToast('DINOv3 index is being rebuilt for all files.', 'info', 3500)
      await refreshFeatureStatus()
    } else {
      const msg = res?.error || 'Failed to start DINOv3 reindex'
      setIndexMsg(msg)
      showToast(msg, 'error')
    }
    setIndexBusy(false)
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.closeBtn} onClick={onClose} data-tooltip="Close" data-tooltip-align="right" aria-label="Close"><X size={16} strokeWidth={1.8} /></button>
        </div>

        <div className={styles.settingsMain}>
          <nav className={styles.tabs} aria-label="Settings sections">
            <button className={`${styles.tab} ${tab==='appearance'?styles.tabActive:''}`} onClick={() => setTab('appearance')}>
              <Palette size={15} /> Appearance
            </button>
            <button className={`${styles.tab} ${tab==='library'?styles.tabActive:''}`} onClick={() => setTab('library')}>
              <Library size={15} /> Library
            </button>
            <button className={`${styles.tab} ${tab==='performance'?styles.tabActive:''}`} onClick={() => setTab('performance')}>
              <Cpu size={15} /> Performance
            </button>
            <button className={`${styles.tab} ${tab==='ai-tagging'?styles.tabActive:''}`} onClick={() => setTab('ai-tagging')}>
              <Bot size={15} /> AI Tagging
            </button>
            <button className={`${styles.tab} ${tab==='ai-text'?styles.tabActive:''}`} onClick={() => setTab('ai-text')}>
              <Search size={15} /> AI Text Search
            </button>
            <button className={`${styles.tab} ${tab==='ai-image'?styles.tabActive:''}`} onClick={() => setTab('ai-image')}>
              <ImagePlus size={15} /> AI Image Search
            </button>
            <button className={`${styles.tab} ${tab==='shortcuts'?styles.tabActive:''}`} onClick={() => setTab('shortcuts')}>
              <Keyboard size={15} /> Shortcuts
            </button>
          </nav>

          <div className={styles.body}>
          {tab === 'appearance' && <>
            <Row label="Accent colour">
              <ColorRow value={s.accentColor} onChange={v => setS(x => ({...x, accentColor: v}))} />
            </Row>
            <p className={styles.hint}>Accent colour previews live. Save to apply permanently.</p>
            <button
              className={styles.btn}
              style={{marginTop:4}}
              onClick={() => setS(x => ({ ...x, accentColor: DEFAULT_ACCENT }))}>
              Reset to Default
            </button>

            <div className={styles.sectionDivider}>
              <h3 className={styles.sectionTitle}>Thumbnail labels</h3>
              <p className={styles.hint}>Show filenames below thumbnails and format badges on thumbnails.</p>
              <div className={styles.toggleList}>
                <SettingToggle
                  label="Filename below thumbnail"
                  checked={s.showThumbnailFilename !== false}
                  onChange={checked => setS(x => ({ ...x, showThumbnailFilename: checked }))}
                />
                <SettingToggle
                  label="Extension in filename"
                  checked={s.showThumbnailExtensionInFilename !== false}
                  onChange={checked => setS(x => ({ ...x, showThumbnailExtensionInFilename: checked }))}
                />
                <SettingToggle
                  label="Extension badge"
                  checked={s.showThumbnailExtensionBadge !== false}
                  onChange={checked => setS(x => ({ ...x, showThumbnailExtensionBadge: checked }))}
                />
              </div>
            </div>
          </>}

          {tab === 'library' && <>
            <div>
              <Row label="Web Grab Folder">
                <div className={styles.pathBox} style={{flex:1}}>{webGrabPath}</div>
              </Row>
              <p className={styles.hint} style={{marginBottom:8}}>Images grabbed from the browser extension are saved here. Existing files move automatically when this folder changes.</p>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <button className={styles.btn} onClick={chooseWebGrabPath}>Change Folder</button>
                <button className={styles.btn} style={{opacity:0.6}} onClick={async () => {
                  setWebGrabMsg('Migrating…')
                  const res = await (window as any).electronAPI?.setWebGrabPath?.('')
                  if (res?.ok) {
                    setWebGrabPath(res.path)
                    setWebGrabMsg(`✓ Reset to default${res.migrated ? ` — ${res.migrated} files moved` : ''}`)
                    notifyManagedFolderMigration()
                  } else setWebGrabMsg('✕ ' + (res?.error || 'Failed'))
                  setTimeout(() => setWebGrabMsg(''), 4000)
                }}>Reset to Default</button>
              </div>
              {webGrabMsg && <div className={`${styles.msg} ${webGrabMsg.startsWith('✓')?styles.ok:styles.err}`} style={{marginTop:6}}>{webGrabMsg}</div>}
            </div>

            <div className={styles.sectionDivider}>
              <Row label="Sensitive Tags">
                <div className={styles.sensitiveSummary}>
                  <EyeOff size={13} strokeWidth={1.8} />
                  {(s.sensitiveTags || []).length} selected
                </div>
              </Row>
              <p className={styles.hint} style={{marginBottom:8}}>
                Items with these tags are hidden while the top-bar sensitive-content toggle is off.
              </p>
              <div className={styles.tagPicker}>
                <div className={styles.selectedTags}>
                  {selectedSensitiveTags.length === 0 ? (
                    <div className={styles.emptyTags}>No sensitive tags selected</div>
                  ) : selectedSensitiveTags.map(tag => (
                    <button
                      key={tag}
                      type="button"
                      className={`${styles.tagChoice} ${styles.tagChoiceActive}`}
                      onClick={() => toggleSensitiveTag(tag)}
                      data-tooltip="Remove sensitive tag"
                      aria-label="Remove sensitive tag"
                    >
                      <Tag size={12} strokeWidth={1.8} />
                      {tag}
                      <X size={11} strokeWidth={1.8} />
                    </button>
                  ))}
                </div>
                <div className={styles.tagSearchWrap}>
                  <input
                    className={styles.tagSearchInput}
                    value={sensitiveTagQuery}
                    onChange={e => setSensitiveTagQuery(e.target.value)}
                    placeholder="Search tags..."
                  />
                  {sensitiveTagMatches.length > 0 && (
                    <div className={styles.tagDropdown}>
                      {sensitiveTagMatches.map(tag => (
                        <button
                          key={tag}
                          type="button"
                          className={styles.tagDropdownItem}
                          onClick={() => {
                            toggleSensitiveTag(tag)
                            setSensitiveTagQuery('')
                          }}
                        >
                          <Tag size={12} strokeWidth={1.8} />
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className={styles.sectionDivider}>
              <Row label="Tag Maintenance">
                <button
                  type="button"
                  className={styles.btnIcon}
                  disabled={allTags.length === 0}
                  onClick={handleDeleteAllTags}
                >
                  <Trash2 size={13} strokeWidth={1.8} />
                  Delete All Tags
                </button>
              </Row>
              <p className={styles.hint}>
                Removes all tags from the library and from items. Files and library items are not deleted.
              </p>
            </div>

            {/* ── Managed Local Import Folder ── */}
            <div style={{marginTop:20,paddingTop:16,borderTop:'1px solid var(--border)'}}>
              <Row label="Local Import Folder">
                <div className={styles.pathBox} style={{flex:1}}>{copyPath}</div>
              </Row>
              <p className={styles.hint} style={{marginBottom:8}}>
                Imported files are copied here before they are added to Stag. Existing managed files move automatically when this folder changes. Originals are never modified.
              </p>
              <div style={{display:'flex',gap:8,alignItems:'center',marginTop:6}}>
                <button className={styles.btn} onClick={chooseLocalImportPath}>Change Folder</button>
                <button className={styles.btn} style={{opacity:0.6}} onClick={async () => {
                  setCopyMsg('Migrating…')
                  const res = await (window as any).electronAPI?.setLocalImportPath?.('')
                  if (res?.ok) {
                    setCopyPath(res.path)
                    setCopyMsg(`✓ Reset to default${res.migrated ? ` — ${res.migrated} files moved` : ''}`)
                    notifyManagedFolderMigration()
                  } else setCopyMsg('✕ ' + (res?.error || 'Failed'))
                  setTimeout(() => setCopyMsg(''), 4000)
                }}>Reset to Default</button>
              </div>
              {copyMsg && <div className={`${styles.msg} ${copyMsg.startsWith('✓')?styles.ok:styles.err}`} style={{marginTop:6}}>{copyMsg}</div>}
            </div>
          </>}

          {tab === 'performance' && <>
            <Row label="Threads">
              <SliderRow value={s.threads} min={1} max={cpuCount} step={1} display={`${s.threads} / ${cpuCount}`}
                onChange={v => setS(x => ({...x, threads: v}))} />
            </Row>
            <p className={styles.hint}>Used for both import and file copy. Your CPU has {cpuCount} logical threads.</p>
            <div style={{marginTop:20,paddingTop:16,borderTop:'1px solid var(--border)'}}>
              <h3 className={styles.sectionTitle}>Application Dependencies</h3>
              <p className={styles.hint}>
                Python, FFmpeg, ImageMagick, Ghostscript, and AI packages install into Stag's application-data folder after first launch. They are not included in the app package.
              </p>
              <div className={styles.actionRow}>
                <span className={styles.hint}>
                  {runtimeStatus?.aiReady || runtimeStatus?.type === 'done'
                    ? 'Ready'
                    : runtimeStatus?.type === 'error'
                      ? `Error: ${runtimeStatus.error}`
                      : runtimeStatus?.label || 'Waiting to install'}
                </span>
                {runtimeStatus?.type === 'error' && (
                  <button className={styles.btnIcon} disabled={runtimeBusy} onClick={() => void reinstallRuntime()}>
                    <RefreshCw size={13} /> Retry
                  </button>
                )}
                {runtimeStatus?.type !== 'error' && (
                  <button className={styles.btnIcon} disabled={runtimeBusy} onClick={() => void reinstallRuntime()}>
                    <RefreshCw size={13} /> {runtimeBusy ? 'Installing...' : 'Reinstall Dependencies'}
                  </button>
                )}
                {runtimeStatus?.logPath && (
                  <button className={styles.btnIcon} onClick={() => (window as any).electronAPI?.showInFolder?.(runtimeStatus.logPath)}>
                    Show Install Log
                  </button>
                )}
              </div>
            </div>
          </>}

          {tab === 'ai-tagging' && <>
            <Row label="AI Auto-Tagging">
              <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer'}}>
                <input type="checkbox" checked={ai.enabled}
                  disabled={ollamaStatus !== 'ok' || !ollamaModels.includes(ai.model)}
                  onChange={e => setAi(x => ({...x, enabled: e.target.checked}))}
                  style={{width:16,height:16,cursor:'pointer',accentColor:'var(--accent)'}} />
                <span style={{fontSize:12,color: ai.enabled ? 'var(--accent)' : 'var(--text-muted)',fontWeight: ai.enabled ? 600 : 400}}>
                  {ai.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </label>
            </Row>

            <Row label="Ollama URL">
              <div style={{display:'flex',gap:6,flex:1}}>
                <input type="text" value={ai.ollamaUrl}
                  onChange={e => { setAi(x => ({...x, ollamaUrl: e.target.value})); setOllamaStatus('idle'); setOllamaModels([]) }}
                  style={{flex:1,background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:5,padding:'4px 8px',color:'var(--text-primary)',fontSize:12,fontFamily:'monospace'}} />
              </div>
            </Row>

            <Row label="Installed Model">
              <div style={{display:'flex',gap:6,flex:1,alignItems:'center'}}>
                <select
                  value={ollamaModels.includes(ai.model) ? ai.model : (ollamaModels.length > 0 ? '' : ai.model)}
                  onChange={e => setAi(x => ({...x, model: e.target.value}))}
                  style={{flex:1,background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:5,padding:'4px 8px',color: ollamaModels.length === 0 ? 'var(--text-muted)' : 'var(--text-primary)',fontSize:12,cursor:'pointer'}}>
                  {ollamaModels.length === 0
                    ? <option value={ai.model}>{ai.model || 'Click Refresh to load models'}</option>
                    : <>
                        {!ollamaModels.includes(ai.model) && ai.model && (
                          <option value={ai.model}>{ai.model} (typed)</option>
                        )}
                        {ollamaModels.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </>
                  }
                </select>
                <button
                  data-tooltip="Fetch installed models from Ollama"
                  data-tooltip-align="right"
                  aria-label="Fetch installed models from Ollama"
                  style={{flexShrink:0,background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:5,padding:'4px 8px',color:'var(--text-secondary)',fontSize:11,cursor:'pointer',whiteSpace:'nowrap'}}
                  disabled={ollamaStatus === 'checking'}
                  onClick={async () => {
                    setOllamaStatus('checking'); setOllamaMsg('')
                    const r = await (window as any).electronAPI?.ollamaCheck(ai.ollamaUrl)
                    if (r?.ok) {
                      setOllamaStatus('ok')
                      const mods: string[] = r.models || []
                      setOllamaModels(mods)
                      setOllamaMsg(`✓ ${mods.length} model${mods.length !== 1 ? 's' : ''} found`)
                      // Auto-select first vision model if none set
                      if (mods.length > 0 && (!ai.model || !mods.includes(ai.model))) {
                        const vision = mods.find((m: string) => /llava|bakllava|moondream|cogvlm|minicpm|qwen.*vl|gemma.*vision|vision/i.test(m))
                        setAi(x => ({...x, model: vision || mods[0]}))
                      }
                    } else {
                      setOllamaStatus('error')
                      setOllamaMsg(r?.error || 'Cannot connect')
                      setOllamaModels([])
                    }
                  }}>
                  {ollamaStatus === 'checking' ? '…' : '↻ Refresh'}
                </button>
              </div>
            </Row>

            {ollamaMsg && (
              <div style={{marginBottom:8,padding:'5px 8px',borderRadius:5,fontSize:11.5,
                background: ollamaStatus==='ok' ? 'rgba(107,203,119,0.12)' : 'rgba(224,82,82,0.12)',
                color: ollamaStatus==='ok' ? '#6bcb77' : '#e05252',
                border: `1px solid ${ollamaStatus==='ok' ? 'rgba(107,203,119,0.3)' : 'rgba(224,82,82,0.3)'}`}}>
                {ollamaStatus === 'ok' ? '✓ ' : '✕ '}{ollamaMsg}
              </div>
            )}

            <div className={styles.sectionDivider}>
              <h3 className={styles.sectionTitle}>Download another Ollama model</h3>
              <p className={styles.hint}>Enter any Ollama vision model name. Stag will ask the running Ollama service to download it.</p>
              <div className={styles.inlineControls}>
                <input className={styles.textInput} value={customOllamaModel} onChange={e => setCustomOllamaModel(e.target.value)} placeholder="e.g. qwen2.5vl:7b" />
                <button className={styles.btnIcon} disabled={ollamaStatus !== 'ok' || !customOllamaModel.trim()} onClick={pullOllamaModel}>
                  <Download size={13} /> Download
                </button>
              </div>
              {ollamaPull && <DownloadProgress progress={{ type: ollamaPull.status, bytesDone: ollamaPull.completed, bytesTotal: ollamaPull.total, file: ollamaPull.model }} />}
            </div>
            <p className={styles.hint}>AI tagging is available only while Ollama is running and the selected model is installed.</p>
          </>}

          {tab === 'ai-text' && (
            <ManagedAiPanel
              title="AI Text Search"
              description="TIPSv2 creates image embeddings for natural-language search."
              feature="tipsv2"
              status={featureStatus?.tipsv2}
              progress={modelProgress.tipsv2}
              onDownload={() => downloadModel('tipsv2')}
              onCancel={() => (window as any).electronAPI?.cancelAiModelDownload?.('tipsv2')}
              onToggle={enabled => setFeatureEnabled('tipsv2', enabled)}
              onShowIndex={path => (window as any).electronAPI?.showInFolder?.(path)}
            >
              {featureStatus?.tipsv2.installed && (
                <div className={styles.actionRow}>
                  <button className={styles.btnIcon} disabled={indexBusy} onClick={deleteCurrentIndex}><Trash2 size={13} /> Delete Index</button>
                  <button className={styles.btnIcon} disabled={indexBusy} onClick={reindexAll}>
                    {indexBusy ? <RefreshCw size={13} className={styles.spinIcon} /> : <RotateCcw size={13} />} Reindex All
                  </button>
                  {indexMsg && <span className={styles.hint}>{indexMsg}</span>}
                </div>
              )}
            </ManagedAiPanel>
          )}

          {tab === 'ai-image' && (
            <ManagedAiPanel
              title="AI Image Search"
              description="DINOv3 creates a separate visual-similarity index for searching with an image."
              feature="dinov3"
              status={featureStatus?.dinov3}
              progress={modelProgress.dinov3}
              onDownload={() => downloadModel('dinov3')}
              onCancel={() => (window as any).electronAPI?.cancelAiModelDownload?.('dinov3')}
              onToggle={enabled => setFeatureEnabled('dinov3', enabled)}
              onShowIndex={path => (window as any).electronAPI?.showInFolder?.(path)}
            >
              {featureStatus?.dinov3.installed && (
                <div className={styles.actionRow}>
                  <button className={styles.btnIcon} disabled={indexBusy} onClick={deleteCurrentDinoIndex}><Trash2 size={13} /> Delete Index</button>
                  <button className={styles.btnIcon} disabled={indexBusy} onClick={reindexAllDino}>
                    {indexBusy ? <RefreshCw size={13} className={styles.spinIcon} /> : <RotateCcw size={13} />} Reindex All
                  </button>
                  {indexMsg && <span className={styles.hint}>{indexMsg}</span>}
                </div>
              )}
            </ManagedAiPanel>
          )}

          {tab === 'shortcuts' && (
            <div className={styles.shortcuts}>
              <ShortcutGroup title="Library">
                <Shortcut keys={['⌘ F', 'Ctrl F']} label="Focus search" />
                <Shortcut keys={['⌘ A', 'Ctrl A']} label="Select all visible assets" />
                <Shortcut keys={['Arrow keys']} label="Move selection through assets" />
                <Shortcut keys={['Enter']} label="Open selected asset in its default app" />
                <Shortcut keys={['Space']} label="Preview selected asset" />
                <Shortcut keys={['Delete', 'Backspace']} label="Move selected assets to Trash" />
                <Shortcut keys={['Esc']} label="Clear selection" />
              </ShortcutGroup>

              <ShortcutGroup title="Preview">
                <Shortcut keys={['←', '→']} label="Preview previous or next asset" />
                <Shortcut keys={['Delete', 'Backspace']} label="Trash the current asset" />
                <Shortcut keys={['Esc']} label="Close preview" />
              </ShortcutGroup>

              <ShortcutGroup title="Editing">
                <Shortcut keys={['Enter']} label="Confirm a rename, folder name, or tag" />
                <Shortcut keys={['Esc']} label="Cancel the current inline edit" />
                <Shortcut keys={['Shift click']} label="Select a range of assets" />
                <Shortcut keys={['⌘ click', 'Ctrl click']} label="Add or remove an asset from selection" />
              </ShortcutGroup>
            </div>
          )}
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={`${styles.saveBtn} ${saved?styles.savedBtn:''}`} onClick={save}>
            {saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DownloadProgress({ progress }: { progress: any }) {
  if (!progress) return null
  const done = Number(progress.bytesDone || 0)
  const total = Number(progress.bytesTotal || 0)
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className={styles.downloadProgress}>
      <div className={styles.progressMeta}>
        <span>{progress.type === 'preparing' ? 'Preparing download...' : progress.file || progress.type}</span>
        <span>{total > 0 ? `${percent}%` : ''}</span>
      </div>
      <div className={styles.progressTrack}><span style={{ width: total > 0 ? `${percent}%` : '28%' }} /></div>
      {progress.error && <div className={`${styles.msg} ${styles.err}`}>{progress.error}</div>}
    </div>
  )
}

function ManagedAiPanel({
  title,
  description,
  feature,
  status,
  progress,
  onDownload,
  onCancel,
  onToggle,
  onShowIndex,
  children,
}: {
  title: string
  description: string
  feature: string
  status?: { repoId: string; installed: boolean; downloading: boolean; enabled: boolean; hasIndex: boolean; indexPath: string }
  progress?: any
  onDownload: () => void
  onCancel: () => void
  onToggle: (enabled: boolean) => void
  onShowIndex: (path: string) => void
  children?: React.ReactNode
}) {
  const downloading = status?.downloading || (progress && !['done', 'error', 'cancelled'].includes(progress.type))
  return (
    <section className={styles.aiPanel}>
      <div className={styles.aiPanelHeader}>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {status?.installed && (
          <label className={styles.featureToggle}>
            <input type="checkbox" checked={status.enabled} onChange={event => onToggle(event.target.checked)} />
            <span>{status.enabled ? 'Active' : 'Inactive'}</span>
          </label>
        )}
      </div>

      <div className={styles.modelCard}>
        <div>
          <strong>{status?.repoId || feature}</strong>
          <span>{status?.installed ? 'Model downloaded' : 'Model download required'}</span>
        </div>
        {!status?.installed && !downloading && <button className={styles.btnIcon} onClick={onDownload}><Download size={13} /> Download Model</button>}
        {downloading && <button className={styles.btn} onClick={onCancel}>Cancel</button>}
      </div>
      {downloading && <DownloadProgress progress={progress || { type: 'preparing' }} />}

      {status?.installed && (
        <div className={styles.indexCard}>
          <div>
            <strong>Index files</strong>
            <span>{status.hasIndex ? status.indexPath : 'Index will appear here after processing begins.'}</span>
          </div>
          {status.hasIndex && <button className={styles.btnIcon} onClick={() => onShowIndex(status.indexPath)}><FolderOpen size={13} /> Show</button>}
        </div>
      )}
      {children}
    </section>
  )
}

function ShortcutGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.shortcutGroup}>
      <h3 className={styles.shortcutTitle}>{title}</h3>
      <div className={styles.shortcutList}>{children}</div>
    </section>
  )
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className={styles.shortcutRow}>
      <span className={styles.shortcutLabel}>{label}</span>
      <span className={styles.shortcutKeys}>
        {keys.map((key, index) => (
          <span key={key}>
            {index > 0 && <span className={styles.shortcutOr}>or</span>}
            <kbd>{key}</kbd>
          </span>
        ))}
      </span>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:14}}>
      <span style={{fontSize:12.5,color:'var(--text-secondary)',flexShrink:0,minWidth:130}}>{label}</span>
      {children}
    </div>
  )
}
function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={styles.toggleRow}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
    </label>
  )
}
function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:8}}>
      <input type="color" style={{width:32,height:28,border:'1px solid var(--border)',borderRadius:5,cursor:'pointer',background:'none',padding:2}} value={value} onChange={e => onChange(e.target.value)} />
      <span style={{fontSize:11.5,color:'var(--text-muted)',fontFamily:'monospace'}}>{value}</span>
    </div>
  )
}
function SliderRow({ value, min, max, step, display, onChange }: { value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:8}}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{width:130,cursor:'pointer'}} />
      <span style={{fontSize:11.5,color:'var(--text-muted)',minWidth:36,textAlign:'right'}}>{display}</span>
    </div>
  )
}
