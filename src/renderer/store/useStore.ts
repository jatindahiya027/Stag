import { create } from 'zustand'
import { Asset, Folder, SmartFolder, ViewMode, ImportProgress, AiSettings, AiProgress } from '../types'
import { generateId, getFileExt, isImage, isVideo } from '../utils/helpers'
import { enqueueBackgroundThumbs, applyImportThreads } from '../thumbEngine'

// ── Compress full image → thumbnail (max 600px, JPEG 0.88) ───────────────────
function compressToSmallThumb(dataUrl: string): Promise<{
  dataUrl: string; origW: number; origH: number
  colors: { hex: string; ratio: number }[]
}> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const origW = img.naturalWidth, origH = img.naturalHeight
      const MAX = 600
      const ratio = Math.min(MAX / origW, MAX / origH, 1)
      const w = Math.max(1, Math.round(origW * ratio))
      const h = Math.max(1, Math.round(origH * ratio))
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d', { alpha: false })!
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, w, h)
      const colors: { hex: string; ratio: number }[] = []
      try {
        const px = ctx.getImageData(0, 0, w, h).data
        const buckets: Record<string, { r: number; g: number; b: number; n: number }> = {}
        for (let i = 0; i < px.length; i += 12) {
          if (px[i + 3] < 128) continue
          const r = Math.round(px[i]   / 42) * 42
          const g = Math.round(px[i+1] / 42) * 42
          const b = Math.round(px[i+2] / 42) * 42
          const k = `${r},${g},${b}`
          if (!buckets[k]) buckets[k] = { r, g, b, n: 0 }
          buckets[k].n++
        }
        Object.values(buckets).sort((a, b) => b.n - a.n).slice(0, 5).forEach((v, i) => {
          colors.push({ hex: '#' + [v.r, v.g, v.b].map(n => n.toString(16).padStart(2, '0')).join(''), ratio: [0.35, 0.25, 0.2, 0.12, 0.08][i] || 0.05 })
        })
      } catch {}
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.88), origW, origH, colors })
    }
    img.onerror = () => resolve({ dataUrl, origW: 0, origH: 0, colors: [] })
    img.src = dataUrl
  })
}

const DEFAULT_TYPE_TAGS: Record<string, string[]> = {
  jpg: ['Image', 'Photo'], jpeg: ['Image', 'Photo'], png: ['Image'],
  gif: ['Image', 'Animated'], webp: ['Image'], bmp: ['Image'],
  tiff: ['Image'], tif: ['Image'], ico: ['Image', 'Icon'],
  avif: ['Image'], heic: ['Image', 'Photo'], heif: ['Image', 'Photo'],
  raw: ['Image', 'RAW', 'Photo'], cr2: ['Image', 'RAW', 'Photo'], nef: ['Image', 'RAW', 'Photo'],
  svg: ['Vector', 'SVG'],
  glb: ['3D', 'Model'], obj: ['3D', 'Model'], fbx: ['3D', 'Model'], blend: ['3D', 'Model'],
  dae: ['3D', 'Model'], stl: ['3D', 'Mesh'], gltf: ['3D', 'Model'],
  mp4: ['Video'], mov: ['Video'], webm: ['Video'], avi: ['Video'], mkv: ['Video'],
  ts: ['Video'], mts: ['Video'], m2ts: ['Video'], mpg: ['Video'], mpeg: ['Video'],
  flv: ['Video'], wmv: ['Video'], m4v: ['Video'], rmvb: ['Video'], '3gp': ['Video'],
  mp3: ['Audio'], wav: ['Audio'], flac: ['Audio', 'Lossless'], aac: ['Audio'], m4a: ['Audio'],
  ogg: ['Audio'], opus: ['Audio'], wma: ['Audio'],
  pdf: ['Document', 'PDF'],
  psd: ['Design', 'Photoshop'], ai: ['Design', 'Illustrator'],
  fig: ['Design', 'Figma'], sketch: ['Design', 'Sketch'],
  ttf: ['Font'], otf: ['Font'], woff: ['Font'], woff2: ['Font'],
}

// ── Convenience wrapper ───────────────────────────────────────────────────────
const api = () => (window as any).electronAPI as Record<string, (...a: any[]) => Promise<any>>

interface ToastState { message: string; type: 'success' | 'error' | 'info'; duration?: number }

