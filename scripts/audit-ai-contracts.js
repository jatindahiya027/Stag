const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
const main = read('electron/main.js')
const preload = read('electron/preload.js')
const app = read('src/renderer/App.tsx')
const store = read('src/renderer/store/useStore.ts')
const titleBar = read('src/renderer/components/TitleBar.tsx')
const settingsPanel = read('src/renderer/components/SettingsPanel.tsx')
const processDockCss = read('src/renderer/components/ProcessDock.module.css')

const failures = []
function check(condition, message) {
  if (!condition) failures.push(message)
}

const invokeChannels = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1])
const handleChannels = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(match => match[1]))
const missingHandlers = [...new Set(invokeChannels.filter(channel => !handleChannels.has(channel)))]
check(missingHandlers.length === 0, `Preload IPC channels missing handlers: ${missingHandlers.join(', ')}`)

check(
  main.includes("scheduleAiIndexingForNewAssets(1, 'web-grab asset')") &&
    main.includes("scheduleDinoIndexing('web-grab asset')"),
  'Web imports must schedule both TIPSv2 and DINOv3 independently.',
)
check(
  main.includes("scheduleAiIndexingForNewAssets(newImageCount, 'newly imported assets')") &&
    main.includes("scheduleDinoIndexing('newly imported assets')"),
  'Local batch imports must schedule both TIPSv2 and DINOv3 independently.',
)
check(
  main.includes("scheduleDinoIndexing('assets added during previous DINOv3 run')"),
  'DINOv3 must rerun when assets arrive during an active index run.',
)
check(
  app.includes('hydrateAiSettings(configuredAi)') &&
    !app.includes('setAiSettings(validatedAi)'),
  'Startup must hydrate saved tagging settings without disabling or rewriting them.',
)
check(
  app.includes('dbGetUntaggedImages') &&
    app.includes('isAiTaggableAsset(withThumb)'),
  'Tagging must resume from DB and retry assets after thumbnails become ready.',
)
check(
  store.includes("const AI_TAGGABLE_DOCUMENT_EXTS = new Set(['pdf', 'epub'])") &&
    store.includes('AI_TAGGABLE_DOCUMENT_EXTS.has(ext)') &&
    store.includes("asset.thumbnailData?.replace(/^file:\\/\\//, '')"),
  'PDF and EPUB covers must be discoverable and sent to AI tagging through their generated thumbnails.',
)
check(
  store.includes("throw new Error('Failed to save AI tags to database')"),
  'Renderer must not mark AI tagging complete when DB persistence fails.',
)
check(
  /db:setAiTagged[\s\S]*?upsertAssetFts\(id\)[\s\S]*?invalidateAssetQueryCache\(\)/.test(main),
  'AI tag writes must update FTS and invalidate asset caches.',
)
check(
  titleBar.includes('const taggingAvailable = !!aiFeatureStatus?.tagging.model'),
  'Configured tagging button must remain visible even during runtime outages.',
)
check(
  main.includes('const managedAiSettings = {') &&
    main.includes('aiEmbeddingEnabled: existing.aiEmbeddingEnabled') &&
    main.includes('dinoImageIndexEnabled: existing.dinoImageIndexEnabled') &&
    main.includes('dinoImageIndexUserConfigured: existing.dinoImageIndexUserConfigured'),
  'Generic settings saves must preserve AI feature values owned by dedicated toggle handlers.',
)
check(
  settingsPanel.includes('delete settingsToSave.aiEmbeddingEnabled') &&
    settingsPanel.includes('delete settingsToSave.dinoImageIndexEnabled') &&
    settingsPanel.includes('delete settingsToSave.dinoImageIndexUserConfigured'),
  'Settings UI must not submit stale managed AI feature values.',
)
const dinoEnabledHelper = main.match(/function isDinoImageIndexEnabled\(\) \{[\s\S]*?\n\}/)?.[0] || ''
const downloadModelHandler = main.match(/ipcMain\.handle\('ai:downloadModel'[\s\S]*?\n\}\)\n\nipcMain\.handle\('ai:cancelModelDownload'/)?.[0] || ''
check(
  dinoEnabledHelper.includes("loadSettings().dinoImageIndexEnabled === true") &&
    !dinoEnabledHelper.includes('saveSettings('),
  'Installing the DINOv3 model must not implicitly enable AI image indexing.',
)
check(
  !downloadModelHandler.includes('dinoImageIndexEnabled: true') &&
    !downloadModelHandler.includes("scheduleDinoIndexing('DINOv3 model installation')"),
  'DINOv3 model download completion must preserve the disabled feature state.',
)
check(
  main.includes("aiTaskCoordinator.run('ai-embedding'") &&
    main.includes("aiTaskCoordinator.run('dino-index'") &&
    preload.includes("ipcRenderer.invoke('ai:acquireTask'") &&
    store.includes("acquireAiTask?.('ai-tagging')") &&
    store.includes('releaseAiTask?.(taskToken)'),
  'Embedding, DINO indexing, and AI tagging must share one cross-process task coordinator.',
)
check(
  main.includes("createAiAssetManifest('tips-index'") &&
    main.includes("createAiAssetManifest('dino-index'") &&
    main.includes("'--manifest', manifest.path"),
  'Embedding and DINO indexing must read DB-selected source files through temporary manifests.',
)
check(
  /\.dock\s*\{[\s\S]*?flex-direction:\s*column/.test(processDockCss) &&
    /\.item \+ \.item\s*\{[\s\S]*?0 -1px 0/.test(processDockCss),
  'Process tasks must stack vertically with horizontal separators.',
)
check(
  main.includes("mainWindow?.webContents.send('ai:indexProgress', { type: 'cancelled', status })") &&
    main.includes("sendDinoProgress({ type: 'cancelled', error: reason, status:") &&
    main.includes("error: _dinoIndexCancelled ? 'cancelled' : 'dinov3-index-disabled'") &&
    main.includes('if (_aiIndexCancelled || runGeneration !== _aiIndexGeneration) return'),
  'Disabling embedding or DINO must cancel active work and emit terminal progress.',
)
check(
  !main.includes('ignoreDisabled') &&
    main.includes("saveSettings({ ...loadSettings(), aiEmbeddingEnabled: true })") &&
    main.includes('dinoImageIndexEnabled: true'),
  'Reindex requests may enable their feature first, but queued work must never bypass a later disable.',
)
check(
  titleBar.includes("const terminal = ['done', 'error', 'cancelled'].includes(data.type)") &&
    titleBar.includes('setAiIndexProgress(terminal ? null : data)') &&
    titleBar.includes('setDinoIndexProgress(terminal ? null : data)'),
  'Completed or cancelled AI jobs must be removed from the process dock.',
)
check(
  titleBar.includes("await api?.ollamaCheck?.(aiSettings.ollamaUrl)") &&
    store.includes("availability = await api().ollamaCheck?.(s.ollamaUrl)") &&
    settingsPanel.includes("enabled: ai.enabled && ollamaStatus === 'ok' && ollamaModels.includes(ai.model)"),
  'AI tagging must not enable unless Ollama is reachable and the configured model is installed.',
)

if (failures.length) {
  console.error(`AI contract audit failed (${failures.length}):`)
  failures.forEach(failure => console.error(`- ${failure}`))
  process.exit(1)
}

console.log(`AI contract audit passed: ${new Set(invokeChannels).size} IPC invokes checked.`)
