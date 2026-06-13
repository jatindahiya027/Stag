# IPC Reference

`electron/preload.js` exposes `window.electronAPI`. The renderer has no direct Node access. `scripts/audit-code-health.js` verifies that every exposed invoke has a main-process handler and every handler is exposed.

## Window And Dialogs

| Renderer method | Channel | Purpose |
| --- | --- | --- |
| `minimize()` | `window:minimize` | Minimize the main window. |
| `maximize()` | `window:maximize` | Toggle maximized state. |
| `close()` | `window:close` | Request window close; normal close hides to tray. |
| `openFiles()` | `dialog:openFiles` | Pick supported local files. |
| `openSearchImage()` | `dialog:openSearchImage` | Pick a query image for DINO search. |
| `selectDirectory()` | `dialog:selectDirectory` | Select a library location. |
| `selectDestFolder()` | `dialog:selectDestFolder` | Select export/copy destination. |
| `showDeleteDialog(options)` | `dialog:showDeleteOptions` | Choose disk delete, DB-only removal, or cancel. |

## Files, Shell, Clipboard, And Drag

| Renderer method | Channel | Purpose |
| --- | --- | --- |
| `copyFilesToDest(srcs, dest)` | `fs:copyFiles` | Copy selected files to a destination. |
| `getFileInfo(path)` | `fs:getFileInfo` | Read size and timestamps. |
| `duplicateFile(path)` | `fs:duplicateFile` | Create a collision-safe copy beside a file. |
| `dirname(path)` | `fs:dirname` | Resolve parent directory. |
| `renameAssetFile(...)` | `fs:renameAssetFile` | Rename file and update SQLite path. |
| `readText(path, max)` | `fs:readText` | Read bounded UTF-8 content. |
| `writeText(id, path, text)` | `fs:writeText` | Save text and update metadata. |
| `readBinary(path)` | `fs:readBinary` | Read a bounded file as base64. |
| `getFileUrl(path)` | `fs:getFileUrl` | Convert an existing path to a file URL. |
| `printCurrentView()` | `print:currentView` | Open the system print dialog for current contents. |
| `openPath(path)` | `shell:openPath` | Open with OS default. |
| `getOpenWithApps(path)` | `shell:getOpenWithApps` | Enumerate macOS applications or request system chooser. |
| `openWith(path, app)` | `shell:openWith` | Open using a selected application. |
| `openExternalUrl(url)` | `shell:openExternalUrl` | Validate and open HTTP(S). |
| `showInFolder(path)` | `shell:showInFolder` | Reveal in Finder/Explorer. |
| `shareFiles(paths)` | `shell:shareFiles` | Invoke platform sharing. |
| `exportFile(path)` | `shell:exportFile` | Save a copy through a dialog. |
| `exportImageAs(path, opts)` | `shell:exportImageAs` | Convert and export an image. |
| `copyAssetToClipboard(path)` | `clipboard:writeAsset` | Copy file/image data. |
| `copyThumbnail(id)` | `clipboard:writeThumbnail` | Copy cached thumbnail pixels. |
| `googleImageSearch(path)` | `shell:googleImageSearch` | Submit image to Google Lens. |
| `exportContactSheet(data, name)` | `shell:exportContactSheet` | Save generated contact sheet. |
| `startDrag(...)` | synchronous drag channels | Begin one-file native drag. |
| `startDragMulti(...)` | synchronous drag channels | Begin multi-file native drag. |

`getPathForFile(file)` uses Electron `webUtils` directly inside preload and has no IPC channel.

## Thumbnails And Metadata

| Method | Channel | Purpose |
| --- | --- | --- |
| `captureWebsiteThumbnail(id, url)` | `website:captureThumbnail` | Capture and persist website image. |
| `startThumbWorker()` | `thumb:startWorker` | Resume missing-thumbnail work. |
| `queueThumbVariants(ids, opts)` | `thumb:queueVariants` | Backfill size variants. |
| `generateThumbBatch(items, opts)` | `thumb:generateBatch` | Generate bounded image/document batches. |
| `generateVideoThumb(args)` | `thumb:videoFrame` | Generate video max or scrub frame. |
| `readMetadataBatch(items)` | `metadata:readBatch` | Read image dimensions through Sharp. |
| `preparePreview(id, path, ext)` | `preview:prepare` | Convert unsupported preview to cached PNG. |
| `getVideoDuration(path)` | `video:getDuration` | Read duration through FFprobe. |