interface Store {
  assets: Asset[]
  folders: Folder[]
  smartFolders: SmartFolder[]
  tags: string[]
  selectedAssetIds: string[]
  filteredAssetIds: string[]
  activeFolder: string | null
  activeFolderType: 'all'|'uncategorized'|'untagged'|'trash'|'folder'|'smart'|'alltags'
  searchQuery: string
  viewMode: ViewMode
  thumbnailSize: number
  sortBy: 'name'|'date'|'size'|'rating'
  sortDir: 'asc'|'desc'
  filterRating: number
  filterExts: string[]
  isLoading: boolean
  importProgress: ImportProgress | null
  inspectorOpen: boolean
  sidebarOpen: boolean
  dragOver: boolean
  lightboxAsset: Asset | null
  toast: ToastState | null

  setAssets:       (a: Asset[]) => void
  setFolders:      (f: Folder[]) => void
  setTags:         (t: string[]) => void
  setSmartFolders: (s: SmartFolder[]) => void

  importFiles:     (files: File[]) => Promise<void>
  updateAsset:     (id: string, updates: Partial<Asset>) => void
  deleteAssets:    (ids: string[]) => void
  restoreAssets:   (ids: string[]) => void
  permanentDelete: (ids: string[]) => void
  permanentDeleteWithPrompt: (ids: string[]) => Promise<void>
  permanentDeleteDbOnly: (ids: string[]) => void

  setSelectedAssetIds: (ids: string[]) => void
  toggleSelectAsset:   (id: string, multi: boolean) => void
  selectAll:           (ids: string[]) => void
  clearSelection:      () => void
  setFilteredAssetIds: (ids: string[]) => void

  setActiveFolder: (id: string | null, type: Store['activeFolderType']) => void
  addFolder:       (name: string, parentId: string | null, color: string) => void
  updateFolder:    (id: string, updates: Partial<Folder>) => void
  deleteFolder:    (id: string) => void

  setSearchQuery:   (q: string) => void
  setThumbnailSize: (n: number) => void
  setSortBy:        (by: Store['sortBy']) => void
  toggleSortDir:    () => void
  setFilterRating:  (r: number) => void
  toggleFilterExt:  (ext: string) => void
  clearFilters:     () => void

  setLoading:        (v: boolean) => void
  setInspectorOpen:  (v: boolean) => void
  setSidebarOpen:    (v: boolean) => void
  setDragOver:       (v: boolean) => void
  setLightboxAsset:  (a: Asset | null) => void

  addTag:    (tag: string) => void
  deleteTag: (tag: string) => void

  addSmartFolder:    (sf: SmartFolder) => void
  updateSmartFolder: (id: string, updates: Partial<SmartFolder>) => void
  deleteSmartFolder: (id: string) => void

  aiSettings: AiSettings
  aiProgress: AiProgress | null
  ollamaSessionFailed: boolean   // if true, don't call Ollama this session
  _aiStopped: boolean              // internal: set by stopAiQueue to break the loop

  setAiSettings:  (s: AiSettings) => void | Promise<void>
  startAiQueue:   (assets: Asset[]) => void   // enqueue images for tagging
  stopAiQueue:    () => void
  setOllamaFailed:(v: boolean) => void

  showToast:  (msg: string, type?: ToastState['type'], duration?: number) => void
  clearToast: () => void

  // Legacy compat — kept so components that call persist() don't crash.
  // It's now a no-op because every mutation goes directly to SQLite.
  persist: () => void
}

const DEFAULT_FOLDERS: Folder[] = [
  { id: 'inspiration',    name: 'Inspiration',    parentId: null,           color: '#f5a623', icon: '💡', autoTags: [], sortOrder: 0 },
  { id: 'ai-prompts',     name: 'AI Prompts',     parentId: 'inspiration',  color: '#9b59b6', icon: '🤖', autoTags: [], sortOrder: 0 },
  { id: 'illustrations',  name: 'Illustrations',  parentId: 'inspiration',  color: '#e74c3c', icon: '🎨', autoTags: [], sortOrder: 1 },
  { id: 'photography',    name: 'Photography',    parentId: 'inspiration',  color: '#3498db', icon: '📷', autoTags: [], sortOrder: 2 },
  { id: 'design-assets',  name: 'Design Assets',  parentId: null,           color: '#4a9eff', icon: '📦', autoTags: [], sortOrder: 1 },
  { id: 'icons',          name: 'Icons',          parentId: 'design-assets',color: '#ffd93d', icon: '⭐', autoTags: [], sortOrder: 0 },
  { id: 'fonts',          name: 'Fonts',          parentId: 'design-assets',color: '#6bcb77', icon: '🔤', autoTags: [], sortOrder: 1 },
  { id: 'models-3d',      name: '3D Models',      parentId: null,           color: '#e91e63', icon: '🎲', autoTags: [], sortOrder: 2 },
  { id: 'tutorials',      name: 'Tutorials',      parentId: null,           color: '#ff922b', icon: '📚', autoTags: [], sortOrder: 3 },
]

