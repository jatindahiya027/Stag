import { create } from 'zustand'
import { Asset, Folder, SmartFolder, ViewMode, ImportProgress, CopyProgress, AiSettings, AiProgress, AiFeatureStatus, SearchField } from '../types'
import { generateId, getFileExt, isImage, isVideo, is3D, extractPaletteOnceForAsset } from '../utils/helpers'
import { applyImportThreads, generateBackgroundThumbsSequential } from '../thumbEngine'
import { createRendererLogger } from '../utils/logger'

const log = createRendererLogger('store')
const RECENT_ASSET_IDS_KEY = 'stag-recent-asset-ids'
const RECENT_ASSET_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000

type RecentAssetEntry = { id: string; usedAt: number }

function loadRecentAssetEntries(now = Date.now()): RecentAssetEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_ASSET_IDS_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    const entries = parsed
      .filter((entry): entry is RecentAssetEntry => (
        !!entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        Number.isFinite(entry.usedAt) &&
        now - entry.usedAt <= RECENT_ASSET_MAX_AGE_MS
      ))
      .sort((a, b) => b.usedAt - a.usedAt)
      .slice(0, 100)
    localStorage.setItem(RECENT_ASSET_IDS_KEY, JSON.stringify(entries))
    return entries
  } catch {
    return []
  }
}

function loadRecentAssetIds() {
  return loadRecentAssetEntries().map(entry => entry.id)
}

const OLLAMA_NATIVE_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp'])
const AI_TAGGABLE_DOCUMENT_EXTS = new Set(['pdf', 'epub'])

export function isAiTaggableAsset(asset: Partial<Asset> | undefined) {
  if (!asset?.ext) return false
  const ext = asset.ext.toLowerCase()
  if (isImage(ext) && OLLAMA_NATIVE_IMAGE_EXTS.has(ext)) return !!asset.filePath
  return (isImage(ext) || isVideo(ext) || is3D(ext) || AI_TAGGABLE_DOCUMENT_EXTS.has(ext)) && !!asset.thumbnailData
}

async function savePaletteFromThumbnail(asset: Asset, thumbUrl?: string) {
  await extractPaletteOnceForAsset(asset.id, thumbUrl, asset.colors, colors => {
    const latest = useStore.getState().assets.find(a => a.id === asset.id)
    if (!latest?.colors?.length) useStore.getState().updateAsset(asset.id, { colors })
  })
}

function thumbConsole(message: string, details: Record<string, unknown> = {}) {
  const extra = Object.keys(details).length ? ' ' + JSON.stringify(details) : ''
  console.log(`[Thumb UI ${new Date().toISOString()}] ${message}${extra}`)
}

async function syncThumbStateFromDb(ids: string[]) {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return 0
  const api = (window as any).electronAPI
  const rows = await api?.dbGetThumbState?.(uniqueIds).catch(() => []) || []
  const resultMap = new Map<string, { thumbUrl: string; thumbnailVariants?: { sm?: string; md?: string; lg?: string }; width?: number; height?: number }>()
  for (const r of rows) {
    if (r?.id && r.thumbUrl) resultMap.set(r.id, r)
  }
  if (!resultMap.size) return 0
  useStore.setState(s => ({
    assets: s.assets.map(a => {
      const r = resultMap.get(a.id)
      return r ? { ...a, thumbnailData: r.thumbUrl, thumbnailVariants: r.thumbnailVariants ?? a.thumbnailVariants, width: r.width ?? a.width, height: r.height ?? a.height } : a
    })
  }))
  return resultMap.size
}

function assetLogItem(asset: Partial<Asset> | undefined) {
  if (!asset) return null
  const displayName = asset.name ? `${asset.name}${asset.ext ? `.${asset.ext}` : ''}` : asset.filePath
  return {
    id: asset.id,
    name: asset.name,
    ext: asset.ext,
    displayName,
    filePath: asset.filePath,
  }
}

function assetLogItems(assets: Partial<Asset>[]) {
  return assets.map(assetLogItem).filter(Boolean)
}

function notifyAssetMutation(reason: string, ids: string[] = [], phase: 'optimistic' | 'committed' = 'committed') {
  try {
    window.dispatchEvent(new CustomEvent('stag:assets-mutated', { detail: { reason, ids, phase, time: Date.now() } }))
  } catch {}
}

const NON_STRUCTURAL_ASSET_UPDATE_KEYS = new Set([
  'thumbnailData',
  'thumbnailVariants',
  'width',
  'height',
  'duration',
  'colors',
  'annotation',
  'aiEmbedded',
])

function affectsAssetQuery(updates: Partial<Asset>) {
  return Object.keys(updates).some(key => !NON_STRUCTURAL_ASSET_UPDATE_KEYS.has(key))
}

function fileLogItem(file: any) {
  return {
    name: file?.name,
    path: file?.path || file?.name,
    size: file?.size,
    type: file?.type,
  }
}

function normalizeWebsiteUrl(rawValue: string) {
  const trimmed = String(rawValue || '').trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
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
  flv: ['Video'], wmv: ['Video'], m4v: ['Video'], f4v: ['Video'], rmvb: ['Video'], '3gp': ['Video'],
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
  assetQueryVersion: number
  folders: Folder[]
  smartFolders: SmartFolder[]
  tags: string[]
  selectedAssetIds: string[]
  filteredAssetIds: string[]
  activeFolder: string | null
  activeFolderType: 'all'|'uncategorized'|'untagged'|'recent'|'random'|'trash'|'folder'|'smart'|'alltags'
  recentAssetIds: string[]
  searchQuery: string
  searchFields: SearchField[]
  viewMode: ViewMode
  thumbnailSize: number
  sortBy: 'name'|'date'|'size'|'rating'
  sortDir: 'asc'|'desc'
  filterRating: number
  filterExts: string[]
  isLoading: boolean
  importProgress: ImportProgress | null
  copyProgress: CopyProgress | null
  inspectorOpen: boolean
  sidebarOpen: boolean
  folderName: string
  displayCount: number
  setToolbarState: (name: string, count: number) => void
  dragOver: boolean
  lightboxAsset: Asset | null
  toast: ToastState | null

  setAssets:       (a: Asset[]) => void
  setFolders:      (f: Folder[]) => void
  setTags:         (t: string[]) => void
  setSmartFolders: (s: SmartFolder[]) => void

  importFiles:     (files: File[]) => Promise<void>
  importUrl:       (url: string) => Promise<boolean>
  updateAsset:     (id: string, updates: Partial<Asset>) => void
  renameAsset:     (id: string, name: string) => Promise<boolean>
  deleteAssets:    (ids: string[]) => void
  restoreAssets:   (ids: string[]) => void
  permanentDeleteWithPrompt: (ids: string[]) => Promise<void>

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
  setSearchFields:  (fields: SearchField[]) => void
  setViewMode:      (mode: ViewMode) => void
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
  pruneRecentAssets: () => void

  addTag:    (tag: string) => void
  deleteTag: (tag: string) => void
  deleteAllTags: () => void

  addSmartFolder:    (sf: SmartFolder) => void
  updateSmartFolder: (id: string, updates: Partial<SmartFolder>) => void
  deleteSmartFolder: (id: string) => void

  aiSettings: AiSettings
  aiProgress: AiProgress | null
  aiFeatureStatus: AiFeatureStatus | null
  ollamaSessionFailed: boolean   // if true, don't call Ollama this session
  _aiStopped: boolean              // internal: set by stopAiQueue to break the loop

  setAiSettings:  (s: AiSettings) => void | Promise<void>
  hydrateAiSettings: (s: AiSettings) => void
  setAiFeatureStatus: (s: AiFeatureStatus | null) => void
  startAiQueue:   (assets: Asset[]) => void   // enqueue images for tagging
  stopAiQueue:    () => void
  setOllamaFailed:(v: boolean) => void

  showToast:  (msg: string, type?: ToastState['type'], duration?: number) => void
  clearToast: () => void

  // AI image search (TIPSv2)
  aiSearchMode: boolean
  aiSearchResultIds: string[] | null
  aiIndexProgress: { type: string; current?: number; total?: number; file?: string; indexed?: number } | null
  aiIndexStatus: { hasIndex: boolean; indexed: number; pending?: number; total: number; running?: boolean } | null
  dinoIndexProgress: { type: string; current?: number; total?: number; file?: string; indexed?: number; error?: string } | null
  dinoIndexStatus: { enabled: boolean; hasIndex: boolean; indexed: number; pending: number; total: number; running: boolean; modelLoaded: boolean; assetIds: string[] } | null
  aiSearchLoading: boolean
  aiStatusLoading: boolean
  setAiSearchMode:      (v: boolean) => void
  setAiSearchResultIds: (ids: string[] | null) => void
  setAiIndexProgress:   (p: Store['aiIndexProgress']) => void
  setAiIndexStatus:     (s: Store['aiIndexStatus']) => void
  setDinoIndexProgress: (p: Store['dinoIndexProgress']) => void
  setDinoIndexStatus:   (s: Store['dinoIndexStatus']) => void
  markAssetsEmbedded:   (ids: string[]) => void
  setAiSearchLoading:   (v: boolean) => void
  setAiStatusLoading:   (v: boolean) => void
  sensitiveTags: string[]
  showSensitiveContent: boolean
  setSensitiveTags: (tags: string[]) => void
  setShowSensitiveContent: (v: boolean) => void

}

