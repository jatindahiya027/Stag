const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('electronAPI', {
  // Window
  minimize:         () => ipcRenderer.invoke('window:minimize'),
  maximize:         () => ipcRenderer.invoke('window:maximize'),
  close:            () => ipcRenderer.invoke('window:close'),
  // Dialogs
  openFiles:        () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder:       () => ipcRenderer.invoke('dialog:openFolder'),
  selectDirectory:  () => ipcRenderer.invoke('dialog:selectDirectory'),
  selectDestFolder: () => ipcRenderer.invoke('dialog:selectDestFolder'),
  // File system
  copyFilesToDest:  (srcs, dest) => ipcRenderer.invoke('fs:copyFiles', srcs, dest),
  getFileInfo:      (p)    => ipcRenderer.invoke('fs:getFileInfo', p),
  readDir:          (p)    => ipcRenderer.invoke('fs:readDir', p),
  fileExists:       (p)    => ipcRenderer.invoke('fs:exists', p),
  copyFile:         (s, d) => ipcRenderer.invoke('fs:copyFile', s, d),
  deleteFile:       (p)    => ipcRenderer.invoke('fs:deleteFile', p),
  readText:         (p, n) => ipcRenderer.invoke('fs:readText', p, n),
  readBase64:       (p)    => ipcRenderer.invoke('thumb:readBase64', p),
  // Shell / drag
  openPath:         (p)    => ipcRenderer.invoke('shell:openPath', p),
  showInFolder:     (p)    => ipcRenderer.invoke('shell:showInFolder', p),
  startDrag:              (p)          => ipcRenderer.sendSync('drag:start', p),
  startDragMulti:         (arr)        => ipcRenderer.sendSync('drag:startMulti', arr),
  startDragWithIcon:      (p, icon)    => ipcRenderer.sendSync('drag:startWithIcon', p, icon),
  startDragMultiWithIcon: (arr, icon)  => ipcRenderer.sendSync('drag:startMultiWithIcon', arr, icon),
  // Thumbnails
  createThumb:      (p)    => ipcRenderer.invoke('thumb:create', p),
  startThumbWorker:  ()        => ipcRenderer.invoke('thumb:startWorker'),
  generateThumbBatch:(items)   => ipcRenderer.invoke('thumb:generateBatch', items),
  hashFile:         (p)    => ipcRenderer.invoke('hash:file', p),
  // ── SQLite DB — granular ops (replaces dbSave/dbLoad with full JSON) ──────
  dbLoad:              ()           => ipcRenderer.invoke('db:load'),
  dbInsertAsset:       (asset)      => ipcRenderer.invoke('db:insertAsset', asset),
  dbSaveThumbnail:     (id, data)   => ipcRenderer.invoke('db:saveThumbnail', id, data),
  dbUpdateAsset:       (id, upd)    => ipcRenderer.invoke('db:updateAsset', id, upd),
  dbBatchUpdate:       (ops)        => ipcRenderer.invoke('db:batchUpdate', ops),
  dbHardDeleteAssets:  (ids)        => ipcRenderer.invoke('db:hardDeleteAssets', ids),
  dbHardDeleteAssetsDbOnly: (ids)   => ipcRenderer.invoke('db:hardDeleteAssetsDbOnly', ids),
  dbHardDeleteAssetsFromDisk: (ids) => ipcRenderer.invoke('db:hardDeleteAssetsFromDisk', ids),
  showDeleteDialog:    (opts)       => ipcRenderer.invoke('dialog:showDeleteOptions', opts),
  dbUpsertFolder:      (folder)     => ipcRenderer.invoke('db:upsertFolder', folder),
  dbDeleteFolder:      (id)         => ipcRenderer.invoke('db:deleteFolder', id),
  dbUpsertSmartFolder: (sf)         => ipcRenderer.invoke('db:upsertSmartFolder', sf),
  dbDeleteSmartFolder: (id)         => ipcRenderer.invoke('db:deleteSmartFolder', id),
  dbAddTag:            (tag)        => ipcRenderer.invoke('db:addTag', tag),
  dbDeleteTag:         (tag)        => ipcRenderer.invoke('db:deleteTag', tag),
  dbSetAiTagged:       (id, desc, tags) => ipcRenderer.invoke('db:setAiTagged', id, desc, tags),
  dbGetUntaggedImages: ()           => ipcRenderer.invoke('db:getUntaggedImages'),
  ollamaCheck:         (url)        => ipcRenderer.invoke('ollama:checkConnection', url),
  ollamaGetModels:     (url)        => ipcRenderer.invoke('ollama:getModels', url),
  ollamaTagImage:      (path, model, url) => ipcRenderer.invoke('ollama:tagImage', path, model, url),
  // Settings
  loadSettings:     ()     => ipcRenderer.invoke('settings:load'),
  saveSettings:     (s)    => ipcRenderer.invoke('settings:save', s),
  getLibraryPath:   ()     => ipcRenderer.invoke('settings:getLibraryPath'),
  moveLibrary:      (p)    => ipcRenderer.invoke('settings:moveLibrary', p),
  getVersion:       ()     => ipcRenderer.invoke('app:getVersion'),
  getPlatform:      ()     => ipcRenderer.invoke('app:getPlatform'),
  getBridgePort:    ()     => ipcRenderer.invoke('bridge:getPort'),
  getWebGrabPath:   ()     => ipcRenderer.invoke('bridge:getWebGrabPath'),
  setWebGrabPath:   (p)    => ipcRenderer.invoke('bridge:setWebGrabPath', p),
  rebuildWatchers:  ()     => ipcRenderer.invoke('watchers:rebuild'),
  // Import copy feature
  importCopyGetPath:    ()      => ipcRenderer.invoke('importCopy:getPath'),
  importCopySetPath:    (p)     => ipcRenderer.invoke('importCopy:setPath', p),
  importCopySetEnabled: (v)     => ipcRenderer.invoke('importCopy:setEnabled', v),
  importCopyCopyFiles:  (paths) => ipcRenderer.invoke('importCopy:copyFiles', paths),
  importCopyIsCopied:   (fp)    => ipcRenderer.invoke('importCopy:isCopiedFile', fp),

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
})