export const useStore = create<Store>((set, get) => ({
  assets: [], folders: DEFAULT_FOLDERS,
  smartFolders: [
    { id: 'sf-1', name: 'High Rated (4+)', rules: [{ field: 'rating', operator: 'gte', value: 4 }], logic: 'ALL' },
    { id: 'sf-2', name: 'Untagged',        rules: [{ field: 'tags',   operator: 'is',  value: '' }], logic: 'ALL' },
  ],
  tags: [], selectedAssetIds: [], filteredAssetIds: [],
  activeFolder: null, activeFolderType: 'all',
  searchQuery: '', viewMode: 'grid', thumbnailSize: 200,
  sortBy: 'date', sortDir: 'desc', filterRating: 0, filterExts: [],
  isLoading: false, importProgress: null,
  inspectorOpen: true, sidebarOpen: true, dragOver: false,
  lightboxAsset: null, toast: null,

  // No-op: all mutations now write directly to SQLite via IPC.
  // Kept so any legacy persist() calls in components don't crash.
  persist: () => {},

  setAssets:       (assets)       => set({ assets }),
  setFolders:      (folders)      => set({ folders }),
  setTags:         (tags)         => set({ tags }),
  setSmartFolders: (smartFolders) => set({ smartFolders }),

  // ── Import ────────────────────────────────────────────────────────────────
  importFiles: async (files: File[]) => {
    const existing      = get().assets
    const existingKeys  = new Set(existing.map(a => `${a.filePath}|${a.size}`))
    const existingPaths = new Set(existing.map(a => a.filePath))

    const toImport = files.filter(f => {
      const fp = (f as any).path || f.name
      return !existingKeys.has(`${fp}|${f.size}`) && !existingPaths.has(fp)
    })
    if (!toImport.length) { get().showToast('All files already imported', 'info'); return }

    // Read thread count + copy settings
    const settings = await api().loadSettings().catch(() => null)
    const threads = Math.max(1, settings?.threads ?? 4)
    applyImportThreads(threads)

    // ── Copy-on-import: copy files to configured folder before registering ──
    // If importCopyEnabled is on, each file is copied to importCopyPath first.
    // We build a plain {file, resolvedPath} pair — the File object is only used
    // for metadata (name, size, lastModified). The filePath stored in the DB
    // always comes from resolvedPath (copy dest if enabled, original otherwise).
    type FilePair = { file: any; resolvedPath: string; resolvedName: string }
    let filePairs: FilePair[] = toImport.map((f: any) => ({
      file: f,
      resolvedPath: (f as any).path || f.name,
      resolvedName: f.name,
    }))

    if (settings?.importCopyEnabled && settings?.importCopyPath) {
      const srcPaths = toImport.map((f: any) => (f as any).path || f.name)
      const copyResult = await (api() as any).importCopyCopyFiles(srcPaths).catch(() => null)
      if (copyResult?.ok && copyResult.results) {
        const pathMap = new Map<string, string>()
        for (const r of copyResult.results) {
          if (r.ok && r.dest) pathMap.set(r.src, r.dest)
        }
        filePairs = toImport.map((f: any) => {
          const origPath = (f as any).path || f.name
          const destPath = pathMap.get(origPath)
          return {
            file: f,
            // resolvedPath points to the COPY if copy succeeded, else original
            resolvedPath: (destPath && destPath !== origPath) ? destPath : origPath,
            resolvedName: f.name,
          }
        })
      }
    }

    set({ isLoading: true, importProgress: { total: filePairs.length, current: 0, currentName: '', done: false } })

    const newTagSet      = new Set(get().tags)
    const importedAssets: Asset[] = []
    const db = api()

    // ── Process in batches of `threads` ──────────────────────────────────────
    for (let batchStart = 0; batchStart < filePairs.length; batchStart += threads) {
      const batchPairs = filePairs.slice(batchStart, batchStart + threads)
      const batchAssets: Asset[] = []

      // ── Phase 1: build asset objects + write to DB ────────────────────────
      for (let j = 0; j < batchPairs.length; j++) {
        const { file, resolvedPath, resolvedName } = batchPairs[j]
        const filePath = resolvedPath
        const ext      = getFileExt(file.name)
        const name     = file.name.replace(/\.[^.]+$/, '')
        const globalIdx = batchStart + j

        set({ importProgress: {
          total: filePairs.length,
          current: globalIdx + 1,
          currentName: `${name}.${ext}`,
          done: false,
        }})

        const autoTags = [...(DEFAULT_TYPE_TAGS[ext] || [])]
        autoTags.forEach(t => newTagSet.add(t))

        const asset: Asset = {
          id: generateId(), name, ext, filePath,
          thumbnailData: undefined,
          size: file.size, width: undefined, height: undefined,
          mtime: file.lastModified, btime: file.lastModified,
          importTime: Date.now() + globalIdx, // slight offset keeps import order stable
          tags: autoTags, folders: [], rating: 0, notes: '', url: '', colors: [], annotation: [],
        }

        await db.dbInsertAsset(asset)
        batchAssets.push(asset)
        importedAssets.push(asset)
      }

      // ── Phase 2: flush batch to store so cards appear immediately ─────────
      set(s => {
        const existingIds = new Set(s.assets.map(a => a.id))
        const fresh = batchAssets.filter(a => !existingIds.has(a.id))
        return fresh.length ? { assets: [...s.assets, ...fresh] } : {}
      })

      // Yield one frame so React can paint the new cards before we block on thumbs
      await new Promise(r => requestAnimationFrame ? requestAnimationFrame(r) : setTimeout(r, 16))

      // ── Phase 3: thumbnails for this batch ──────────────────────────────────
      // Images + PDF + EPUB → main-process IPC batch (fast, blocking per batch).
      // Videos + 3D → background renderer queues (async, non-blocking).

      const imageItems = batchAssets
        .filter(a => isImage(a.ext) || a.ext === 'pdf' || a.ext === 'epub')
        .map(a => ({ id: a.id, filePath: a.filePath, ext: a.ext }))

      const videoAnd3dItems = batchAssets
        .filter(a => isVideo(a.ext) || ['glb','gltf','obj','fbx','dae','stl'].includes(a.ext))

      // Image thumbnails: blocking IPC per batch (gives the Eagle-style
      // "each batch appears with thumbs" feel)
      if (imageItems.length > 0) {
        const thumbResults = await db.generateThumbBatch(imageItems).catch(() => [] as any[])
        if (thumbResults?.length) {
          const resultMap = new Map<string, { thumbUrl: string; width?: number; height?: number }>()
          for (const r of thumbResults) { if (r?.thumbUrl) resultMap.set(r.id, r) }
          if (resultMap.size > 0) {
            set(s => ({
              assets: s.assets.map(a => {
                const r = resultMap.get(a.id)
                return r ? { ...a, thumbnailData: r.thumbUrl, width: r.width ?? a.width, height: r.height ?? a.height } : a
              })
            }))
          }
        }
      }

      // Video + 3D: enqueue in background renderer — non-blocking, runs while
      // next batch is being imported and after import completes.
      if (videoAnd3dItems.length > 0) {
        enqueueBackgroundThumbs(videoAnd3dItems)
      }

      // Brief yield between batches so UI stays interactive
      await new Promise(r => setTimeout(r, 0))
    }

    set({ isLoading: false, importProgress: null, tags: [...newTagSet] })
    const copiedNote = settings?.importCopyEnabled && settings?.importCopyPath ? ' (copied to library)' : ''
    get().showToast(`Imported ${importedAssets.length} file${importedAssets.length !== 1 ? 's' : ''}${copiedNote}`, 'success')

    // Start AI tagging queue for newly imported images (if enabled)
    const { aiSettings, ollamaSessionFailed, aiProgress } = get()
    if (aiSettings.enabled && !ollamaSessionFailed && !aiProgress?.active) {
      const newImages = importedAssets.filter(a => isImage(a.ext))
      if (newImages.length > 0) {
        if ((window as any).__DEV__) console.log(`[AI] Queuing ${newImages.length} new images for tagging`)
        setTimeout(() => get().startAiQueue(newImages), 500)
      }
    }

    // Main-process background worker picks up any images that nativeImage failed.
    // Video/3D are already in the renderer background queue from enqueueBackgroundThumbs.
    api().startThumbWorker?.().catch(() => {})
  },

  // ── updateAsset — writes only changed fields, not the whole library ───────
  updateAsset: (id, updates) => {
    set(s => ({ assets: s.assets.map(a => a.id === id ? { ...a, ...updates } : a) }))
    // Fire-and-forget: IPC is async but we don't need to await it in the store
    api().dbUpdateAsset(id, updates).catch(() => {})
  },

  deleteAssets: (ids) => {
    const now = Date.now()
    const idSet = new Set(ids)
    set(s => ({
      assets: s.assets.map(a => idSet.has(a.id) ? { ...a, deleted: true, deletedAt: now } : a),
      selectedAssetIds: s.selectedAssetIds.filter(i => !idSet.has(i)),
    }))
    api().dbBatchUpdate(ids.map(id => ({ id, updates: { deleted: true, deletedAt: now } }))).catch(() => {})
    get().showToast(`Moved ${ids.length} item${ids.length !== 1 ? 's' : ''} to trash`)
  },

  // Permanently delete with smart disk-deletion logic:
  // - Files inside inbox or importCopyPath (managed) → always delete from disk automatically
  // - Files from original user locations → show OS dialog asking what to do
  permanentDeleteWithPrompt: async (ids: string[]) => {
    const storeAssets = get().assets
    const idSet = new Set(ids)
    const targets = storeAssets.filter(a => idSet.has(a.id))

    // Split into managed (copies/inbox) vs original-location files
    const managedIds: string[] = []
    const originalIds: string[] = []
    for (const asset of targets) {
      const isManaged = await (api() as any).importCopyIsCopied?.(asset.filePath).catch(() => false)
      if (isManaged) managedIds.push(asset.id)
      else originalIds.push(asset.id)
    }

    // Remove from UI immediately for all
    const allIdSet = new Set(ids)
    set(s => ({
      assets: s.assets.filter(a => !allIdSet.has(a.id)),
      selectedAssetIds: s.selectedAssetIds.filter(i => !allIdSet.has(i)),
    }))

    // Managed files: delete from disk automatically (they are our copies/inbox files)
    if (managedIds.length > 0) {
      api().dbHardDeleteAssets(managedIds).catch(() => {})
    }

    // Original files: ask the user
    if (originalIds.length > 0) {
      const origTargets = targets.filter(t => originalIds.includes(t.id))
      const msg = originalIds.length === 1
        ? `"${origTargets[0]?.name}.${origTargets[0]?.ext}" is from its original location.\n\nAlso delete the file from disk? Or just remove it from Stag?`
        : `${originalIds.length} files are from their original locations.\n\nAlso delete them from disk? Or just remove from Stag?`
      const choice = await (api() as any).showDeleteDialog?.({ message: msg }).catch(() => null)
      if (choice === true) {
        // "Delete from Disk" — remove files AND DB records
        api().dbHardDeleteAssetsFromDisk(originalIds).catch(() => {})
      } else {
        // "Remove from Stag Only" or cancelled — DB records removed, files stay on disk
        api().dbHardDeleteAssetsDbOnly(originalIds).catch(() => {})
      }
    }

    get().showToast(`Permanently deleted ${ids.length} item${ids.length !== 1 ? 's' : ''}`, 'error')
  },

  // Remove from DB only — does NOT delete files from disk
  permanentDeleteDbOnly: (ids: string[]) => {
    const idSet = new Set(ids)
    set(s => ({
      assets: s.assets.filter(a => !idSet.has(a.id)),
      selectedAssetIds: s.selectedAssetIds.filter(i => !idSet.has(i)),
    }))
    api().dbHardDeleteAssetsDbOnly(ids).catch(() => {})
    get().showToast(`Removed ${ids.length} item${ids.length !== 1 ? 's' : ''} from library`, 'info')
  },

  restoreAssets: (ids) => {
    set(s => ({ assets: s.assets.map(a => ids.includes(a.id) ? { ...a, deleted: false, deletedAt: undefined } : a) }))
    api().dbBatchUpdate(ids.map(id => ({ id, updates: { deleted: false, deletedAt: null } }))).catch(() => {})
    get().showToast(`Restored ${ids.length} item${ids.length !== 1 ? 's' : ''}`, 'success')
  },

  permanentDelete: (ids) => {
    const idSet = new Set(ids)
    set(s => ({
      assets: s.assets.filter(a => !idSet.has(a.id)),
      selectedAssetIds: s.selectedAssetIds.filter(i => !idSet.has(i)),
    }))
    api().dbHardDeleteAssets(ids).catch(() => {})
    get().showToast(`Permanently deleted ${ids.length} item${ids.length !== 1 ? 's' : ''}`, 'error')
  },

  setSelectedAssetIds: (ids) => set({ selectedAssetIds: ids }),
  toggleSelectAsset: (id, multi) => set(s => {
    if (!multi) { const only = s.selectedAssetIds.length === 1 && s.selectedAssetIds[0] === id; return { selectedAssetIds: only ? [] : [id] } }
    const has = s.selectedAssetIds.includes(id)
    return { selectedAssetIds: has ? s.selectedAssetIds.filter(i => i !== id) : [...s.selectedAssetIds, id] }
  }),
  selectAll:           (ids) => set({ selectedAssetIds: ids }),
  clearSelection:      ()    => set({ selectedAssetIds: [] }),
  setFilteredAssetIds: (ids) => set({ filteredAssetIds: ids }),

  setActiveFolder: (id, type) => set({ activeFolder: id, activeFolderType: type, selectedAssetIds: [] }),

  addFolder: (name, parentId, color) => {
    const f: Folder = { id: generateId(), name, parentId, color, icon: '📁', autoTags: [], sortOrder: 999 }
    set(s => ({ folders: [...s.folders, f] }))
    api().dbUpsertFolder(f).catch(() => {})
  },
  updateFolder: (id, u) => {
    set(s => ({ folders: s.folders.map(f => f.id === id ? { ...f, ...u } : f) }))
    const folder = get().folders.find(f => f.id === id)
    if (folder) api().dbUpsertFolder({ ...folder, ...u }).catch(() => {})
  },
  deleteFolder: (id) => {
    set(s => ({
      folders: s.folders.filter(f => f.id !== id && f.parentId !== id),
      assets: s.assets.map(a => ({ ...a, folders: a.folders.filter(f => f !== id) })),
    }))
    api().dbDeleteFolder(id).catch(() => {})
  },

  addSmartFolder: (sf) => {
    set(s => ({ smartFolders: [...s.smartFolders, sf] }))
    api().dbUpsertSmartFolder(sf).catch(() => {})
  },
  updateSmartFolder: (id, updates) => {
    set(s => ({ smartFolders: s.smartFolders.map(sf => sf.id === id ? { ...sf, ...updates } : sf) }))
    const sf = get().smartFolders.find(s => s.id === id)
    if (sf) api().dbUpsertSmartFolder({ ...sf, ...updates }).catch(() => {})
  },
  deleteSmartFolder: (id) => {
    set(s => ({ smartFolders: s.smartFolders.filter(sf => sf.id !== id) }))
    api().dbDeleteSmartFolder(id).catch(() => {})
  },

  setSearchQuery:   (q)   => set({ searchQuery: q }),
  setThumbnailSize: (n)   => set({ thumbnailSize: n }),
  setSortBy:        (by)  => set({ sortBy: by }),
  toggleSortDir:    ()    => set(s => ({ sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' })),
  setFilterRating:  (r)   => set({ filterRating: r }),
  toggleFilterExt:  (ext) => set(s => ({ filterExts: s.filterExts.includes(ext) ? s.filterExts.filter(e => e !== ext) : [...s.filterExts, ext] })),
  clearFilters:     ()    => set({ filterRating: 0, filterExts: [], searchQuery: '' }),

  setLoading:       (v) => set({ isLoading: v }),
  setInspectorOpen: (v) => set({ inspectorOpen: v }),
  setSidebarOpen:   (v) => set({ sidebarOpen: v }),
  setDragOver:      (v) => set({ dragOver: v }),
  setLightboxAsset: (a) => set({ lightboxAsset: a }),

  addTag: (tag) => {
    set(s => ({ tags: s.tags.includes(tag) ? s.tags : [...s.tags, tag] }))
    api().dbAddTag(tag).catch(() => {})
  },
  deleteTag: (tag) => {
    set(s => ({
      tags: s.tags.filter(t => t !== tag),
      assets: s.assets.map(a => ({ ...a, tags: a.tags.filter(t => t !== tag) })),
    }))
    api().dbDeleteTag(tag).catch(() => {})
  },

  aiSettings: { enabled: false, ollamaUrl: 'http://localhost:11434', model: 'llava' },
  aiProgress: null,
  ollamaSessionFailed: false,
  _aiStopped: false,

  setAiSettings: async (s) => {
    set({ aiSettings: s })
    try {
      const cur = await api().loadSettings() || {}
      await api().saveSettings({ ...cur, aiSettings: s })
    } catch {}
  },
  setOllamaFailed: (v) => set({ ollamaSessionFailed: v }),
  stopAiQueue: () => set({ aiProgress: null, _aiStopped: true }),

  // ── AI tagging queue ─────────────────────────────────────────────────────
  startAiQueue: (imagesToTag: Asset[]) => {
    const isDev = !!(window as any).__DEV__
    if (!imagesToTag.length) return
    const { aiSettings, ollamaSessionFailed } = get()
    if (!aiSettings.enabled || ollamaSessionFailed) return

    set({ aiProgress: { total: imagesToTag.length, done: 0, current: '', active: true }, _aiStopped: false })

    if (isDev) console.log(`[AI] Starting queue: ${imagesToTag.length} images, model: ${aiSettings.model}`)

    // Run async, one at a time
    ;(async () => {
      let done = 0
      for (const asset of imagesToTag) {
        const { aiSettings: s, ollamaSessionFailed: failed, _aiStopped: stopped } = get()
        if (!s.enabled || failed || stopped) {
          if (isDev) console.log('[AI] Queue stopped (disabled or session failed)')
          break
        }
        set(st => ({ aiProgress: st.aiProgress ? { ...st.aiProgress, current: `${asset.name}.${asset.ext}`, active: true } : null }))
        try {
          if (isDev) console.log(`[AI] Processing ${asset.name}.${asset.ext} (${done + 1}/${imagesToTag.length})`)
          const result = await api().ollamaTagImage(asset.filePath, s.model, s.ollamaUrl)

          if (!result.ok) {
            if (isDev) console.log(`[AI] ✗ ${asset.name}: ${result.error} (fatal=${result.fatal})`)
            if (result.fatal) {
              // Connection down — stop entire session
              set({ ollamaSessionFailed: true })
              if (isDev) console.log('[AI] Session failed — stopping queue')
              break
            }
            // Non-fatal (bad JSON, model error, unreadable file) — skip, continue
            done++
          } else {
            const { tags: aiTags, description } = result
            const existing = get().assets.find(a => a.id === asset.id)?.tags || []
            const merged = [...new Set([...existing, ...aiTags])]
            // If asset has no user notes yet, pre-populate with AI description so
            // user can see and edit it in the same notes box (editable from the start)
            const currentNotes = get().assets.find(a => a.id === asset.id)?.notes || ''
            const notesToWrite = currentNotes.trim() ? currentNotes : (description ? `🤖 ${description}` : '')
            if (notesToWrite && !currentNotes.trim()) {
              await api().dbUpdateAsset({ id: asset.id, notes: notesToWrite })
            }
            await api().dbSetAiTagged(asset.id, description, aiTags)
            set(st => ({
              assets: st.assets.map(a => a.id === asset.id
                ? { ...a, tags: merged, aiTagged: true, aiDescription: description,
                    notes: currentNotes.trim() ? currentNotes : notesToWrite }
                : a),
              tags: [...new Set([...st.tags, ...aiTags])],
            }))
            done++
            if (isDev) console.log(`[AI] ✓ ${asset.name}: tags=[${aiTags.join(', ')}]`)
          }
        } catch (e: any) {
          // Unexpected error (IPC failure etc.) — log and skip
          const msg = e?.message || String(e)
          if (isDev) console.log(`[AI] Unexpected error on ${asset.name}: ${msg}`)
          done++
        }
        set(st => ({ aiProgress: st.aiProgress ? { ...st.aiProgress, done, total: imagesToTag.length } : null }))
        await new Promise(r => setTimeout(r, 100))  // small yield between images
      }
      set({ aiProgress: null })
      if (isDev) console.log(`[AI] Queue complete. Processed: ${done}/${imagesToTag.length}`)
    })()
  },

  showToast:  (message, type = 'info', duration = 2500) => set({ toast: { message, type, duration } }),
  clearToast: () => set({ toast: null }),
}))