## Database And Jobs

| Method | Channel | Purpose |
| --- | --- | --- |
| `dbLoad(opts)` | `db:load` | Hydrate assets and organization data. |
| `dbQueryAssets(opts)` | `db:queryAssets` | Paginated filtered query. |
| `dbStartupAssets()` | `db:startupAssets` | Read cached/first startup slice. |
| `dbGetCounts(opts)` | `db:counts` | Compute navigation counts. |
| `createJob(...)` | `jobs:create` | Create persisted job state. |
| `updateJob(...)` | `jobs:update` | Update job progress or result. |
| `dbInsertAsset(asset)` | `db:insertAsset` | Insert one asset and relations. |
| `dbBatchInsertAssets(assets)` | `db:batchInsertAssets` | Batch import records. |
| `dbGetThumbState(ids)` | `db:getThumbState` | Reconcile renderer thumbnail URLs. |
| `dbSaveThumbnail(...)` | `db:saveThumbnail` | Persist thumbnail files and metadata. |
| `dbUpdateAsset(id, updates)` | `db:updateAsset` | Update fields and relations. |
| `dbBatchUpdate(ops)` | `db:batchUpdate` | Apply multiple updates transactionally. |
| `dbHardDeleteAssets(ids)` | `db:hardDeleteAssets` | Legacy hard delete. |
| `dbHardDeleteAssetsDbOnly(ids)` | `db:hardDeleteAssetsDbOnly` | Remove records, retain source files. |
| `dbHardDeleteAssetsFromDisk(ids)` | `db:hardDeleteAssetsFromDisk` | Remove records and source files. |
| `dbUpsertFolder(folder)` | `db:upsertFolder` | Save folder and auto-tags. |
| `dbDeleteFolder(id)` | `db:deleteFolder` | Delete folder relations. |
| `dbUpsertSmartFolder(sf)` | `db:upsertSmartFolder` | Save smart rules. |
| `dbDeleteSmartFolder(id)` | `db:deleteSmartFolder` | Delete smart folder. |
| `dbAddTag(tag)` | `db:addTag` | Add global tag. |
| `dbDeleteTag(tag)` | `db:deleteTag` | Remove tag globally. |
| `dbDeleteAllTags()` | `db:deleteAllTags` | Clear every tag relation. |
| `dbSetAiTagged(...)` | `db:setAiTagged` | Persist Ollama description and tags. |
| `dbGetUntaggedImages()` | `db:getUntaggedImages` | Query tagging candidates. |

## AI Search And Models

| Method | Channel | Purpose |
| --- | --- | --- |
| `startAiIndexing()` | `ai:startIndexing` | Start TIPSv2 indexing when enabled. |
| `getAiIndexStatus()` | `ai:getIndexStatus` | Read TIPSv2 status. |
| `getAiEmbeddingEnabled()` | `ai:getEmbeddingEnabled` | Read saved enable state. |
| `setAiEmbeddingEnabled(v)` | `ai:setEmbeddingEnabled` | Enable/disable and cancel as needed. |
| `deleteAiIndex()` | `ai:deleteIndex` | Delete TIPSv2 index and reset flags. |
| `reindexAiAll()` | `ai:reindexAll` | Clear and rebuild TIPSv2. |
| `warmAiSearch()` | `ai:warmSearch` | Start persistent text search worker. |
| `stopAiSearch()` | `ai:stopSearch` | Stop text search worker. |
| `aiSearch(query, topK)` | `ai:search` | Run semantic text search. |
| `aiImageSearch(path, topK)` | `ai:imageSearch` | Run DINO query-image search. |
| `warmAiImageSearch()` | `ai:warmImageSearch` | Start persistent DINO search worker. |
| `stopAiImageSearch()` | `ai:stopImageSearch` | Stop DINO search worker. |
| `startAiImageIndexing()` | `ai:startImageIndexing` | Start DINO indexing. |
| `getAiImageIndexStatus()` | `ai:getImageIndexStatus` | Read DINO status. |
| `setAiImageIndexEnabled(v)` | `ai:setImageIndexEnabled` | Enable/disable DINO. |
| `deleteAiImageIndex()` | `ai:deleteImageIndex` | Delete DINO data. |
| `reindexAiImageAll()` | `ai:reindexImageAll` | Clear and rebuild DINO. |
| `getAiFeatureStatus()` | `ai:getFeatureStatus` | Read models, enablement, and indexes. |
| `downloadAiModel(feature)` | `ai:downloadModel` | Download selected Hugging Face model. |
| `cancelAiModelDownload(feature)` | `ai:cancelModelDownload` | Abort model download. |
| `acquireAiTask(name)` | `ai:acquireTask` | Queue renderer AI task. |
| `releaseAiTask(token)` | `ai:releaseTask` | Release shared AI slot. |

