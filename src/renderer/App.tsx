import { useEffect, useCallback, useRef, useState } from 'react'
import { applyImportThreads, enqueueBackgroundThumbs } from './thumbEngine'
import { useStore } from './store/useStore'
import { isImage } from './utils/helpers'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import MainContent from './components/MainContent'
import Inspector from './components/Inspector'
import LightboxModal from './components/LightboxModal'
import ToastNotification from './components/ToastNotification'
import styles from './styles/App.module.css'

// Set dev flag for console logging in store
// true when running via 'npm run dev' (Vite dev server on localhost)
if (typeof window !== 'undefined') (window as any).__DEV__ = location.hostname === 'localhost' || location.hostname === '127.0.0.1'

export default function App() {
  const {
    setAssets, setFolders, setTags, setSmartFolders,
    dragOver, setDragOver, inspectorOpen, sidebarOpen,
    importFiles, assets, setAiSettings, startAiQueue,
  } = useStore()

  const initialized = useRef(false)
  const [dbReady, setDbReady] = useState(false)

  // Load persisted data ONCE — show skeleton immediately, populate after
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    ;(async () => {
      try {
        const saved = await (window as any).electronAPI?.dbLoad()
        if (saved?.assets?.length)       setAssets(saved.assets)
        if (saved?.tags?.length)         setTags(saved.tags)
        if (saved?.smartFolders?.length) setSmartFolders(saved.smartFolders)

        // Folders: if the DB has any rows use them as the source of truth.
        // If the DB has none (fresh install), seed the in-memory defaults into
        // the DB so future deletes actually persist.
        if (saved?.folders?.length) {
          setFolders(saved.folders)
        } else {
          // First launch — write defaults to DB so deletes stick from now on
          const defaults = useStore.getState().folders
          for (const f of defaults) {
            await (window as any).electronAPI?.dbUpsertFolder(f).catch(() => {})
          }
        }

        // Enqueue background thumbnail generation for any video/3D assets
        // that don't yet have a thumbnail (e.g. from a previous session that
        // was closed before the queue finished).
        if (saved?.assets?.length) {
          setTimeout(() => enqueueBackgroundThumbs(saved.assets), 1000)
        }

        // Apply saved theme on startup
        const settings = await (window as any).electronAPI?.loadSettings()
        if (settings) {
          const r = document.documentElement
          const hexToRgb = (hex: string): [number,number,number] => {
            const h = hex.replace('#',''), n = parseInt(h.length===3?h.split('').map((c:string)=>c+c).join(''):h,16)
            return [(n>>16)&255,(n>>8)&255,n&255]
          }
          const bg = settings.bgColor || '#0a0c10'
          const ac = settings.accentColor || '#4a9eff'
          const [br,bgc,bb] = hexToRgb(bg)
          const l = (v: number, a: number) => Math.min(255, Math.round(v+a))
          const rgba = (rv: number, gv: number, bv: number, a: number) => `rgba(${rv},${gv},${bv},${a})`
          r.style.setProperty('--bg-app', bg)
          r.style.setProperty('--bg-primary',   rgba(l(br,4), l(bgc,4), l(bb,6),  0.97))
          r.style.setProperty('--bg-secondary',  rgba(l(br,8), l(bgc,8), l(bb,12), 0.97))
          r.style.setProperty('--bg-tertiary',   rgba(l(br,14),l(bgc,14),l(bb,20), 0.93))
          r.style.setProperty('--bg-card',       rgba(l(br,10),l(bgc,10),l(bb,16), 0.90))
          r.style.setProperty('--accent', ac)
          r.style.setProperty('--accent-hover', ac+'ee')
          r.style.setProperty('--accent-dim',   ac+'28')
          r.style.setProperty('--glass-opacity', String(settings.glassOpacity ?? 0.07))
          r.style.setProperty('--blur-strength', `${settings.blurStrength ?? 18}px`)
          const root = document.getElementById('root')
          if (root) root.style.background = [
            'radial-gradient(ellipse 130% 60% at 50% -5%, rgba(74,158,255,0.06) 0%, transparent 55%)',
            'radial-gradient(ellipse 70% 45% at 100% 100%, rgba(60,80,200,0.04) 0%, transparent 55%)',
            bg,
          ].join(',')
          document.body.style.background = bg
        }
        // Apply thread count to video queue concurrency
        if (settings?.threads) applyImportThreads(settings.threads)

        // Load AI settings
        if (settings?.aiSettings) {
          setAiSettings(settings.aiSettings)
          // Resume AI tagging for any images not yet tagged (including web-grabbed).
          // Wait 4 seconds: gives scanInboxOnStartup() time to finish importing
          // any files that arrived while the app was closed, so they appear in
          // dbGetUntaggedImages before we query it.
          if (settings.aiSettings.enabled) {
            setTimeout(async () => {
              const untagged = await (window as any).electronAPI?.dbGetUntaggedImages?.() || []
              if (untagged.length > 0) {
                if ((window as any).__DEV__) console.log(`[AI] Resuming queue: ${untagged.length} untagged images`)
                const storeAssets = useStore.getState().assets
                // Match untagged DB rows against store assets, then fall back to
                // building a minimal asset object from the DB row for any that
                // aren't in the store yet (e.g. freshly web-grabbed on this boot)
                const toTag = untagged.map((u: any) => {
                  return storeAssets.find(a => a.id === u.id) || {
                    id: u.id, name: u.name, ext: u.ext, filePath: u.filePath,
                    tags: [], folders: [], rating: 0, notes: '', url: '',
                    colors: [], annotation: [], size: 0, mtime: 0, btime: 0,
                    importTime: 0, thumbnailData: undefined,
                  }
                }).filter(Boolean)
                if (toTag.length > 0) useStore.getState().startAiQueue(toTag)
              }
            }, 4000)
          }
        }
      } catch (e) {
        console.error('load failed', e)
      } finally {
        setDbReady(true)
      }
    })()
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
      }))
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
        return { assets: [...freshAssets, ...s.assets], tags: [...newTagSet] }
      })
      useStore.getState().showToast(
        `📥 ${newAssets.length} image${newAssets.length !== 1 ? 's' : ''} added from browser`,
        'success'
      )
      // Start AI tagging for newly grabbed images if AI is enabled.
      // startAiQueue handles the "already running" case internally — it appends
      // to the shared pending queue so no images are ever dropped.
      if (freshAssets.length > 0) {
        const { aiSettings, ollamaSessionFailed } = useStore.getState()
        if (aiSettings.enabled && !ollamaSessionFailed) {
          const newImages = freshAssets.filter(a => isImage(a.ext))
          if (newImages.length > 0) {
            setTimeout(() => useStore.getState().startAiQueue(newImages), 800)
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

    type ThumbUpdate = { id: string; thumbUrl: string; width?: number; height?: number }
    const pending = new Map<string, ThumbUpdate>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      flushTimer = null
      if (!pending.size) return
      const updates = new Map(pending)
      pending.clear()
      useStore.setState(s => ({
        assets: s.assets.map(a => {
          const u = updates.get(a.id)
          if (!u) return a
          return { ...a, thumbnailData: u.thumbUrl, width: u.width ?? a.width, height: u.height ?? a.height }
        })
      }))
    }

    const unsub = api.onThumbDone((data: ThumbUpdate) => {
      pending.set(data.id, data)
      if (!flushTimer) flushTimer = setTimeout(flush, 150)
    })

    return () => {
      unsub()
      if (flushTimer) { clearTimeout(flushTimer); flush() }
    }
  }, [])

  // Drag & drop
  const handleDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(true) }, [])
  const handleDragEnter = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(true) }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.relatedTarget || (e.relatedTarget as HTMLElement).nodeName === 'HTML') setDragOver(false)
  }, [])
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) await importFiles(files)
  }, [importFiles])

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const s = useStore.getState()
      const { selectedAssetIds, deleteAssets, permanentDeleteWithPrompt, clearSelection, selectAll,
              assets, setLightboxAsset, lightboxAsset, filteredAssetIds, activeFolderType } = s

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAssetIds.length > 0) {
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
      // Grid arrow nav
      if (['ArrowRight','ArrowLeft','ArrowUp','ArrowDown'].includes(e.key)) {
        e.preventDefault()
        if (filteredAssetIds.length === 0) return
        if (selectedAssetIds.length === 0) {
          s.setSelectedAssetIds([filteredAssetIds[0]]); return
        }
        if (selectedAssetIds.length === 1) {
          const idx = filteredAssetIds.indexOf(selectedAssetIds[0])
          const colW = s.thumbnailSize + 8
          const cols = Math.max(1, Math.floor((window.innerWidth - 500) / colW))
          let next = idx
          if (e.key === 'ArrowRight') next = idx + 1
          if (e.key === 'ArrowLeft')  next = idx - 1
          if (e.key === 'ArrowDown')  next = idx + cols
          if (e.key === 'ArrowUp')    next = idx - cols
          next = Math.max(0, Math.min(filteredAssetIds.length - 1, next))
          s.setSelectedAssetIds([filteredAssetIds[next]])
          document.getElementById(`asset-${filteredAssetIds[next]}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      }
      if (e.key === 'Enter' && selectedAssetIds.length === 1) {
        const a = assets.find(x => x.id === selectedAssetIds[0])
        if (a) (window as any).electronAPI?.openPath(a.filePath)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Clipboard paste
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const files = Array.from(e.clipboardData?.items || [])
        .filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) as File[]
      if (files.length) await importFiles(files)
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [importFiles])

  return (
    <div className={styles.app} onDragOver={handleDragOver} onDragEnter={handleDragEnter}
         onDragLeave={handleDragLeave} onDrop={handleDrop}>
      <TitleBar />
      <div className={styles.body}>
        {sidebarOpen && <Sidebar />}
        <div className={`${styles.workspace} ${dragOver ? styles.dragActive : ''}`}>
          {/* Always show MainContent — skeleton mode when !dbReady */}
          <MainContent dbReady={dbReady} />
          {dragOver && (
            <div className={styles.dropOverlay}>
              <div className={styles.dropBox}>
                <div className={styles.dropArrow}>⬇</div>
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