const DEFAULT_FOLDERS: Folder[] = [
  { id: 'inspiration',       name: 'Inspiration',      parentId: null,            color: '#cd10da', icon: 'lightbulb', autoTags: [], sortOrder: 0 },
  { id: 'ai-prompts',        name: 'AI Prompts',       parentId: 'inspiration',   color: '#cd10da', icon: 'folder',    autoTags: [], sortOrder: 0 },
  { id: 'illustrations',     name: 'Illustrations',    parentId: 'inspiration',   color: '#cd10da', icon: 'folder',    autoTags: [], sortOrder: 1 },
  { id: 'photography',       name: 'Photography',      parentId: 'inspiration',   color: '#cd10da', icon: 'folder',    autoTags: [], sortOrder: 2 },
  { id: 'interior-design',   name: 'Interior Design',  parentId: 'inspiration',   color: '#cd10da', icon: 'folder',    autoTags: [], sortOrder: 3 },
  { id: 'game-concepts',     name: 'Game Concepts',    parentId: 'inspiration',   color: '#cd10da', icon: 'folder',    autoTags: [], sortOrder: 4 },
  { id: 'ui-design',         name: 'UI Design',        parentId: 'inspiration',   color: '#cd10da', icon: 'folder',    autoTags: [], sortOrder: 5 },
  { id: 'motion-graphics',   name: 'Motion Graphics',  parentId: 'inspiration',   color: '#cd10da', icon: 'folder',    autoTags: [], sortOrder: 6 },
  { id: 'design-assets',     name: 'Design Assets',    parentId: null,            color: '#b66cff', icon: 'briefcase', autoTags: [], sortOrder: 1 },
  { id: 'packaging-mockup',  name: 'Packaging Mockup', parentId: 'design-assets', color: '#b66cff', icon: 'folder',    autoTags: [], sortOrder: 0 },
  { id: 'icons',             name: 'Icons',            parentId: 'design-assets', color: '#b66cff', icon: 'folder',    autoTags: [], sortOrder: 1 },
  { id: 'fonts',             name: 'Fonts',            parentId: 'design-assets', color: '#b66cff', icon: 'folder',    autoTags: [], sortOrder: 2 },
  { id: 'audio',             name: 'Audio',            parentId: 'design-assets', color: '#b66cff', icon: 'folder',    autoTags: [], sortOrder: 3 },
]

// Shared pending queue — lives outside the store so the async loop can mutate it without triggering re-renders
const _aiPendingQueue: Asset[] = []
let _aiQueueRunning = false
let _aiActiveAssetId: string | null = null
let _importQueueTail: Promise<void> = Promise.resolve()
let _importQueueDepth = 0