## Ollama

| Method | Channel | Purpose |
| --- | --- | --- |
| `ollamaCheck(url)` | `ollama:checkConnection` | Validate server and list model details. |
| `ollamaGetModels(url)` | `ollama:getModels` | Refresh model names. |
| `ollamaPullModel(model, url)` | `ollama:pullModel` | Stream model installation. |
| `ollamaTagImage(...)` | `ollama:tagImage` | Generate tags and description. |

## Settings, Runtime, And Bridge

| Method | Channel | Purpose |
| --- | --- | --- |
| `loadSettings()` | `settings:load` | Read JSON settings. |
| `saveSettings(settings)` | `settings:save` | Merge and persist settings. |
| `getLibraryPath()` | `settings:getLibraryPath` | Return active data directory. |
| `moveLibrary(path)` | `settings:moveLibrary` | Move DB/thumbnails and update settings. |
| `checkTools()` | `tools:checkAvailability` | Probe configured media tools. |
| `getPlatform()` | `app:getPlatform` | Return Electron platform. |
| `getCpuCount()` | `app:getCpuCount` | Return logical CPU count. |
| `getRuntimeStatus()` | `runtime:getStatus` | Read install state and readiness. |
| `checkRuntimeInternet()` | `runtime:checkInternet` | Probe dependency hosts. |
| `installRuntime()` | `runtime:install` | Ensure core and AI runtime. |
| `reinstallRuntime()` | `runtime:reinstall` | Force runtime repair. |
| `log(entry)` | `log:renderer` | Send structured renderer log. |
| `getBridgePort()` | `bridge:getPort` | Return MPEG bridge port. |
| `getWebGrabPath()` | `bridge:getWebGrabPath` | Return active inbox path. |
| `setWebGrabPath(path)` | `bridge:setWebGrabPath` | Save path and restart watcher. |
| `rebuildWatchers()` | `watchers:rebuild` | Refresh watched parent directories. |
| `importCopyCopyFiles(paths, job)` | `importCopy:copyFiles` | Run serialized managed copy. |

## Push Events

Each `on...` preload method returns an unsubscribe function.

| Method | Event | Payload |
| --- | --- | --- |
| `onAssetsRemoved` | `assets:removed` | Removed/soft-deleted asset IDs. |
| `onAssetsAdded` | `assets:added` | Imported asset records. |
| `onThumbDone` | `thumb:done` | Completed thumbnail metadata. |
| `onThumbProgress` | `thumb:progress` | Thumbnail phase and counts. |
| `onCopyProgress` | `importCopy:progress` | File and byte copy progress. |
| `onAiIndexProgress` | `ai:indexProgress` | TIPSv2 progress or terminal state. |
| `onAiImageIndexProgress` | `ai:imageSearchProgress` | DINO progress or terminal state. |
| `onAiEmbeddedUpdated` | `ai:embeddedUpdated` | IDs newly marked embedded. |
| `onAiModelDownloadProgress` | `ai:modelDownloadProgress` | Model bytes and status. |
| `onAiFeatureStatusChanged` | `ai:featureStatusChanged` | Complete feature snapshot. |
| `onRuntimeProgress` | `runtime:progress` | Onboarding/install status. |
| `onOllamaModelPullProgress` | `ollama:modelPullProgress` | Ollama stream status. |
