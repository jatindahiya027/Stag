import { useEffect, useCallback, useRef, useState } from 'react'
import { applyImportThreads, enqueueBackgroundThumbs } from './thumbEngine'
import { ensureThreeJS } from './components/LightboxModal'
import { isAiTaggableAsset, useStore } from './store/useStore'
import { ViewMode } from './types'
import { isImage, extractPaletteOnceForAsset, isEditableTarget } from './utils/helpers'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import MainContent from './components/MainContent'
import Inspector from './components/Inspector'
import LightboxModal from './components/LightboxModal'
import ToastNotification from './components/ToastNotification'
import ProcessDock from './components/ProcessDock'
import styles from './styles/App.module.css'
import { PanelLeft, PanelRight, ArrowDown } from 'lucide-react'

// Set dev flag for console logging in store
// true when running via 'npm run dev' (Vite dev server on localhost)
if (typeof window !== 'undefined') (window as any).__DEV__ = location.hostname === 'localhost' || location.hostname === '127.0.0.1'

let paletteBackfillStarted = false
const VIEW_MODES: ViewMode[] = ['masonry', 'justified', 'grid', 'list']

function visibleStartupLog(message: string, data?: Record<string, any>) {
  console.log(message, data || '')
  ;(window as any).electronAPI?.log?.({
    level: 'info',
    module: 'startup-ui',
    event: 'startup_timing',
    data,
    message,
    time: new Date().toISOString(),
  }).catch?.(() => {})
}

function notifyAssetMutation(reason: string, ids: string[] = [], phase: 'optimistic' | 'committed' = 'committed') {
  try {
    window.dispatchEvent(new CustomEvent('stag:assets-mutated', { detail: { reason, ids, phase, time: Date.now() } }))
  } catch {}
}

function waitForStartupIdle(timeout = 1800) {
  return new Promise(resolve => {
    const idle = (window as any).requestIdleCallback
    if (typeof idle === 'function') {
      idle(() => resolve(undefined), { timeout })
    } else {
      setTimeout(resolve, Math.min(timeout, 1200))
    }
  })
}

function queueExistingPaletteBackfill() {
  if (paletteBackfillStarted) return
  paletteBackfillStarted = true

  setTimeout(async () => {
    const candidates = useStore.getState().assets.filter(a =>
      !a.deleted &&
      !!a.thumbnailData &&
      !(a.colors?.length)
    )
    if (!candidates.length) return

    console.log(`[Palette ${new Date().toISOString()}] existing asset backfill queued: ${candidates.length}`)
    const BATCH = 8
    let savedCount = 0

    for (let i = 0; i < candidates.length; i += BATCH) {
      const chunk = candidates.slice(i, i + BATCH)
      await Promise.all(chunk.map(async candidate => {
        const asset = useStore.getState().assets.find(a => a.id === candidate.id)
        if (!asset?.thumbnailData || asset.colors?.length) return

        await extractPaletteOnceForAsset(asset.id, asset.thumbnailData, asset.colors, async colors => {
          const current = useStore.getState().assets.find(a => a.id === asset.id)
          if (current?.colors?.length) return
          await useStore.getState().updateAsset(asset.id, { colors })
          savedCount += 1
        }).catch(() => {})
      }))

      if ((window as any).__DEV__) {
        console.log(`[Palette ${new Date().toISOString()}] existing asset backfill progress: ${Math.min(i + BATCH, candidates.length)}/${candidates.length}`)
      }
      await new Promise(resolve => setTimeout(resolve, 120))
    }

    console.log(`[Palette ${new Date().toISOString()}] existing asset backfill complete: ${savedCount}/${candidates.length} palettes stored`)
  }, 3500)
}