export const useStore = create<Store>((set, get) => ({
  assets: [], folders: DEFAULT_FOLDERS,
  smartFolders: [
    { id: 'sf-1', name: 'High Rated (4+)', rules: [{ field: 'rating', operator: 'gte', value: 4 }], logic: 'ALL' },
    { id: 'sf-2', name: 'Untagged',        rules: [{ field: 'tags',   operator: 'is',  value: '' }], logic: 'ALL' },
  ],
  tags: [], selectedAssetIds: [], filteredAssetIds: [],
  assetQueryVersion: 0,
  activeFolder: null, activeFolderType: 'all',
  recentAssetIds: loadRecentAssetIds(),
  searchQuery: '', searchFields: ['name', 'description', 'extension', 'tag'], viewMode: 'masonry', thumbnailSize: 200,
  sortBy: 'date', sortDir: 'desc', filterRating: 0, filterExts: [],
  isLoading: false, importProgress: null, copyProgress: null,
  inspectorOpen: true, sidebarOpen: true, dragOver: false,
  lightboxAsset: null, toast: null,
  folderName: 'All', displayCount: 0,
  aiSearchMode: false, aiSearchResultIds: null, aiIndexProgress: null,
  aiIndexStatus: null, dinoIndexProgress: null, dinoIndexStatus: null,
  aiSearchLoading: false, aiStatusLoading: false,
  sensitiveTags: [], showSensitiveContent: false,

  setAssets:       (assets)       => set(s => ({ assets, assetQueryVersion: s.assetQueryVersion + 1 })),
  setFolders:      (folders)      => set({ folders }),
  setTags:         (tags)         => set({ tags }),
  setSmartFolders: (smartFolders) => set({ smartFolders }),

  // ── Import ────────────────────────────────────────────────────────────────
  importFiles: async (files: File[]) => {
    const queuedFiles = [...files]
    const queuedPosition = _importQueueDepth + 1
    _importQueueDepth += 1
    const runImportSession = async () => {
      if (queuedPosition > 1) {
        get().showToast(`Import queued behind ${queuedPosition - 1} active session${queuedPosition - 1 !== 1 ? 's' : ''}`, 'info', 3500)
      }
      let importJobId: string | null = null
      try {
    files = queuedFiles
    log.info('import.start', { count: files.length, files: files.map(fileLogItem) })
    importJobId = await (api() as any).createJob?.('import', { files: files.map(fileLogItem) }, files.length).catch(() => null)
    if (importJobId) await (api() as any).updateJob?.(importJobId, { status: 'running', total: files.length, message: 'Preparing import' }).catch(() => {})
    const resolveFilePath = (file: any) => {
      const apiPath = (window as any).electronAPI?.getPathForFile?.(file)
      const rawPath = file?.path || apiPath || ''
      return typeof rawPath === 'string' ? rawPath : ''
    }
    const importInputs = files
      .map((file: any) => ({ file, sourcePath: resolveFilePath(file) }))
      .filter(({ sourcePath }) => sourcePath && sourcePath !== '.')

    if (!importInputs.length) {
      log.warn('import.skipped_no_file_paths', { count: files.length, files: files.map(fileLogItem) })
      get().showToast('Could not read file paths from the import. Try the Import button or restart the app.', 'error', 5000)
      return
    }

    const existing      = get().assets
    const existingKeys  = new Set(existing.map(a => `${a.filePath}|${a.size}`))
    const existingPaths = new Set(existing.map(a => a.filePath))

    const toImport = importInputs.filter(({ file, sourcePath }) => {
      return !existingKeys.has(`${sourcePath}|${file.size}`) && !existingPaths.has(sourcePath)
    })
    if (!toImport.length) {
      log.info('import.skipped_all_existing', { count: files.length })
      get().showToast('All files already imported', 'info'); return
    }

    // Read thread count + copy settings
    const settings = await api().loadSettings().catch(() => null)
    const threads = Math.max(1, settings?.threads ?? 4)
    applyImportThreads(threads)
    log.info('import.settings_loaded', { threads, copyPath: settings?.importCopyPath })

    // ── Copy-on-import: copy files to the managed folder before registering ──
    // We build a plain {file, resolvedPath} pair — the File object is only used
    // for metadata (name, size, lastModified). The filePath stored in the DB
    // always comes from resolvedPath in Stag's managed local folder.
    type FilePair = { file: any; resolvedPath: string; resolvedName: string }
    let filePairs: FilePair[] = toImport.map(({ file, sourcePath }: any) => ({
      file,
      resolvedPath: sourcePath,
      resolvedName: file.name,
    }))

    {
      const srcPaths = toImport.map(({ sourcePath }: any) => sourcePath)
      log.info('import.copy_on_import.start', {
        count: srcPaths.length,
        dest: settings.importCopyPath,
        files: toImport.map(({ file }: any) => fileLogItem(file)),
        srcPaths,
      })

      // Subscribe to streaming progress events from main process
      const unsub = (window as any).electronAPI?.onCopyProgress?.((data: CopyProgress | null) => {
        if (data === null) { set({ copyProgress: null }); return }
        set({ copyProgress: data })
      })

      const copyResult = await (api() as any).importCopyCopyFiles(srcPaths, importJobId).catch(() => null)
      unsub?.()
      set({ copyProgress: null })
      const copyResults = Array.isArray(copyResult?.results) ? copyResult.results : []
      const copiedCount = copyResults.filter((r: any) => r?.ok).length
      const failedCount = copyResults.filter((r: any) => !r?.ok).length
      log.info('import.copy_on_import.done', {
        ok: copyResult?.ok,
        reason: copyResult?.reason,
        resultCount: copyResults.length,
        copiedCount,
        failedCount,
        dest: settings.importCopyPath,
        results: copyResults.map((r: any) => ({
          ok: !!r?.ok,
          src: r?.src,
          dest: r?.dest,
          fileName: r?.dest ? r.dest.replace(/\\/g, '/').split('/').pop() : r?.src?.replace(/\\/g, '/').split('/').pop(),
          error: r?.error || r?.reason,
        })),
      })

      if (!copyResult?.results) {
        get().showToast('Import stopped because files could not be copied to the managed folder.', 'error', 5000)
        return
      }
      const pathMap = new Map<string, string>()
      for (const r of copyResult.results) {
        if (r.ok && r.dest) pathMap.set(r.src, r.dest)
      }
      filePairs = toImport.flatMap(({ file, sourcePath }: any) => {
        const destPath = pathMap.get(sourcePath)
        return destPath ? [{
          file,
          resolvedPath: destPath,
          resolvedName: file.name,
        }] : []
      })
      if (!filePairs.length) {
        get().showToast('Import stopped because no files could be copied to the managed folder.', 'error', 5000)
        return
      }
      if (failedCount > 0) {
        get().showToast(`${failedCount} file${failedCount === 1 ? '' : 's'} could not be copied and were skipped.`, 'error', 5000)
      }
    }

    set({ isLoading: true, importProgress: { jobId: importJobId || undefined, status: 'running', total: filePairs.length, current: 0, currentName: '', done: false } })
    if (importJobId) await (api() as any).updateJob?.(importJobId, { status: 'running', total: filePairs.length, current: 0, message: 'Importing assets' }).catch(() => {})

    const newTagSet      = new Set(get().tags)
    const importedAssets: Asset[] = []
    const db = api()
    let thumbnailQueue: Promise<void> = Promise.resolve()
    const allImageThumbItems: Array<{ id: string; filePath: string; ext: string }> = []
    const allMediaThumbItems: Asset[] = []
    const importBatchSize = Math.min(Math.max(threads * 4, 32), 64)
    const thumbConcurrency = Math.max(1, Math.floor(threads || 1))
    const shouldReadPreThumbMetadata = filePairs.length <= 200

    // ── Process in larger import batches; thumbnail batches are bounded below.
    for (let batchStart = 0; batchStart < filePairs.length; batchStart += importBatchSize) {
      const batchPairs = filePairs.slice(batchStart, batchStart + importBatchSize)
      const batchAssets: Asset[] = []
      log.debug('import.batch.start', { batchStart, count: batchPairs.length })

      // ── Phase 1: build asset objects ─────────────────────────────────────
      const now = Date.now()
      for (let j = 0; j < batchPairs.length; j++) {
        const { file, resolvedPath } = batchPairs[j]
        const filePath  = resolvedPath
        const ext       = getFileExt(file.name)
        const name      = file.name.replace(/\.[^.]+$/, '')
        const globalIdx = batchStart + j
        const autoTags  = [...(DEFAULT_TYPE_TAGS[ext] || [])]
        autoTags.forEach(t => newTagSet.add(t))
        batchAssets.push({
          id: generateId(), name, ext, filePath,
          thumbnailData: undefined,
          size: file.size, width: undefined, height: undefined,
          mtime: file.lastModified, btime: file.lastModified,
          importTime: now + globalIdx,
          tags: autoTags, folders: [], rating: 0, notes: '', url: '', colors: [], annotation: [],
        })
        importedAssets.push(batchAssets[batchAssets.length - 1])
      }

      const imageMetaItems = batchAssets
        .filter(a => isImage(a.ext))
        .map(a => ({ id: a.id, filePath: a.filePath, ext: a.ext }))
      if (shouldReadPreThumbMetadata && imageMetaItems.length > 0) {
        const metaStarted = Date.now()
        thumbConsole('metadata:batch:start', { count: imageMetaItems.length })
        const metaResults = await (db as any).readMetadataBatch?.(imageMetaItems).catch(() => [] as any[])
        const metaMap = new Map<string, { width?: number; height?: number }>()
        for (const r of metaResults || []) {
          if (r?.id && r.width > 0 && r.height > 0) metaMap.set(r.id, { width: r.width, height: r.height })
        }
        if (metaMap.size > 0) {
          for (const asset of batchAssets) {
            const dims = metaMap.get(asset.id)
            if (dims) {
              asset.width = dims.width
              asset.height = dims.height
            }
          }
        }
        thumbConsole('metadata:batch:applied', { requested: imageMetaItems.length, applied: metaMap.size, ms: Date.now() - metaStarted })
      }

      // Single IPC call for the whole batch — one flushDB + one rebuildDirWatchers
      await db.dbBatchInsertAssets(batchAssets)
      log.info('import.batch.inserted', { batchStart, count: batchAssets.length, assets: assetLogItems(batchAssets) })

      set({ importProgress: {
        jobId: importJobId || undefined,
        status: 'running',
        total: filePairs.length,
        current: batchStart + batchAssets.length,
        currentName: batchAssets[batchAssets.length - 1]
          ? `${batchAssets[batchAssets.length - 1].name}.${batchAssets[batchAssets.length - 1].ext}`
          : '',
        done: false,
      }})
      if (importJobId) await (api() as any).updateJob?.(importJobId, {
        status: 'running',
        total: filePairs.length,
        current: batchStart + batchAssets.length,
        message: batchAssets[batchAssets.length - 1] ? `${batchAssets[batchAssets.length - 1].name}.${batchAssets[batchAssets.length - 1].ext}` : 'Importing assets',
      }).catch(() => {})

      // ── Phase 2: flush batch to store so cards appear immediately ─────────
      set(s => {
        const existingIds = new Set(s.assets.map(a => a.id))
        const fresh = batchAssets.filter(a => !existingIds.has(a.id))
        return fresh.length ? { assets: [...s.assets, ...fresh], assetQueryVersion: s.assetQueryVersion + 1 } : {}
      })
      notifyAssetMutation('import', batchAssets.map(a => a.id))

      // Yield one frame so React can paint the new cards before we block on thumbs
      await new Promise(r => requestAnimationFrame ? requestAnimationFrame(r) : setTimeout(r, 16))

      const imageItems = batchAssets
        .filter(a => isImage(a.ext) || a.ext === 'pdf' || a.ext === 'epub')
        .map(a => ({ id: a.id, filePath: a.filePath, ext: a.ext }))

      const videoAnd3dItems = batchAssets
        .filter(a => isVideo(a.ext) || is3D(a.ext))

      // Collect thumbnail work only. Actual generation starts after all assets
      // have been inserted into SQLite and rendered in the grid.
      allImageThumbItems.push(...imageItems)
      allMediaThumbItems.push(...videoAnd3dItems)

      // Brief yield between batches so UI stays interactive
      await new Promise(r => setTimeout(r, 0))
    }

    set({ isLoading: false, importProgress: null, tags: [...newTagSet] })
    if (importJobId) await (api() as any).updateJob?.(importJobId, { status: 'completed', total: filePairs.length, current: filePairs.length, message: 'Import completed' }).catch(() => {})
    const copiedNote = ' (copied to library)'
    get().showToast(`Imported ${importedAssets.length} file${importedAssets.length !== 1 ? 's' : ''}${copiedNote}`, 'success')
    log.info('import.done', { imported: importedAssets.length, copied: !!copiedNote, assets: assetLogItems(importedAssets), tags: [...newTagSet] })

    thumbConsole('post-import:thumbs:start', {
      imageCount: allImageThumbItems.length,
      mediaCount: allMediaThumbItems.length,
      thumbConcurrency,
    })
    const totalImportThumbs = allImageThumbItems.length + allMediaThumbItems.length
    if (totalImportThumbs > 0) {
      window.dispatchEvent(new CustomEvent('stag:thumbProgress', {
        detail: { type: 'import-thumbs', current: 0, total: totalImportThumbs },
      }))
    }

    if (allImageThumbItems.length > 0) {
      const queuedItems = allImageThumbItems
      thumbConsole('batch:queued', {
        count: queuedItems.length,
        concurrency: thumbConcurrency,
        ids: queuedItems.map(i => i.id),
      })
      log.debug('import.thumbs.batch.queued', { count: queuedItems.length, concurrency: thumbConcurrency })
      thumbnailQueue = thumbnailQueue.then(async () => {
        const started = Date.now()
        thumbConsole('batch:start', {
          count: queuedItems.length,
          concurrency: thumbConcurrency,
          files: queuedItems.map(i => `${i.id}:${i.ext}`),
        })
        log.debug('import.thumbs.batch.start', { count: queuedItems.length, concurrency: thumbConcurrency })
        const thumbResults = await db.generateThumbBatch(queuedItems, {
          concurrency: thumbConcurrency,
          progressType: 'import-thumbs',
          progressOffset: 0,
          progressTotal: totalImportThumbs,
        }).catch(() => [] as any[])
        thumbConsole('batch:main-returned', {
          requested: queuedItems.length,
          returned: thumbResults?.length || 0,
          withThumb: (thumbResults || []).filter((r: any) => r?.thumbUrl).length,
          ms: Date.now() - started,
        })
        log.info('import.thumbs.batch.done', { requested: queuedItems.length, returned: thumbResults?.length || 0 })
        if (thumbResults?.length) {
          const resultMap = new Map<string, { thumbUrl: string; thumbnailVariants?: { sm?: string; md?: string; lg?: string }; width?: number; height?: number }>()
          for (const r of thumbResults) { if (r?.thumbUrl) resultMap.set(r.id, r) }
          if (resultMap.size > 0) {
            set(s => ({
              assets: s.assets.map(a => {
                const r = resultMap.get(a.id)
                return r ? { ...a, thumbnailData: r.thumbUrl, thumbnailVariants: r.thumbnailVariants ?? a.thumbnailVariants, width: r.width ?? a.width, height: r.height ?? a.height } : a
              })
            }))
            for (const [id, r] of resultMap) {
              const asset = useStore.getState().assets.find(a => a.id === id)
              if (asset && !asset.colors?.length) savePaletteFromThumbnail(asset, r.thumbUrl)
            }
            thumbConsole('batch:ui-updated', {
              count: resultMap.size,
              ids: [...resultMap.keys()],
              ms: Date.now() - started,
            })
            await new Promise<void>(resolve => {
              const raf = typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as any
              raf(() => raf(() => resolve()))
            })
          }
        }
      }).catch((e) => {
        thumbConsole('batch:error', { message: e?.message || String(e) })
      })
    }

    if (allMediaThumbItems.length > 0) {
      log.info('import.thumbs.media_queued', { count: allMediaThumbItems.length, items: assetLogItems(allMediaThumbItems) })
      thumbnailQueue = thumbnailQueue.then(async () => {
        const started = Date.now()
        thumbConsole('media:max:start', {
          count: allMediaThumbItems.length,
          files: allMediaThumbItems.map(i => `${i.id}:${i.ext}`),
        })
        const completedIds = await generateBackgroundThumbsSequential(allMediaThumbItems, {
          variantMode: 'none',
          notifyVariants: false,
        }, {
          type: 'import-thumbs',
          offset: allImageThumbItems.length,
          total: totalImportThumbs,
        })
        thumbConsole('media:max:done', {
          requested: allMediaThumbItems.length,
          completed: completedIds.length,
          ids: completedIds,
          ms: Date.now() - started,
        })
        if (completedIds.length > 0) {
          await new Promise<void>(resolve => {
            const raf = typeof requestAnimationFrame === 'function'
              ? requestAnimationFrame
              : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as any
            raf(() => raf(() => setTimeout(resolve, 80)))
          })
        }
      }).catch((e) => {
        thumbConsole('media:max:error', { message: e?.message || String(e) })
      })
    }

    const thumbSyncIds = [...new Set([
      ...allImageThumbItems.map(item => item.id),
      ...allMediaThumbItems.map(item => item.id),
    ])]
    const thumbSyncTimer = thumbSyncIds.length
      ? window.setInterval(() => {
          syncThumbStateFromDb(thumbSyncIds)
            .then(count => { if (count) thumbConsole('sync:thumb-state', { count }) })
            .catch(() => {})
        }, 1000)
      : null

    // Start AI tagging queue for newly imported assets that already have an AI-readable source.
    // Video/3D assets are queued by thumbEngine as soon as their max thumbnail is saved.
    // startAiQueue handles the "already running" case — safe to call unconditionally.
    const { aiSettings, ollamaSessionFailed } = get()
    if (aiSettings.enabled && !ollamaSessionFailed) {
      const readyAssets = importedAssets.filter(a => isAiTaggableAsset(a))
      if (readyAssets.length > 0) {
        log.info('ai.tagging.queue_imported_assets', { count: readyAssets.length, items: assetLogItems(readyAssets) })
        setTimeout(() => get().startAiQueue(readyAssets), 500)
      }
    }

    // Rebuild dir watchers once after full import (not per-batch — that blocks IPC).
    api().rebuildWatchers?.().catch(() => {})
    // Main-process background worker picks up anything thumbnail batches could not handle.
    // Run after the queued image batches to avoid duplicate work during import.
    thumbnailQueue.finally(async () => {
      if (thumbSyncTimer) window.clearInterval(thumbSyncTimer)
      if (totalImportThumbs > 0) {
        window.dispatchEvent(new CustomEvent('stag:thumbProgress', {
          detail: {
            type: 'done',
            scope: 'import-thumbs',
            current: totalImportThumbs,
            total: totalImportThumbs,
          },
        }))
      }
      const syncedCount = await syncThumbStateFromDb(thumbSyncIds).catch(() => 0)
      thumbConsole('sync:thumb-state-final', { count: syncedCount })
      thumbConsole('fallback-worker:start-request')
      api().startThumbWorker?.().catch((e: any) => thumbConsole('fallback-worker:error', { message: e?.message || String(e) }))
    })
      } catch (e) {
        log.error('import.failed', { message: (e as any)?.message || String(e) })
        if (importJobId) await (api() as any).updateJob?.(importJobId, { status: 'failed', error: (e as any)?.message || String(e), message: 'Import failed' }).catch(() => {})
        get().showToast(`Import failed: ${(e as any)?.message || String(e)}`, 'error', 6500)
      } finally {
        set({ isLoading: false, importProgress: null, copyProgress: null })
      }
    }
    const previous = _importQueueTail.catch(() => {})
    const queued = previous.then(runImportSession)
    _importQueueTail = queued.finally(() => { _importQueueDepth = Math.max(0, _importQueueDepth - 1) })
    return queued
  },

  importUrl: async (rawUrl: string) => {
    const url = normalizeWebsiteUrl(rawUrl)
    if (!url) return false

    const existing = get().assets.find(asset => asset.ext === 'url' && asset.url === url && !asset.deleted)
    if (existing) {
      set({ selectedAssetIds: [existing.id] })
      get().showToast('Refreshing website thumbnail…', 'info')
      const captured = await (api() as any).captureWebsiteThumbnail(existing.id, url).catch(() => null)
      if (captured?.ok && captured.thumbUrl) {
        set(state => ({
          assets: state.assets.map(item => item.id === existing.id ? {
            ...item,
            thumbnailData: captured.thumbUrl,
            thumbnailVariants: captured.thumbnailVariants,
            width: captured.width || item.width,
            height: captured.height || item.height,
          } : item),
        }))
        notifyAssetMutation('url-thumbnail-refresh', [existing.id])
        get().showToast('Website thumbnail refreshed', 'success')
      } else {
        get().showToast('Website is saved, but its thumbnail could not be refreshed', 'error', 5000)
      }
      return true
    }

    const now = Date.now()
    const asset: Asset = {
      id: generateId(),
      name: url,
      ext: 'url',
      filePath: '',
      size: 0,
      width: 1365,
      height: 768,
      mtime: now,
      btime: now,
      importTime: now,
      tags: ['Website'],
      folders: [],
      rating: 0,
      notes: '',
      url,
      colors: [],
      annotation: [],
    }

    const inserted = await (api() as any).dbInsertAsset({ ...asset, hasThumb: false }).catch(() => false)
    if (!inserted) {
      get().showToast('Could not save website', 'error')
      return true
    }

    set(state => ({
      assets: [asset, ...state.assets],
      tags: state.tags.includes('Website') ? state.tags : [...state.tags, 'Website'],
      selectedAssetIds: [asset.id],
      assetQueryVersion: state.assetQueryVersion + 1,
    }))
    notifyAssetMutation('url-import', [asset.id])

    const captured = await (api() as any).captureWebsiteThumbnail(asset.id, url).catch(() => null)
    if (captured?.ok && captured.thumbUrl) {
      set(state => ({
        assets: state.assets.map(item => item.id === asset.id ? {
          ...item,
          thumbnailData: captured.thumbUrl,
          thumbnailVariants: captured.thumbnailVariants,
          width: captured.width || item.width,
          height: captured.height || item.height,
        } : item),
      }))
      notifyAssetMutation('url-thumbnail', [asset.id])
      const savedAsset = get().assets.find(item => item.id === asset.id)
      if (savedAsset) void savePaletteFromThumbnail(savedAsset, captured.thumbUrl)
      get().showToast('Website saved', 'success')
    } else {
      get().showToast('Website saved, but its thumbnail could not be captured', 'info', 5000)
    }
    return true
  },

  // ── updateAsset — writes only changed fields, not the whole library ───────
  updateAsset: (id, updates) => {
    log.debug('asset.update', { id, updates })
    const structural = affectsAssetQuery(updates)
    set(s => ({
      assets: s.assets.map(a => a.id === id ? { ...a, ...updates } : a),
      ...(structural ? { assetQueryVersion: s.assetQueryVersion + 1 } : {}),
    }))
    if (structural) notifyAssetMutation('update', [id], 'optimistic')
    // Fire-and-forget: IPC is async but we don't need to await it in the store
    api().dbUpdateAsset(id, updates).catch(() => {}).finally(() => {
      if (structural) notifyAssetMutation('update', [id], 'committed')
    })
  },

  renameAsset: async (id, rawName) => {
    const asset = get().assets.find(item => item.id === id)
    const name = rawName.trim()
    if (!asset || !name) return false
    if (name === asset.name) return true

    if (asset.ext === 'url' || !asset.filePath) {
      get().updateAsset(id, { name })
      return true
    }

    const result = await (api() as any).renameAssetFile(asset.id, asset.filePath, name, asset.ext).catch(() => null)
    if (!result?.ok || !result.filePath) {
      get().showToast(result?.error || 'Could not rename file', 'error', 5000)
      return false
    }

    set(state => ({
      assets: state.assets.map(item => item.id === id ? { ...item, name, filePath: result.filePath } : item),
      assetQueryVersion: state.assetQueryVersion + 1,
    }))
    notifyAssetMutation('rename', [id], 'optimistic')
    notifyAssetMutation('rename', [id], 'committed')
    get().showToast('File renamed', 'success')
    return true
  },

  deleteAssets: (ids) => {
    const now = Date.now()
    const idSet = new Set(ids)
    const targets = get().assets.filter(a => idSet.has(a.id))
    log.info('asset.trash', { ids, count: ids.length, targets: assetLogItems(targets) })
    set(s => ({
      assets: s.assets.map(a => idSet.has(a.id) ? { ...a, deleted: true, deletedAt: now } : a),
      selectedAssetIds: s.selectedAssetIds.filter(i => !idSet.has(i)),
      assetQueryVersion: s.assetQueryVersion + 1,
    }))
    notifyAssetMutation('trash', ids, 'optimistic')
    api().dbBatchUpdate(ids.map(id => ({ id, updates: { deleted: true, deletedAt: now } }))).catch(() => {}).finally(() => notifyAssetMutation('trash', ids, 'committed'))
    get().showToast(`Moved ${ids.length} item${ids.length !== 1 ? 's' : ''} to trash`)
  },

  // Permanently delete only after explicit disk-deletion confirmation.
  permanentDeleteWithPrompt: async (ids: string[]) => {
    const storeAssets = get().assets
    const idSet = new Set(ids)
    const targets = storeAssets.filter(a => idSet.has(a.id))
    log.info('asset.permanent_delete.prompt', { ids, count: ids.length, targets: assetLogItems(targets) })

    // Always ask the user; cancellation leaves the trash unchanged.
    const msg = ids.length === 1
      ? `Permanently delete "${targets[0]?.name}.${targets[0]?.ext}" from disk?\n\nThis cannot be undone.`
      : `Permanently delete ${ids.length} files from disk?\n\nThis cannot be undone.`
    const choice = await (api() as any).showDeleteDialog?.({ message: msg }).catch(() => null)

    if (choice !== true) {
      log.info('asset.permanent_delete.cancelled', { ids, count: ids.length, targets: assetLogItems(targets) })
      return
    }

    log.warn('asset.permanent_delete.from_disk', { ids, count: ids.length, targets: assetLogItems(targets) })
    const result = await api().dbHardDeleteAssetsFromDisk(ids).catch(() => null)
    const failedIds = new Set<string>((result?.failed || []).map((item: any) => item.id))
    const deletedIds = result && result !== false ? ids.filter(id => !failedIds.has(id)) : []
    if (!deletedIds.length) {
      get().showToast('Files could not be deleted from disk.', 'error', 5000)
      return
    }
    const deletedSet = new Set(deletedIds)
    set(s => ({
      assets: s.assets.filter(a => !deletedSet.has(a.id)),
      selectedAssetIds: s.selectedAssetIds.filter(i => !deletedSet.has(i)),
      assetQueryVersion: s.assetQueryVersion + 1,
    }))
    notifyAssetMutation('permanent-delete', deletedIds, 'committed')
    if (failedIds.size > 0) {
      get().showToast(`${deletedIds.length} deleted; ${failedIds.size} could not be removed from disk.`, 'error', 5000)
    } else {
      get().showToast(`Permanently deleted ${deletedIds.length} item${deletedIds.length !== 1 ? 's' : ''}`, 'error')
    }
  },

  restoreAssets: (ids) => {
    const targets = get().assets.filter(a => ids.includes(a.id))
    log.info('asset.restore', { ids, count: ids.length, targets: assetLogItems(targets) })
    set(s => ({
      assets: s.assets.map(a => ids.includes(a.id) ? { ...a, deleted: false, deletedAt: undefined } : a),
      assetQueryVersion: s.assetQueryVersion + 1,
    }))
    notifyAssetMutation('restore', ids, 'optimistic')
    api().dbBatchUpdate(ids.map(id => ({ id, updates: { deleted: false, deletedAt: null } }))).catch(() => {}).finally(() => notifyAssetMutation('restore', ids, 'committed'))
    get().showToast(`Restored ${ids.length} item${ids.length !== 1 ? 's' : ''}`, 'success')
  },

  setSelectedAssetIds: (ids) => { log.debug('selection.set', { ids, count: ids.length }); set({ selectedAssetIds: ids }) },
  toggleSelectAsset: (id, multi) => set(s => {
    if (!multi) { const only = s.selectedAssetIds.length === 1 && s.selectedAssetIds[0] === id; return { selectedAssetIds: only ? [] : [id] } }
    const has = s.selectedAssetIds.includes(id)
    return { selectedAssetIds: has ? s.selectedAssetIds.filter(i => i !== id) : [...s.selectedAssetIds, id] }
  }),
  selectAll:           (ids) => { log.info('selection.select_all', { count: ids.length }); set({ selectedAssetIds: ids }) },
  clearSelection:      ()    => { log.debug('selection.clear'); set({ selectedAssetIds: [] }) },
  setFilteredAssetIds: (ids) => {
    log.debug('filter.ids_updated', { count: ids.length })
    set(s => {
      if (s.filteredAssetIds.length === ids.length && s.filteredAssetIds.every((id, i) => id === ids[i])) return {}
      return { filteredAssetIds: ids }
    })
  },

  setActiveFolder: (id, type) => { log.info('navigation.active_folder', { id, type }); set({ activeFolder: id, activeFolderType: type, selectedAssetIds: [] }) },

  addFolder: (name, parentId, color) => {
    const f: Folder = { id: generateId(), name, parentId, color, icon: '📁', autoTags: [], sortOrder: 999 }
    log.info('folder.add', { folder: f })
    set(s => ({ folders: [...s.folders, f] }))
    api().dbUpsertFolder(f).catch(() => {})
  },
  updateFolder: (id, u) => {
    log.info('folder.update', { id, updates: u })
    set(s => ({ folders: s.folders.map(f => f.id === id ? { ...f, ...u } : f) }))
    const folder = get().folders.find(f => f.id === id)
    if (folder) api().dbUpsertFolder({ ...folder, ...u }).catch(() => {})
  },
  deleteFolder: (id) => {
    log.warn('folder.delete', { id })
    set(s => ({
      folders: s.folders.filter(f => f.id !== id && f.parentId !== id),
      assets: s.assets.map(a => ({ ...a, folders: a.folders.filter(f => f !== id) })),
      assetQueryVersion: s.assetQueryVersion + 1,
    }))
    api().dbDeleteFolder(id).catch(() => {})
  },

  addSmartFolder: (sf) => {
    log.info('smart_folder.add', { smartFolder: sf })
    set(s => ({ smartFolders: [...s.smartFolders, sf] }))
    api().dbUpsertSmartFolder(sf).catch(() => {})
  },
  updateSmartFolder: (id, updates) => {
    log.info('smart_folder.update', { id, updates })
    set(s => ({ smartFolders: s.smartFolders.map(sf => sf.id === id ? { ...sf, ...updates } : sf) }))
    const sf = get().smartFolders.find(s => s.id === id)
    if (sf) api().dbUpsertSmartFolder({ ...sf, ...updates }).catch(() => {})
  },
  deleteSmartFolder: (id) => {
    log.warn('smart_folder.delete', { id })
    set(s => ({ smartFolders: s.smartFolders.filter(sf => sf.id !== id) }))
    api().dbDeleteSmartFolder(id).catch(() => {})
  },

  setSearchQuery:   (q)   => { log.debug('search.query', { query: q }); set({ searchQuery: q }) },
  setSearchFields:  (fields) => {
    const unique = [...new Set(fields)]
    if (!unique.length) return
    log.debug('search.fields', { fields: unique })
    set({ searchFields: unique })
  },
  setViewMode:      (mode) => {
    log.info('view.mode', { mode })
    set({ viewMode: mode })
    api().loadSettings?.()
      .then((current: any) => api().saveSettings?.({ ...(current || {}), viewMode: mode }))
      .catch(() => {})
  },
  setThumbnailSize: (n)   => {
    const size = Math.max(80, Math.min(320, Math.round(n)))
    log.info('view.thumbnail_size', { size })
    set({ thumbnailSize: size })
    api().loadSettings?.()
      .then((current: any) => api().saveSettings?.({ ...(current || {}), thumbnailSize: size }))
      .catch(() => {})
  },
  setSortBy:        (by)  => { log.info('sort.by', { by }); set({ sortBy: by }) },
  toggleSortDir:    ()    => set(s => { const sortDir = s.sortDir === 'asc' ? 'desc' : 'asc'; log.info('sort.direction', { sortDir }); return { sortDir } }),
  setFilterRating:  (r)   => { log.info('filter.rating', { rating: r }); set({ filterRating: r }) },
  toggleFilterExt:  (ext) => set(s => { const filterExts = s.filterExts.includes(ext) ? s.filterExts.filter(e => e !== ext) : [...s.filterExts, ext]; log.info('filter.ext', { ext, filterExts }); return { filterExts } }),
  clearFilters:     ()    => { log.info('filter.clear'); set({ filterRating: 0, filterExts: [], searchQuery: '' }) },

  setLoading:       (v) => set({ isLoading: v }),
  setToolbarState:  (name, count) => set(s => (
    s.folderName === name && s.displayCount === count ? {} : { folderName: name, displayCount: count }
  )),
  setInspectorOpen: (v) => set({ inspectorOpen: v }),
  setSidebarOpen:   (v) => set({ sidebarOpen: v }),
  setDragOver:      (v) => set({ dragOver: v }),
  pruneRecentAssets: () => set({ recentAssetIds: loadRecentAssetIds() }),
  setLightboxAsset: (a) => {
    if (!a) {
      set({ lightboxAsset: null })
      return
    }
    set(() => {
      const usedAt = Date.now()
      const recentEntries = [
        { id: a.id, usedAt },
        ...loadRecentAssetEntries(usedAt).filter(entry => entry.id !== a.id),
      ].slice(0, 100)
      const recentAssetIds = recentEntries.map(entry => entry.id)
      try { localStorage.setItem(RECENT_ASSET_IDS_KEY, JSON.stringify(recentEntries)) } catch {}
      return { lightboxAsset: a, selectedAssetIds: [a.id], recentAssetIds }
    })
  },

  addTag: (tag) => {
    log.info('tag.add', { tag })
    set(s => ({ tags: s.tags.includes(tag) ? s.tags : [...s.tags, tag] }))
    api().dbAddTag(tag).catch(() => {})
  },
  deleteTag: (tag) => {
    log.warn('tag.delete', { tag })
    set(s => ({
      tags: s.tags.filter(t => t !== tag),
      assets: s.assets.map(a => ({ ...a, tags: a.tags.filter(t => t !== tag) })),
      assetQueryVersion: s.assetQueryVersion + 1,
    }))
    api().dbDeleteTag(tag).catch(() => {})
  },
  deleteAllTags: () => {
    log.warn('tag.delete_all')
    set(s => ({
      tags: [],
      sensitiveTags: [],
      assets: s.assets.map(a => ({ ...a, tags: [] })),
      assetQueryVersion: s.assetQueryVersion + 1,
    }))
    api().dbDeleteAllTags?.().catch(() => {})
  },

  aiSettings: { enabled: false, ollamaUrl: 'http://localhost:11434', model: 'llava' },
  aiProgress: null,
  aiFeatureStatus: null,
  ollamaSessionFailed: false,
  _aiStopped: false,
  setAiFeatureStatus: (aiFeatureStatus) => set({ aiFeatureStatus }),
  hydrateAiSettings: (aiSettings) => set({
    aiSettings,
    ollamaSessionFailed: false,
    _aiStopped: false,
  }),

  setAiSettings: async (s) => {
    const wasEnabled = get().aiSettings.enabled
    let nextSettings = s
    if (s.enabled && !wasEnabled) {
      const availability = await api().ollamaCheck?.(s.ollamaUrl).catch(() => null)
      const models: string[] = availability?.models || []
      if (!availability?.ok || !s.model || !models.includes(s.model)) {
        nextSettings = { ...s, enabled: false }
        get().showToast(
          availability?.ok ? `Ollama model "${s.model}" is not installed.` : 'Cannot enable AI tagging because Ollama is not running.',
          'error',
          5000,
        )
      }
    }
    log.info('ai.settings.update', { previousEnabled: wasEnabled, next: nextSettings })
    set({ aiSettings: nextSettings, ollamaSessionFailed: nextSettings.enabled ? false : get().ollamaSessionFailed })
    const enablingAiTagging = nextSettings.enabled && !wasEnabled
    const localToTag = enablingAiTagging
      ? get().assets.filter(a => !a.aiTagged && isAiTaggableAsset(a))
      : []
    if (enablingAiTagging) {
      set({ aiProgress: { total: localToTag.length, done: 0, current: localToTag.length ? 'Starting AI tagging...' : 'Preparing AI tagging...', active: true }, _aiStopped: false })
      if (localToTag.length > 0) {
        log.info('ai.tagging.enabled_queue_loaded_assets', { count: localToTag.length })
        get().showToast(`AI tagging started for ${localToTag.length} asset${localToTag.length !== 1 ? 's' : ''}.`, 'info')
        setTimeout(() => get().startAiQueue(localToTag), 0)
      }
    }
    try {
      const cur = await api().loadSettings() || {}
      await api().saveSettings({ ...cur, aiSettings: nextSettings })
    } catch {}
    if (enablingAiTagging) {
      try {
        const untagged = await api().dbGetUntaggedImages?.() || []
        const assetsById = new Map(get().assets.map(a => [a.id, a]))
        const toTag = untagged
          .map((u: any) => assetsById.get(u.id) || u)
          .filter((a: Asset) => isAiTaggableAsset(a))
        if (toTag.length > 0) {
          log.info('ai.tagging.enabled_queue_untagged', { count: toTag.length })
          setTimeout(() => get().startAiQueue(toTag), 200)
        } else if (localToTag.length === 0) {
          log.info('ai.tagging.enabled_no_untagged')
          get().showToast('AI tagging enabled. No untagged assets found.', 'info')
          set({ aiProgress: null })
        }
      } catch {
        if (localToTag.length === 0) set({ aiProgress: null })
      }
    }
  },
  setOllamaFailed: (v) => { log.warn('ollama.session_failed.set', { failed: v }); set({ ollamaSessionFailed: v }) },
  stopAiQueue: () => { log.warn('ai.queue.stop_requested'); set({ aiProgress: null, _aiStopped: true }) },

  // ── AI tagging queue ─────────────────────────────────────────────────────
  startAiQueue: (imagesToTag: Asset[]) => {
    log.info('ai.queue.start_requested', { count: imagesToTag.length, items: imagesToTag.map(a => ({ id: a.id, name: a.name, ext: a.ext, filePath: a.filePath })) })
    if (!imagesToTag.length) return
    const { aiSettings, ollamaSessionFailed } = get()
    if (!aiSettings.enabled || ollamaSessionFailed) {
      log.warn('ai.queue.start_skipped', { enabled: aiSettings.enabled, ollamaSessionFailed })
      return
    }

    // Push new images into the shared pending queue (dedup by id)
    const existingIds = new Set(_aiPendingQueue.map(a => a.id))
    if (_aiActiveAssetId) existingIds.add(_aiActiveAssetId)
    for (const a of imagesToTag) {
      if (!a.aiTagged && !existingIds.has(a.id)) { _aiPendingQueue.push(a); existingIds.add(a.id) }
    }

    // If the loop is already running, it will naturally drain the new items — don't start a second loop
    if (_aiQueueRunning) {
      log.info('ai.queue.appended', { appended: imagesToTag.length, pending: _aiPendingQueue.length })
      // Update the total count so the progress indicator reflects the full queue
      set(st => ({ aiProgress: st.aiProgress ? { ...st.aiProgress, total: st.aiProgress.done + _aiPendingQueue.length } : null }))
      return
    }

    _aiQueueRunning = true
    set({ aiProgress: { total: _aiPendingQueue.length, done: 0, current: '', active: true }, _aiStopped: false })
    log.info('ai.queue.started', { pending: _aiPendingQueue.length, model: aiSettings.model })

    // Run async, one at a time — drains _aiPendingQueue which may grow while running
    ;(async () => {
      let done = 0
      let taskToken = ''
      try {
        const lock = await api().acquireAiTask?.('ai-tagging')
        if (!lock?.ok || !lock.token) throw new Error(lock?.error || 'Could not acquire AI task slot')
        taskToken = lock.token
        while (_aiPendingQueue.length > 0) {
        const { aiSettings: s, ollamaSessionFailed: failed, _aiStopped: stopped } = get()
        if (!s.enabled || failed || stopped) {
          log.warn('ai.queue.stopped', { enabled: s.enabled, failed, stopped })
          _aiPendingQueue.length = 0
          break
        }
        const asset = _aiPendingQueue.shift()!
        _aiActiveAssetId = asset.id
        set(st => ({ aiProgress: st.aiProgress ? { ...st.aiProgress, current: `${asset.name}.${asset.ext}`, active: true, total: done + _aiPendingQueue.length + 1 } : null }))
        try {
          log.info('ai.queue.processing', { id: asset.id, name: asset.name, ext: asset.ext, remaining: _aiPendingQueue.length })
          // Ollama only accepts jpg/jpeg/png/webp natively.
          // For supported image formats send the original; for everything else send the thumbnail.
          const OLLAMA_NATIVE = new Set(['jpg', 'jpeg', 'png', 'webp'])
          const imagePath = (isImage(asset.ext) && OLLAMA_NATIVE.has(asset.ext.toLowerCase()))
            ? asset.filePath
            : asset.thumbnailData?.replace(/^file:\/\//, '')
          if (!imagePath) {
            log.warn('ai.queue.skip_no_image_path', { id: asset.id, name: asset.name, ext: asset.ext })
            done++
            _aiActiveAssetId = null
            set(st => ({ aiProgress: st.aiProgress ? { ...st.aiProgress, done, total: done + _aiPendingQueue.length } : null }))
            continue
          }
          const result = await api().ollamaTagImage(imagePath, s.model, s.ollamaUrl)

          if (!result.ok) {
            log.warn('ai.queue.asset_failed', { id: asset.id, name: asset.name, error: result.error, fatal: result.fatal })
            if (result.fatal) {
              // Connection down — stop entire session
              set(state => ({
                ollamaSessionFailed: true,
                aiFeatureStatus: state.aiFeatureStatus ? {
                  ...state.aiFeatureStatus,
                  tagging: { ...state.aiFeatureStatus.tagging, active: false },
                } : null,
              }))
              log.error('ai.queue.session_failed', { id: asset.id, error: result.error })
              _aiPendingQueue.length = 0
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
              await api().dbUpdateAsset(asset.id, { notes: notesToWrite })
            }
            const saved = await api().dbSetAiTagged(asset.id, description, aiTags)
            if (!saved) throw new Error('Failed to save AI tags to database')
            set(st => ({
              assets: st.assets.map(a => a.id === asset.id
                ? { ...a, tags: merged, aiTagged: true, aiDescription: description,
                    notes: currentNotes.trim() ? currentNotes : notesToWrite }
                : a),
              tags: [...new Set([...st.tags, ...aiTags])],
              assetQueryVersion: st.assetQueryVersion + 1,
            }))
            done++
            log.info('ai.queue.asset_tagged', { id: asset.id, name: asset.name, tags: aiTags, description })
          }
        } catch (e: any) {
          // Unexpected error (IPC failure etc.) — log and skip
          const msg = e?.message || String(e)
          log.error('ai.queue.asset_unexpected_error', { id: asset.id, name: asset.name, error: msg })
          done++
        }
        set(st => ({ aiProgress: st.aiProgress ? { ...st.aiProgress, done, total: done + _aiPendingQueue.length } : null }))
        _aiActiveAssetId = null
        await new Promise(r => setTimeout(r, 100))  // small yield between images
        }
      } finally {
        if (taskToken) await api().releaseAiTask?.(taskToken).catch(() => {})
        _aiQueueRunning = false
        _aiActiveAssetId = null
        set({ aiProgress: null })
        log.info('ai.queue.complete', { processed: done })
      }
    })().catch(e => {
      _aiQueueRunning = false
      _aiActiveAssetId = null
      const msg = e?.message || String(e)
      log.error('ai.queue.loop_failed', { error: msg })
      set({ aiProgress: null })
    })
  },

  showToast:  (message, type = 'info', duration = 2500) => { log.debug('toast.show', { message, type, duration }); set({ toast: { message, type, duration } }) },
  clearToast: () => set({ toast: null }),

  setAiSearchMode:      (v) => { log.info('ai.search.mode', { enabled: v }); set({ aiSearchMode: v }) },
  setAiSearchResultIds: (ids) => { log.info('ai.search.results', { count: ids?.length ?? null, ids }); set({ aiSearchResultIds: ids }) },
  setAiIndexProgress:   (p) => { log.debug('ai.index.progress', p); set({ aiIndexProgress: p }) },
  setAiIndexStatus:     (s) => {
    log.info('ai.index.status', s)
    set(state => s && !s.hasIndex
      ? { aiIndexStatus: s, assets: state.assets.map(asset => asset.aiEmbedded ? { ...asset, aiEmbedded: false } : asset) }
      : { aiIndexStatus: s })
  },
  setDinoIndexProgress: (p) => { log.debug('dino.index.progress', p); set({ dinoIndexProgress: p }) },
  setDinoIndexStatus:   (s) => { log.info('dino.index.status', s); set({ dinoIndexStatus: s }) },
  markAssetsEmbedded:   (ids) => {
    const idSet = new Set(ids || [])
    if (!idSet.size) return
    log.info('ai.index.assets_embedded', { count: idSet.size, ids: [...idSet] })
    set(st => ({ assets: st.assets.map(a => idSet.has(a.id) ? { ...a, aiEmbedded: true } : a) }))
  },
  setAiSearchLoading:   (v) => { log.debug('ai.search.loading', { loading: v }); set({ aiSearchLoading: v }) },
  setSensitiveTags:     (tags) => { const sensitiveTags = [...new Set(tags.map(t => t.trim()).filter(Boolean))]; log.info('sensitive.tags.set', { sensitiveTags }); set({ sensitiveTags }) },
  setShowSensitiveContent: (v) => { log.info('sensitive.visibility.set', { show: v }); set({ showSensitiveContent: v }) },
  setAiStatusLoading:   (v) => { log.debug('ai.status.loading', { loading: v }); set({ aiStatusLoading: v }) },
}))
