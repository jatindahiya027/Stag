import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Window
  minimize:      () => ipcRenderer.invoke('window:minimize'),
  maximize:      () => ipcRenderer.invoke('window:maximize'),
  close:         () => ipcRenderer.invoke('window:close'),
  // Dialogs
  openFiles:     () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder:    () => ipcRenderer.invoke('dialog:openFolder'),
  selectDirectory:  () => ipcRenderer.invoke('dialog:selectDirectory'),
  selectDestFolder: () => ipcRenderer.invoke('dialog:selectDestFolder'),
  // File system
  copyFilesToDest:  (srcs: string[], dest: string) => ipcRenderer.invoke('fs:copyFiles', srcs, dest),
  getFileInfo:   (p: string)    => ipcRenderer.invoke('fs:getFileInfo', p),
  readDir:       (p: string)    => ipcRenderer.invoke('fs:readDir', p),
  fileExists:    (p: string)    => ipcRenderer.invoke('fs:exists', p),
  copyFile:      (s: string, d: string) => ipcRenderer.invoke('fs:copyFile', s, d),
  deleteFile:    (p: string)    => ipcRenderer.invoke('fs:deleteFile', p),
  readText:      (p: string, n?: number) => ipcRenderer.invoke('fs:readText', p, n),
  readBase64:    (p: string)    => ipcRenderer.invoke('thumb:readBase64', p),
  // Shell / drag
  openPath:      (p: string)    => ipcRenderer.invoke('shell:openPath', p),
  showInFolder:  (p: string)    => ipcRenderer.invoke('shell:showInFolder', p),
  startDrag:     (p: string)    => ipcRenderer.send('drag:start', p),
  startDragMulti:(a: string[])  => ipcRenderer.send('drag:startMulti', a),
  // Thumbnails
  createThumb:   (p: string)    => ipcRenderer.invoke('thumb:create', p),
  hashFile:      (p: string)    => ipcRenderer.invoke('hash:file', p),
  // SQLite DB — granular ops
  dbLoad:              ()                       => ipcRenderer.invoke('db:load'),
  dbInsertAsset:       (asset: unknown)         => ipcRenderer.invoke('db:insertAsset', asset),
  dbSaveThumbnail:     (id: string, data: string) => ipcRenderer.invoke('db:saveThumbnail', id, data),
  dbUpdateAsset:       (id: string, upd: unknown) => ipcRenderer.invoke('db:updateAsset', id, upd),
  dbBatchUpdate:       (ops: unknown[])         => ipcRenderer.invoke('db:batchUpdate', ops),
  dbHardDeleteAssets:  (ids: string[])          => ipcRenderer.invoke('db:hardDeleteAssets', ids),
  dbUpsertFolder:      (f: unknown)             => ipcRenderer.invoke('db:upsertFolder', f),
  dbDeleteFolder:      (id: string)             => ipcRenderer.invoke('db:deleteFolder', id),
  dbUpsertSmartFolder: (sf: unknown)            => ipcRenderer.invoke('db:upsertSmartFolder', sf),
  dbDeleteSmartFolder: (id: string)             => ipcRenderer.invoke('db:deleteSmartFolder', id),
  dbAddTag:            (tag: string)            => ipcRenderer.invoke('db:addTag', tag),
  dbDeleteTag:         (tag: string)            => ipcRenderer.invoke('db:deleteTag', tag),
  // Settings
  loadSettings:  ()             => ipcRenderer.invoke('settings:load'),
  saveSettings:  (s: unknown)   => ipcRenderer.invoke('settings:save', s),
  getLibraryPath:()             => ipcRenderer.invoke('settings:getLibraryPath'),
  moveLibrary:   (p: string)    => ipcRenderer.invoke('settings:moveLibrary', p),
  getVersion:    ()             => ipcRenderer.invoke('app:getVersion'),
  getPlatform:   ()             => ipcRenderer.invoke('app:getPlatform'),
})