export default function App() {
  const {
    setAssets, setFolders, setTags, setSmartFolders,
    dragOver, setDragOver, inspectorOpen, setInspectorOpen, sidebarOpen, setSidebarOpen,
    importFiles, importUrl, hydrateAiSettings, setSensitiveTags, setShowSensitiveContent,
    pruneRecentAssets,
    setAiFeatureStatus, showToast,
    setViewMode, setThumbnailSize,
  } = useStore()

  useEffect(() => {
    pruneRecentAssets()
    const timer = window.setInterval(pruneRecentAssets, 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [pruneRecentAssets])

  useEffect(() => {
    const api = (window as any).electronAPI
    const offFeatures = api?.onAiFeatureStatusChanged?.((features: any) => {
      const current = useStore.getState().aiFeatureStatus
      setAiFeatureStatus(current ? {
        ...features,
        tagging: {
          ...features.tagging,
          active: current.tagging.active,
          models: current.tagging.models,
        },
      } : features)
    })
    const offRuntime = api?.onRuntimeProgress?.((progress: any) => {
      if (progress?.type === 'error') {
        showToast(`Runtime installation failed: ${progress.error}. Open Settings > Performance for details.`, 'error', 10000)
      } else if (progress?.type === 'done') {
        showToast('Python, media tools, and AI dependencies are ready.', 'success', 4000)
      }
    })
    return () => { offFeatures?.(); offRuntime?.() }
  }, [setAiFeatureStatus, showToast])

  const initialized = useRef(false)
  const dragDepth = useRef(0)
  const [dbReady, setDbReady] = useState(false)
  const [assetsLoading, setAssetsLoading] = useState(true)

  // Load settings first so the shell opens quickly, then load assets after paint.
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    ;(async () => {
      let startupSettings: any = null
      try {
        const [settings, featureStatus] = await Promise.all([
          (window as any).electronAPI?.loadSettings(),
          (window as any).electronAPI?.getAiFeatureStatus?.(),
        ])
        if (featureStatus) setAiFeatureStatus(featureStatus)
        startupSettings = settings
        if (settings) {
          if (VIEW_MODES.includes(settings.viewMode)) {
            setViewMode(settings.viewMode)
          }
          if (Number.isFinite(settings.thumbnailSize)) {
            const size = Math.max(80, Math.min(320, Number(settings.thumbnailSize)))
            setThumbnailSize(size)
          }
          // Restore theme — electron-store is reliable across sessions unlike localStorage
          if (settings.theme) {
            document.documentElement.dataset.theme = settings.theme
            localStorage.setItem('stag-theme', settings.theme)
            window.dispatchEvent(new CustomEvent('stag:themeChanged', { detail: settings.theme }))
          }
          const r = document.documentElement
          const hexToRgb = (hex: string): [number,number,number] => {
            const h = hex.replace('#',''), n = parseInt(h.length===3?h.split('').map((c:string)=>c+c).join(''):h,16)
            return [(n>>16)&255,(n>>8)&255,n&255]
          }
          const ac = settings.accentColor || '#7c6ff0'
          const [ar,ag,ab] = hexToRgb(ac)
          // Neumorphic: accent token only — bg surfaces come from CSS theme tokens
          r.style.setProperty('--accent',       ac)
          r.style.setProperty('--accent-hover', `rgba(${Math.min(255,ar+20)},${Math.min(255,ag+15)},${Math.min(255,ab+5)},1)`)
          r.style.setProperty('--accent-dim',   `rgba(${ar},${ag},${ab},0.13)`)
          r.style.setProperty('--accent-glow',  `rgba(${ar},${ag},${ab},0.32)`)
          // Neumorphic accent shadows
          r.style.setProperty('--neu-raise-accent',    `-3px -3px 8px rgba(${ar},${ag},${ab},0.26), 3px 3px 10px rgba(0,0,0,0.78)`)
          r.style.setProperty('--neu-raise-accent-lg', `-4px -4px 12px rgba(${ar},${ag},${ab},0.32), 5px 5px 14px rgba(0,0,0,0.82)`)
          // Always neumorphic — no blur, no glass
          r.style.setProperty('--blur-strength', '0px')
          r.style.setProperty('--glass-opacity', '0')
        }
        // Apply thread count to video queue concurrency
        if (settings?.threads) applyImportThreads(settings.threads)

        // Load AI settings
        if (settings?.aiSettings) {
          const configuredAi = settings.aiSettings
          const ollama = configuredAi.enabled
            ? await (window as any).electronAPI?.ollamaCheck?.(configuredAi.ollamaUrl).catch(() => null)
            : null
          const modelReady = !!ollama?.ok && !!configuredAi.model && (ollama.models || []).includes(configuredAi.model)
          hydrateAiSettings(configuredAi)
          if (featureStatus) {
            setAiFeatureStatus({
              ...featureStatus,
              tagging: {
                ...featureStatus.tagging,
                enabled: configuredAi.enabled,
                active: modelReady,
                models: ollama?.models || [],
              },
            })
          }
        }
        if (settings?.sensitiveTags) setSensitiveTags(settings.sensitiveTags)
        if (settings?.showSensitiveContent !== undefined) setShowSensitiveContent(!!settings.showSensitiveContent)
      } catch (e) {
        console.error('settings load failed', e)
      } finally {
        setDbReady(true)
      }

      const loadAssetsAfterPaint = async () => {
          const stagedLoadStarted = Date.now()
          let fullSaved: any = null
          try {
            const applySaved = async (saved: any, seedFolders: boolean) => {
              if (saved?.assets?.length) {
                const migratedAssets = saved.assets.map((a: any) => ({
                  ...a,
                  thumbnailData: a.thumbnailData?.startsWith('data:') ? undefined : a.thumbnailData,
                }))
                setAssets(migratedAssets)
              } else if (Array.isArray(saved?.assets) && useStore.getState().assets.length === 0) {
                setAssets([])
              }
              if (saved?.tags?.length)         setTags(saved.tags)
              if (saved?.smartFolders?.length) setSmartFolders(saved.smartFolders)

              if (saved?.folders?.length) {
                setFolders(saved.folders)
              } else if (seedFolders) {
                const defaults = useStore.getState().folders
                for (const f of defaults) {
                  await (window as any).electronAPI?.dbUpsertFolder(f).catch(() => {})
                }
              }
            }

            const firstSliceStarted = performance.now()
            const cachedStartupPage = await (window as any).electronAPI?.dbStartupAssets?.()
            const firstPage = cachedStartupPage?.assets?.length ? cachedStartupPage : await (window as any).electronAPI?.dbQueryAssets?.({
                limit: 50,
                offset: 0,
                activeFolderType: 'all',
                sortBy: 'date',
                sortDir: 'desc',
                sensitiveTags: startupSettings?.sensitiveTags || [],
                showSensitiveContent: startupSettings?.showSensitiveContent !== undefined
                  ? !!startupSettings.showSensitiveContent
                  : false,
              })
            visibleStartupLog(`[Startup] first 50 assets applied in ${Math.round(performance.now() - firstSliceStarted)}ms (${firstPage?.assets?.length || 0}/${firstPage?.total || 0})`, {
              ms: Math.round(performance.now() - firstSliceStarted),
              count: firstPage?.assets?.length || 0,
              total: firstPage?.total || 0,
            })
            await applySaved({ assets: firstPage?.assets || [] }, false)
            visibleStartupLog(`[Startup] first asset slice applied: ${firstPage?.assets?.length || 0}/${firstPage?.total || 0}`, {
              count: firstPage?.assets?.length || 0,
              total: firstPage?.total || 0,
            })
            setAssetsLoading(false)
            const metaSaved = await (window as any).electronAPI?.dbLoad({ metaOnly: true })
            await applySaved({
              folders: metaSaved?.folders || [],
              tags: metaSaved?.tags || [],
              smartFolders: metaSaved?.smartFolders || [],
            }, false)
            const minSkeletonMs = 0
            const elapsed = Date.now() - stagedLoadStarted
            if (elapsed < minSkeletonMs) {
              await new Promise(resolve => setTimeout(resolve, minSkeletonMs - elapsed))
            }
            setAssetsLoading(false)

            await waitForStartupIdle()
            fullSaved = metaSaved
            if (!metaSaved?.folders?.length) await applySaved(metaSaved, true)
            console.log(`[Startup UI ${new Date().toISOString()}] metadata loaded; asset full-load skipped for paged mode`)

            const saved = { ...fullSaved, assets: firstPage?.assets || [] }
            if (saved?.assets?.length) {
              queueExistingPaletteBackfill()
              setTimeout(() => enqueueBackgroundThumbs(saved.assets), 6000)
            }

            if (saved?.assets?.length) {
              const missingImageThumbs = (saved.assets as any[]).filter(
                a => !a.deleted && !a.thumbnailData && isImage(a.ext) && a.ext !== 'svg'
              )
              if (missingImageThumbs.length > 0) {
                setTimeout(async () => {
                  const api = (window as any).electronAPI
                  const BATCH = 10
                  for (let i = 0; i < missingImageThumbs.length; i += BATCH) {
                    const chunk = missingImageThumbs.slice(i, i + BATCH)
                    try {
                      const results: any[] = await api?.retryMissingThumbs?.(chunk) || []
                      const map = new Map(results.filter(r => r?.thumbUrl).map((r: any) => [r.id, r]))
                      if (map.size > 0) {
                        useStore.setState(s => ({
                          assets: s.assets.map(a => {
                            const r = map.get(a.id) as any
                            return r ? { ...a, thumbnailData: r.thumbUrl, width: r.width ?? a.width, height: r.height ?? a.height } : a
                          })
                        }))
                        for (const [id, r] of map) {
                          api?.dbUpdateAsset?.(id, { thumbnailData: (r as any).thumbUrl, width: (r as any).width, height: (r as any).height }).catch(() => {})
                        }
                      }
                    } catch {}
                    await new Promise(resolve => setTimeout(resolve, 200))
                  }
                }, 8000)
              }
            }

            const currentSettings = await (window as any).electronAPI?.loadSettings()
            if (currentSettings?.aiSettings?.enabled && useStore.getState().aiFeatureStatus?.tagging.active) {
              setTimeout(async () => {
                const api = (window as any).electronAPI
                const dbAssets = await api?.dbGetUntaggedImages?.().catch(() => []) || []
                const loadedById = new Map(useStore.getState().assets.map(a => [a.id, a]))
                const toTag = dbAssets
                  .map((asset: any) => loadedById.get(asset.id) || asset)
                  .filter((asset: any) => isAiTaggableAsset(asset))
                if (toTag.length > 0) {
                  if ((window as any).__DEV__) console.log(`[AI] Resuming queue: ${toTag.length} assets`)
                  useStore.getState().startAiQueue(toTag)
                }
              }, 9000)
            }
          } catch (e) {
            console.error('asset load failed', e)
          } finally {
            setAssetsLoading(false)
          }
      }
      void loadAssetsAfterPaint()

      setTimeout(async () => {
        const tools = await (window as any).electronAPI?.checkTools?.()
        if (tools) {
          const missing: string[] = []
          if (!tools.imageMagick) missing.push('ImageMagick')
          if (!tools.ghostscript) missing.push('Ghostscript')
          if (missing.length > 0) {
            useStore.getState().showToast(
              `Missing tools: ${missing.join(', ')} — TGA/DDS/EPS thumbnails unavailable`,
              'error', 6000
            )
          }
        }
      }, 7000)

      setTimeout(() => ensureThreeJS(() => {}), 9000)
    })()
  }, [])

  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.ollamaCheck) return
    let disposed = false

    const reconcileTaggingRuntime = async () => {
      const state = useStore.getState()
      const configured = state.aiSettings
      if (!configured.enabled || !configured.model) return
      const result = await api.ollamaCheck(configured.ollamaUrl).catch(() => null)
      if (disposed) return
      const models: string[] = result?.models || []
      const active = !!result?.ok && models.includes(configured.model)
      const current = useStore.getState().aiFeatureStatus
      const wasActive = !!current?.tagging.active
      if (current) {
        useStore.getState().setAiFeatureStatus({
          ...current,
          tagging: {
            ...current.tagging,
            enabled: configured.enabled,
            model: configured.model,
            ollamaUrl: configured.ollamaUrl,
            active,
            models,
          },
        })
      }
      if (!active || wasActive) return

      useStore.getState().setOllamaFailed(false)
      const dbAssets = await api.dbGetUntaggedImages?.().catch(() => []) || []
      const loadedById = new Map(useStore.getState().assets.map(a => [a.id, a]))
      const ready = dbAssets
        .map((asset: any) => loadedById.get(asset.id) || asset)
        .filter((asset: any) => isAiTaggableAsset(asset))
      if (ready.length) useStore.getState().startAiQueue(ready)
    }

    void reconcileTaggingRuntime()
    const timer = window.setInterval(reconcileTaggingRuntime, 30000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])

  // ── Push events from main process ────────────────────────────────────────
  // assets:removed — files deleted from disk → remove from store immediately
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.onAssetsRemoved) return
    const unsub = api.onAssetsRemoved((removedIds: string[]) => {
      if (!removedIds?.length) return
      const idSet = new Set(removedIds)
      useStore.setState(s => ({
        assets: s.assets.filter(a => !idSet.has(a.id)),
        selectedAssetIds: s.selectedAssetIds.filter(id => !idSet.has(id)),
        assetQueryVersion: s.assetQueryVersion + 1,
      }))
      notifyAssetMutation('external-remove', removedIds, 'committed')
      useStore.getState().showToast(
        `${removedIds.length} file${removedIds.length !== 1 ? 's' : ''} removed (deleted from disk)`,
        'info'
      )
    })
    return unsub
  }, [])

  // assets:added — files imported via browser extension → add to store + trigger AI
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.onAssetsAdded) return
    const unsub = api.onAssetsAdded((newAssets: any[]) => {
      if (!newAssets?.length) return
      let freshAssets: any[] = []
      useStore.setState(s => {
        const existingIds = new Set(s.assets.map(a => a.id))
        freshAssets = newAssets.filter(a => !existingIds.has(a.id))
        if (!freshAssets.length) return {}
        const newTagSet = new Set(s.tags)
        freshAssets.forEach(a => (a.tags || []).forEach((t: string) => newTagSet.add(t)))
        return {
          assets: [...freshAssets, ...s.assets],
          tags: [...newTagSet],
          assetQueryVersion: s.assetQueryVersion + 1,
        }
      })
      if (freshAssets.length) notifyAssetMutation('external-add', freshAssets.map(a => a.id), 'committed')
      useStore.getState().showToast(
        `${newAssets.length} asset${newAssets.length !== 1 ? 's' : ''} added from browser`,
        'success'
      )
      // Start AI tagging for newly grabbed images if AI is enabled.
      // startAiQueue handles the "already running" case internally — it appends
      // to the shared pending queue so no images are ever dropped.
      if (freshAssets.length > 0) {
        const { aiSettings, ollamaSessionFailed } = useStore.getState()
        if (aiSettings.enabled && !ollamaSessionFailed) {
          const readyAssets = freshAssets.filter(a => isAiTaggableAsset(a))
          if (readyAssets.length > 0) {
            setTimeout(() => useStore.getState().startAiQueue(readyAssets), 800)
          }
        }
      }
    })
    return unsub
  }, [])

  // thumb:done — batch incoming events and flush to store at most every 200ms.
  // Without batching, 700 images fire 700 rapid setState calls, each triggering
  // a full O(n) assets.map + computeLayout + React reconciliation = UI freeze.
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.onThumbDone) return

    type ThumbUpdate = { id: string; thumbUrl: string; thumbnailVariants?: { sm?: string; md?: string; lg?: string }; width?: number; height?: number }
    const pending = new Map<string, ThumbUpdate>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const runWhenIdle = (fn: () => void) => {
      const requestIdle = (window as any).requestIdleCallback
      if (requestIdle) requestIdle(fn, { timeout: 1500 })
      else window.setTimeout(fn, 250)
    }

    const flush = () => {
      flushTimer = null
      if (!pending.size) return
      const updates = new Map(pending)
      pending.clear()
      let changedCount = 0
      useStore.setState(s => {
        const assets = s.assets.map(a => {
          const u = updates.get(a.id)
          if (!u) return a
          const nextVariants = u.thumbnailVariants ?? a.thumbnailVariants
          const same =
            a.thumbnailData === u.thumbUrl &&
            a.thumbnailVariants?.sm === nextVariants?.sm &&
            a.thumbnailVariants?.md === nextVariants?.md &&
            a.thumbnailVariants?.lg === nextVariants?.lg &&
            (u.width ?? a.width) === a.width &&
            (u.height ?? a.height) === a.height
          if (same) return a
          changedCount += 1
          return { ...a, thumbnailData: u.thumbUrl, thumbnailVariants: u.thumbnailVariants ?? a.thumbnailVariants, width: u.width ?? a.width, height: u.height ?? a.height }
        })
        return changedCount > 0 ? { assets } : {}
      })
      if (!changedCount) return
      console.log(`[Thumb UI ${new Date().toISOString()}] batch:applied ${changedCount}/${updates.size}`)
      runWhenIdle(() => {
        const stateAssets = useStore.getState().assets
        const byId = new Map(stateAssets.map(a => [a.id, a]))
        for (const [id, u] of updates) {
          const asset = byId.get(id)
          if (asset && !asset.colors?.length && u.thumbUrl) {
            extractPaletteOnceForAsset(id, u.thumbUrl, asset.colors, colors => {
              const current = useStore.getState().assets.find(a => a.id === id)
              if (!current?.colors?.length) useStore.getState().updateAsset(id, { colors })
            }).catch(() => {})
          }
        }
        const { aiSettings, ollamaSessionFailed } = useStore.getState()
        if (aiSettings.enabled && !ollamaSessionFailed) {
          const readyForTagging: any[] = []
          for (const [id, u] of updates) {
            const asset = byId.get(id)
            const withThumb = asset ? { ...asset, thumbnailData: u.thumbUrl } : null
            if (withThumb && !withThumb.aiTagged && isAiTaggableAsset(withThumb)) {
              readyForTagging.push(withThumb)
            }
          }
          if (readyForTagging.length > 0) {
            useStore.getState().startAiQueue(readyForTagging)
          }
        }
      })
    }

    const unsub = api.onThumbDone((data: ThumbUpdate) => {
      pending.set(data.id, data)
      if (!flushTimer) flushTimer = setTimeout(flush, 240)
    })

    return () => {
      unsub()
      if (flushTimer) { clearTimeout(flushTimer); flush() }
    }
  }, [])

  // Drag & drop
  const isFileDrag = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer?.types || [])
    if (types.includes('application/x-stag-assets')) return false
    if ((window as any).__nativeDragOut) return false
    if (Date.now() < Number((window as any).__nativeDragCooldownUntil || 0)) return false
    return types.includes('Files')
  }, [])
  const handleDragOver  = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) {
      dragDepth.current = 0
      setDragOver(false)
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [isFileDrag, setDragOver])
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) {
      dragDepth.current = 0
      setDragOver(false)
      return
    }
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }, [isFileDrag, setDragOver])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0 || !e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
  }, [isFileDrag, setDragOver])
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) {
      window.setTimeout(() => { void importFiles(files) }, 0)
    }
  }, [importFiles, isFileDrag, setDragOver])

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const s = useStore.getState()
      const { selectedAssetIds, deleteAssets, permanentDeleteWithPrompt, clearSelection, selectAll,
              assets, setLightboxAsset, lightboxAsset, filteredAssetIds, activeFolderType } = s

      if ((e.key === 'Delete' || e.key === 'Backspace') && lightboxAsset) {
        e.preventDefault()
        e.stopImmediatePropagation()
        const currentId = lightboxAsset.id
        const assetById = new Map(assets.map(a => [a.id, a]))
        const visibleAssetIds = filteredAssetIds.filter(id => {
          const asset = assetById.get(id)
          if (!asset) return false
          return activeFolderType === 'trash' ? !!asset.deleted : !asset.deleted
        })
        const idx = visibleAssetIds.indexOf(currentId)
        const nextId = idx >= 0
          ? visibleAssetIds[idx + 1] ?? visibleAssetIds[idx - 1]
          : visibleAssetIds.find(id => id !== currentId)
        const nextAsset = nextId ? assetById.get(nextId) ?? null : null

        if (activeFolderType === 'trash') {
          void permanentDeleteWithPrompt([currentId]).then(() => {
            const stillExists = useStore.getState().assets.some(a => a.id === currentId)
            if (!stillExists) setLightboxAsset(nextAsset)
          })
        } else {
          setLightboxAsset(nextAsset)
          deleteAssets([currentId])
        }
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAssetIds.length > 0) {
        e.preventDefault()
        if (activeFolderType === 'trash') {
          permanentDeleteWithPrompt(selectedAssetIds)
        } else {
          deleteAssets(selectedAssetIds)
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault(); selectAll(filteredAssetIds)
      }
      if (e.key === 'Escape') {
        clearSelection()
        if (lightboxAsset) setLightboxAsset(null)
      }
      if (e.key === ' ' && lightboxAsset) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setLightboxAsset(null)
        return
      }
      if (e.key === ' ' && selectedAssetIds.length === 1 && !lightboxAsset) {
        e.preventDefault()
        const a = assets.find(x => x.id === selectedAssetIds[0])
        if (a) setLightboxAsset(a)
      }
      // Lightbox arrow nav
      if (lightboxAsset) {
        const idx = filteredAssetIds.indexOf(lightboxAsset.id)
        if (e.key === 'ArrowRight' && idx < filteredAssetIds.length - 1) {
          const next = assets.find(a => a.id === filteredAssetIds[idx + 1])
          if (next) setLightboxAsset(next)
        }
        if (e.key === 'ArrowLeft' && idx > 0) {
          const prev = assets.find(a => a.id === filteredAssetIds[idx - 1])
          if (prev) setLightboxAsset(prev)
        }
        return
      }
      // Arrow-key grid navigation is handled inside AssetGrid (position-aware masonry nav)
      if (e.key === 'Enter' && selectedAssetIds.length === 1) {
        const a = assets.find(x => x.id === selectedAssetIds[0])
        if (a?.ext === 'url') (window as any).electronAPI?.openExternalUrl(a.url)
        else if (a) (window as any).electronAPI?.openPath(a.filePath)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Clipboard paste
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return
      const files = Array.from(e.clipboardData?.items || [])
        .filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) as File[]
      if (files.length) {
        await importFiles(files)
        return
      }
      const text = (
        e.clipboardData?.getData('text/uri-list') ||
        e.clipboardData?.getData('text/plain') ||
        ''
      ).trim()
      if (text && await importUrl(text)) e.preventDefault()
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [importFiles, importUrl])

  return (
    <div className={styles.app}>
      <TitleBar />
      <div className={styles.body}>
        {sidebarOpen && <Sidebar />}
        <div className={[
          styles.workspace,
          dragOver ? styles.dragActive : '',
          sidebarOpen ? styles.hasSidebar : '',
          inspectorOpen ? styles.hasInspector : '',
        ].filter(Boolean).join(' ')}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}>
          {/* Sidebar open button — shown only when sidebar is collapsed */}
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              title="Open sidebar"
              className={styles.panelExpandLeft}
            >
              <PanelLeft size={14} strokeWidth={1.8} />
            </button>
          )}
          {/* Right-edge button — shown only when inspector is collapsed */}
          {!inspectorOpen && (
            <button
              onClick={() => setInspectorOpen(true)}
              title="Open inspector"
              className={styles.panelExpandRight}
            >
              <PanelRight size={14} strokeWidth={1.8} />
            </button>
          )}
          {/* Always show MainContent — skeleton mode while the async asset load is running */}
          <MainContent dbReady={dbReady && !assetsLoading} />
          <ProcessDock sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} />
          {dragOver && (
            <div className={styles.dropOverlay}>
              <div className={styles.dropBox}>
                <div className={styles.dropArrow}><ArrowDown size={28} strokeWidth={2}/></div>
                <p>Drop to import</p>
                <p className={styles.dropSub}>Images · Videos · Audio · Fonts · 3D</p>
              </div>
            </div>
          )}
        </div>
        {inspectorOpen && <Inspector />}
      </div>
      <LightboxModal />
      <ToastNotification />
    </div>
  )
}
