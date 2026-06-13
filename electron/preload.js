const { contextBridge, ipcRenderer, webUtils } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', {
  initialRuntimeReady: process.argv.includes('--stag-runtime-ready=1'),
  // Window
  minimize:         () => ipcRenderer.invoke('window:minimize'),
  maximize:         () => ipcRenderer.invoke('window:maximize'),
  close:            () => ipcRenderer.invoke('window:close'),
  // Dialogs
  openFiles:        () => ipcRenderer.invoke('dialog:openFiles'),
  openSearchImage:  () => ipcRenderer.invoke('dialog:openSearchImage'),
  selectDirectory:  () => ipcRenderer.invoke('dialog:selectDirectory'),
  selectDestFolder: () => ipcRenderer.invoke('dialog:selectDestFolder'),
  // File system
  copyFilesToDest:  (srcs, dest) => ipcRenderer.invoke('fs:copyFiles', srcs, dest),
  getFileInfo:      (p)    => ipcRenderer.invoke('fs:getFileInfo', p),
  getPathForFile:   (file) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
  duplicateFile:    (p)    => ipcRenderer.invoke('fs:duplicateFile', p),
  dirname:          (p)    => ipcRenderer.invoke('fs:dirname', p),
  renameAssetFile:  (id, p, name, ext) => ipcRenderer.invoke('fs:renameAssetFile', id, p, name, ext),
  readText:         (p, n) => ipcRenderer.invoke('fs:readText', p, n),
  writeText:        (id, p, text) => ipcRenderer.invoke('fs:writeText', id, p, text),
  readBinary:       (p)    => ipcRenderer.invoke('fs:readBinary', p),
  getFileUrl:       (p)    => ipcRenderer.invoke('fs:getFileUrl', p),
  printCurrentView: ()     => ipcRenderer.invoke('print:currentView'),
  // Shell / drag
  openPath:         (p)    => ipcRenderer.invoke('shell:openPath', p),
  getOpenWithApps:  (p)    => ipcRenderer.invoke('shell:getOpenWithApps', p),
  openWith:         (p, appPath) => ipcRenderer.invoke('shell:openWith', p, appPath),
  openExternalUrl:  (url)  => ipcRenderer.invoke('shell:openExternalUrl', url),
  showInFolder:     (p)    => ipcRenderer.invoke('shell:showInFolder', p),
  shareFiles:       (paths) => ipcRenderer.invoke('shell:shareFiles', paths),
  exportFile:       (p)    => ipcRenderer.invoke('shell:exportFile', p),
  exportImageAs:    (p, options) => ipcRenderer.invoke('shell:exportImageAs', p, options),
  copyAssetToClipboard: (p) => ipcRenderer.invoke('clipboard:writeAsset', p),
  copyThumbnail:    (id)   => ipcRenderer.invoke('clipboard:writeThumbnail', id),
  googleImageSearch:(p)    => ipcRenderer.invoke('shell:googleImageSearch', p),
  exportContactSheet:(dataUrl, name) => ipcRenderer.invoke('shell:exportContactSheet', dataUrl, name),
  startDrag:              (p, icon)    => ipcRenderer.sendSync(icon ? 'drag:startWithIcon' : 'drag:start', p, icon),
  startDragMulti:         (arr, icons) => { const hint = Array.isArray(icons) ? icons.find(Boolean) : null; return ipcRenderer.sendSync(hint ? 'drag:startMultiWithIcon' : 'drag:startMulti', arr, hint) },
  // Thumbnails
  captureWebsiteThumbnail: (id, url) => ipcRenderer.invoke('website:captureThumbnail', id, url),
  startThumbWorker:  ()        => ipcRenderer.invoke('thumb:startWorker'),
  queueThumbVariants:(ids, opts) => ipcRenderer.invoke('thumb:queueVariants', ids, opts),
  generateThumbBatch:(items, opts) => ipcRenderer.invoke('thumb:generateBatch', items, opts),
  generateVideoThumb:(args)    => ipcRenderer.invoke('thumb:videoFrame', args),
  readMetadataBatch: (items)   => ipcRenderer.invoke('metadata:readBatch', items),
  // ── SQLite DB — granular ops (replaces dbSave/dbLoad with full JSON) ──────
  dbLoad:              (opts)       => ipcRenderer.invoke('db:load', opts),
  dbQueryAssets:       (opts)       => ipcRenderer.invoke('db:queryAssets', opts),
  dbStartupAssets:     ()           => ipcRenderer.invoke('db:startupAssets'),
  dbGetCounts:         (opts)       => ipcRenderer.invoke('db:counts', opts),
  createJob:           (type, payload, total) => ipcRenderer.invoke('jobs:create', type, payload, total),
  updateJob:           (id, updates) => ipcRenderer.invoke('jobs:update', id, updates),
  dbInsertAsset:       (asset)      => ipcRenderer.invoke('db:insertAsset', asset),
  dbBatchInsertAssets: (assets)     => ipcRenderer.invoke('db:batchInsertAssets', assets),
  dbGetThumbState:     (ids)        => ipcRenderer.invoke('db:getThumbState', ids),
  dbSaveThumbnail:     (id, data, opts) => ipcRenderer.invoke('db:saveThumbnail', id, data, opts),
  dbUpdateAsset:       (id, upd)    => ipcRenderer.invoke('db:updateAsset', id, upd),
  dbBatchUpdate:       (ops)        => ipcRenderer.invoke('db:batchUpdate', ops),
  dbHardDeleteAssetsFromDisk: (ids) => ipcRenderer.invoke('db:hardDeleteAssetsFromDisk', ids),
  showDeleteDialog:    (opts)       => ipcRenderer.invoke('dialog:showDeleteOptions', opts),
  dbUpsertFolder:      (folder)     => ipcRenderer.invoke('db:upsertFolder', folder),
  dbDeleteFolder:      (id)         => ipcRenderer.invoke('db:deleteFolder', id),
  dbUpsertSmartFolder: (sf)         => ipcRenderer.invoke('db:upsertSmartFolder', sf),
  dbDeleteSmartFolder: (id)         => ipcRenderer.invoke('db:deleteSmartFolder', id),
  dbAddTag:            (tag)        => ipcRenderer.invoke('db:addTag', tag),
  dbDeleteTag:         (tag)        => ipcRenderer.invoke('db:deleteTag', tag),
  dbDeleteAllTags:     ()           => ipcRenderer.invoke('db:deleteAllTags'),
  dbSetAiTagged:       (id, desc, tags) => ipcRenderer.invoke('db:setAiTagged', id, desc, tags),
  dbGetUntaggedImages: ()           => ipcRenderer.invoke('db:getUntaggedImages'),
  startAiIndexing:     ()           => ipcRenderer.invoke('ai:startIndexing'),
  getAiIndexStatus:    ()           => ipcRenderer.invoke('ai:getIndexStatus'),
  getAiEmbeddingEnabled: ()         => ipcRenderer.invoke('ai:getEmbeddingEnabled'),
  setAiEmbeddingEnabled: (enabled)  => ipcRenderer.invoke('ai:setEmbeddingEnabled', enabled),
  deleteAiIndex:       ()           => ipcRenderer.invoke('ai:deleteIndex'),
  reindexAiAll:        ()           => ipcRenderer.invoke('ai:reindexAll'),
  warmAiSearch:        ()           => ipcRenderer.invoke('ai:warmSearch'),
  stopAiSearch:        ()           => ipcRenderer.invoke('ai:stopSearch'),
  aiSearch:            (query, topK) => ipcRenderer.invoke('ai:search', query, topK),
  aiImageSearch:       (imagePath, topK) => ipcRenderer.invoke('ai:imageSearch', imagePath, topK),
  warmAiImageSearch:   () => ipcRenderer.invoke('ai:warmImageSearch'),
  stopAiImageSearch:   () => ipcRenderer.invoke('ai:stopImageSearch'),
  startAiImageIndexing: () => ipcRenderer.invoke('ai:startImageIndexing'),
  getAiImageIndexStatus: () => ipcRenderer.invoke('ai:getImageIndexStatus'),
  setAiImageIndexEnabled: (enabled) => ipcRenderer.invoke('ai:setImageIndexEnabled', enabled),
  deleteAiImageIndex:  () => ipcRenderer.invoke('ai:deleteImageIndex'),
  reindexAiImageAll:   () => ipcRenderer.invoke('ai:reindexImageAll'),
  getAiFeatureStatus:  ()           => ipcRenderer.invoke('ai:getFeatureStatus'),
  downloadAiModel:     (feature)    => ipcRenderer.invoke('ai:downloadModel', feature),
  cancelAiModelDownload: (feature)  => ipcRenderer.invoke('ai:cancelModelDownload', feature),
  ollamaCheck:         (url)        => ipcRenderer.invoke('ollama:checkConnection', url),
  ollamaGetModels:     (url)        => ipcRenderer.invoke('ollama:getModels', url),
  ollamaPullModel:     (model, url) => ipcRenderer.invoke('ollama:pullModel', model, url),
  ollamaTagImage:      (path, model, url) => ipcRenderer.invoke('ollama:tagImage', path, model, url),
  acquireAiTask:       (name)       => ipcRenderer.invoke('ai:acquireTask', name),
  releaseAiTask:       (token)      => ipcRenderer.invoke('ai:releaseTask', token),
  // Settings
  loadSettings:     ()     => ipcRenderer.invoke('settings:load'),
  saveSettings:     (s)    => ipcRenderer.invoke('settings:save', s),
  checkTools:       ()     => ipcRenderer.invoke('tools:checkAvailability'),
  preparePreview:   (id, filePath, ext) => ipcRenderer.invoke('preview:prepare', id, filePath, ext),
  getPlatform:      ()     => ipcRenderer.invoke('app:getPlatform'),
  getCpuCount:      ()     => ipcRenderer.invoke('app:getCpuCount'),
  getRuntimeStatus: ()     => ipcRenderer.invoke('runtime:getStatus'),
  checkRuntimeInternet: () => ipcRenderer.invoke('runtime:checkInternet'),
  installRuntime:   ()     => ipcRenderer.invoke('runtime:install'),
  reinstallRuntime: ()     => ipcRenderer.invoke('runtime:reinstall'),
  log:              (entry) => ipcRenderer.invoke('log:renderer', entry),
  getBridgePort:    ()     => ipcRenderer.invoke('bridge:getPort'),
  getVideoDuration: (fp)   => ipcRenderer.invoke('video:getDuration', fp),
  getWebGrabPath:   ()     => ipcRenderer.invoke('bridge:getWebGrabPath'),
  setWebGrabPath:   (p)    => ipcRenderer.invoke('bridge:setWebGrabPath', p),
  setLocalImportPath: (p)  => ipcRenderer.invoke('importCopy:setPath', p),
  rebuildWatchers:  ()     => ipcRenderer.invoke('watchers:rebuild'),
  // Import copy feature
  importCopyCopyFiles:  (paths, jobId) => ipcRenderer.invoke('importCopy:copyFiles', paths, jobId),

  // ── Push events: main process → renderer ──────────────────────────────────
  // Returns an unsubscribe function. Call it in useEffect cleanup.
  onAssetsRemoved: (cb) => {
    const handler = (_ev, ids) => cb(ids)
    ipcRenderer.on('assets:removed', handler)
    return () => ipcRenderer.removeListener('assets:removed', handler)
  },
  onAssetsAdded: (cb) => {
    const handler = (_ev, assets) => cb(assets)
    ipcRenderer.on('assets:added', handler)
    return () => ipcRenderer.removeListener('assets:added', handler)
  },
  onThumbDone: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('thumb:done', handler)
    return () => ipcRenderer.removeListener('thumb:done', handler)
  },
  onThumbProgress: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('thumb:progress', handler)
    return () => ipcRenderer.removeListener('thumb:progress', handler)
  },
  onCopyProgress: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('importCopy:progress', handler)
    return () => ipcRenderer.removeListener('importCopy:progress', handler)
  },
  onAiIndexProgress: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('ai:indexProgress', handler)
    return () => ipcRenderer.removeListener('ai:indexProgress', handler)
  },
  onAiImageIndexProgress: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('ai:imageSearchProgress', handler)
    return () => ipcRenderer.removeListener('ai:imageSearchProgress', handler)
  },
  onAiEmbeddedUpdated: (cb) => {
    const handler = (_ev, ids) => cb(ids)
    ipcRenderer.on('ai:embeddedUpdated', handler)
    return () => ipcRenderer.removeListener('ai:embeddedUpdated', handler)
  },
  onAiModelDownloadProgress: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('ai:modelDownloadProgress', handler)
    return () => ipcRenderer.removeListener('ai:modelDownloadProgress', handler)
  },
  onAiFeatureStatusChanged: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('ai:featureStatusChanged', handler)
    return () => ipcRenderer.removeListener('ai:featureStatusChanged', handler)
  },
  onRuntimeProgress: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('runtime:progress', handler)
    return () => ipcRenderer.removeListener('runtime:progress', handler)
  },
  onOllamaModelPullProgress: (cb) => {
    const handler = (_ev, data) => cb(data)
    ipcRenderer.on('ollama:modelPullProgress', handler)
    return () => ipcRenderer.removeListener('ollama:modelPullProgress', handler)
  },
})
