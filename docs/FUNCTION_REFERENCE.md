# Function Reference

This reference documents production modules and their significant functions. Small React event closures are described with their owning component rather than listed individually.

## Electron Main Process

### Settings And Paths

| Function | Behavior |
| --- | --- |
| `getSettingsPath` | Resolves `stag-settings.json` under Electron user data. |
| `makeFirstRunSettings` | Creates managed Pictures folders and returns all initial settings. |
| `loadSettings` | Reads settings or writes first-run defaults. |
| `saveSettings` | Persists formatted JSON. |
| `getDataDir` | Returns custom library path or the default `stag-library`. |
| `thumbBucketPath` | Shards thumbnail files by the first two asset-ID characters. |
| `thumbFilePath` | Resolves the full WebP thumbnail. |
| `thumbVariantFilePath` | Resolves a named size variant. |
| `fileUrl` | Converts a local path into a renderer-safe file URL. |

### Thumbnail Files

| Function | Behavior |
| --- | --- |
| `writeThumbnailVariants` | Produces `sm`, `md`, and `lg` WebP variants from a source buffer. |
| `queueThumbnailVariants` | Deduplicates delayed variant work by asset ID. |
| `waitForThumbnailVariantQueue` | Resolves after queued variant work drains. |
| `runThumbnailVariantQueue` | Processes pending variant IDs serially and wakes waiters. |
| `saveThumbnailBuffer` | Normalizes, stores, records dimensions, queues variants, and emits completion. |
| `ensureThumbnailVariants` | Backfills absent variants for an existing full thumbnail. |
| `deleteThumbnailFiles` | Removes the full thumbnail and generated variants for an asset. |

### SQLite

| Function | Behavior |
| --- | --- |
| `initDB` | Opens `better-sqlite3`, enables WAL/foreign keys, and creates schema once. |
| `flushDB` | Schedules a passive WAL checkpoint. |
| `flushDBNow` | Performs immediate truncate checkpoint. |
| `closeDB` | Checkpoints and closes the connection. |
| `createSchema` | Creates all tables, indexes, FTS5, and additive legacy columns. |
| `dbRun`, `dbAll`, `dbGet` | Prepared-statement write/list/single-row helpers. |
| `dbTransaction` | Runs a callback through a synchronous SQLite transaction. |
| `writeRelations` | Replaces an asset's tags, folders, colors, and annotations. |
| `upsertAssetFts` | Rebuilds one FTS projection from current metadata and tags. |
| `invalidateAssetQueryCache` | Clears query/startup caches and schedules cache refresh. |
| `hydrateAssetRows` | Adds relations and thumbnail URLs to database rows. |
| `dbLoadAll` | Loads complete organization metadata and optional assets. |
| `appendSmartRuleSql` | Adds parameterized smart-folder predicates. |
| `dbQueryAssets` | Builds paginated navigation/search/filter/sort SQL. |
| `dbCountAssets` | Runs count-only variants of library queries. |
| `loadStartupAssetPage` | Reads the first lightweight page and updates disk cache. |
| `createJob`, `updateJob` | Persist import/copy job status. |

### Migrations And Recovery

| Function | Behavior |
| --- | --- |
| `migrateFromJSON` | Imports a legacy `library.json` and preserves a backup. |
| `migrateThumbRetry*` | Versioned resets for formats whose thumbnail support improved. |
| `migrateOrientedImageThumbsV9` | Invalidates JPEG thumbnails affected by EXIF orientation. |
| `migrateThumbQualityV6` | Records quality-migration state and queues necessary refresh work. |
| `migrateThumbsToWebP` | Converts older cached thumbnails to current WebP storage. |
| `ensureExistingThumbVariants` | Backfills size variants for existing full thumbnails. |
| `reconcileMissingThumbnailFiles` | Clears stale `hasThumb` flags when files are absent. |
| `ensureAssetFtsBackfilled` | Adds missing FTS rows in idle batches. |

### Filesystem Watchers And Managed Imports

| Function | Behavior |
| --- | --- |
| `rebuildDirWatchers` | Watches unique parent directories of active assets. |
| `scheduleDeadAssetFlush` | Debounces path-existence checks. |
| `flushDeadAssetChecks` | Soft-deletes records whose source path disappeared. |
| `getInboxDir` | Resolves and creates WebGrab directory. |
| `restartInboxWatcher` | Replaces the inbox watcher after path changes. |
| `startInboxWatcher` | Watches stable new files and sends them to import. |
| `processInboxFile` | Creates one asset, thumbnail, palette state, and AI schedules. |
| `scanInboxOnStartup` | Imports WebGrab files created while Stag was closed. |
| `scanImportCopyOnStartup` | Imports managed LocalGrab files created while closed. |
| `scanManagedAssetFolder` | Shared startup scan implementation. |

### Window And Tray

| Function | Behavior |
| --- | --- |
| `createTray` | Creates Show/Quit tray controls and restores on click. |
| `createWindow` | Creates the secured BrowserWindow and close-to-tray behavior. |
| `restoreMainWindow` | Creates, restores, focuses, and logs restoration. |
| `getOffscreenWin` | Lazily creates a hidden Chromium decoder window. |

### Thumbnail Generation

| Function | Behavior |
| --- | --- |
| `decodeViaChromium` | Uses hidden Chromium to decode browser-supported files. |
| `captureVideoFrame` | Captures a native/bridge video frame where possible. |
| `bufToWebP` | Converts decoded pixels to standardized WebP. |
| `refreshManagedToolPaths` | Refreshes private runtime executable locations. |
| `managedToolEnvironment` | Builds scoped PATH/MAGICK/GS variables. |
| `resolveToolCommand` | Uses managed executable in packaged builds, dev command otherwise. |
| `_ffprobeGetDuration` | Reads media duration. |
| `_ffmpegPickTime` | Chooses a representative frame timestamp. |
| `captureVideoFrameFFmpeg` | Extracts a scaled, orientation-correct video frame. |
| `hasPdfSignature` | Verifies `%PDF` before invoking document tools. |
| `renderPdfThumb` | Uses Poppler with fallbacks to create a PDF cover. |
| `renderEpubThumb` | Extracts EPUB cover/content and renders a thumbnail. |
| `generateThumbForFile` | Central extension dispatcher for all main-process thumbnails. |
| `runThumbWorker` | Queries missing thumbnails and processes bounded batches. |
| `runThumbQualityRefresh` | Regenerates selected legacy low-quality thumbnails. |

### AI Status And Python

| Function | Behavior |
| --- | --- |
| `getAiIndexDir` | Resolves the persistent TIPSv2/DINO vector-index directory. |
| `createAiAssetManifest` | Writes a small temporary manifest from SQLite-selected assets and provides deterministic cleanup. |
| `cleanupLegacyAiStaging` | Removes obsolete `ai-staging`, `dino-staging`, and `ai-run-pending` caches. |
| `getAiFeatureStatus` | Combines model, enable, index, and tagging state. |
| `broadcastAiFeatureStatus` | Sends the feature snapshot to the renderer. |
| `getPythonScript`, `getDinoPythonScript` | Resolve unpacked scripts in dev or packaged app. |
| `getPythonBin`, `getDinoPythonBin` | Locate and probe the private Python runtime. |
| `runNodeWorker` | Runs a worker thread with timeout/error propagation. |
| `getAiEligibleAssets` | Selects source files or existing Stag thumbnails and computes stable source versions. |
| `markAssetsEmbeddedIds` | Stores successful TIPSv2 source versions in SQLite for incremental indexing. |
| `stageAiSourceViaChromium` | Decodes one difficult source with hidden Chromium. |
| `stageAiImage` | Produces normalized AI input for one asset. |

### TIPSv2

| Function | Behavior |
| --- | --- |
| `isAiEmbeddingEnabled` | Reads explicit saved enable state. |
| `getAiEligibleAssets` | Selects active assets with originals or thumbnails. |
| `getAiIndexStatus` | Reconciles index/state/database counts. |
| `isAiIndexingActive` | Covers preparation and Python phases. |
| `scheduleAiIndexingForNewAssets` | Debounces import-triggered work. |
| `scheduleAiIndexingForThumbnailAsset` | Starts when a previously ineligible asset gains a thumbnail. |
| `clearAiIndexData` | Stops search, removes index/state, resets SQLite flags. |
| `runAiIndexing` | Enters shared AI coordinator. |
| `runAiIndexingExclusive` | Prepares all inputs, then launches and monitors Python indexing. |
| `markAssetsEmbeddedIds` | Updates `aiEmbedded` and emits changed IDs. |
| `startAiSearchWorker` | Launches persistent line-delimited text search process. |
| `stopAiSearchWorker` | Terminates worker and rejects pending requests. |
| `formatAiSearchResults` | Normalizes Python paths/scores to asset IDs. |

### DINOv3

| Function | Behavior |
| --- | --- |
| `isDinoImageIndexEnabled` | Reads explicit DINO enable state. |
| `getDinoIndexedAssetIds` | Reads IDs represented by the index state. |
| `getDinoIndexStatus` | Returns model/index/pending/running counts. |
| `sendDinoProgress` | Emits progress with current status. |
| `stopDinoIndexing` | Cancels active process and queued rerun. |
| `clearDinoIndexData` | Deletes the DINO vector index and metadata. |
| `scheduleDinoIndexing` | Debounces import-triggered work. |
| `dinoIndexIsFresh` | Compares expected sources with persisted state. |
| `ensureDinoIndex` | Checks enable/model/freshness before indexing. |
| `runDinoIndex` | Runs staged incremental index under shared coordinator. |
| `startDinoSearchWorker` | Starts persistent image-search process. |
| `stopDinoSearchWorker` | Stops process and resolves pending requests as failures. |

### Ollama And Web Grab

| Function | Behavior |
| --- | --- |
| `normalizeOllamaUrl` | Rewrites localhost to IPv4 and removes trailing slash. |
| `_wgGetCandidates` | Extracts prioritized remote media candidates. |
| `_wgDecodeDataUrl` | Saves one data URL with a safe filename. |
| `_wgDownload` | Downloads one remote candidate with metadata. |
| `_wgDownloadStructured` | Handles top-level and batch image payloads. |
| `_wgSanitize` | Bounds and normalizes request payload values. |
| `_wgBody` | Reads a size-limited request body. |
| `_wgHandle` | Implements health, compatibility, and import routes. |
| `startWebGrabServers` | Starts loopback servers and handles port conflicts. |

## Runtime Dependency Manager

| Function | Behavior |
| --- | --- |
| `runtimePaths` | Computes private runtime, executable, marker, state, and log paths. |
| `runtimeToolEnvironment` | Builds child-process-only media environment. |
| `installerUrl` | Selects Miniforge installer for current platform strategy. |
| `runtimeCondaSubdir` | Uses `win-64` packages on Windows ARM64. |
| `aiInstallerKind` | Chooses Conda on macOS and binary-only pip on Windows. |
| `imageMagickInstallerArch` | Chooses official Windows installer architecture. |
| `selectImageMagickInstaller` | Parses the newest matching official binary URL. |
| `sanitizeTerminalOutput` | Removes ANSI, control, backspace, and spinner artifacts. |
| `parseProgressPercent` | Parses percent or transferred/total byte text. |
| `createRuntimeDependencyManager` | Creates the stateful installer API. |
| `checkInternet` | Probes dependency hosts in parallel. |
| `download` | Streams to `.part`, emits byte progress, then atomically renames. |
| `run` | Spawns an installer/tool, logs output, and emits sanitized progress. |
| `installPython` | Runs silent Miniforge installation. |
| `condaInstall`, `pipInstall` | Install locked package ranges. |
| `installImageMagick`, `installGhostscript` | Install and validate media tools. |
| `installAiPackages` | Installs platform-appropriate AI packages. |
| `ensureCore`, `ensureAi` | Serialize install/repair and write versioned ready markers. |

## AI Model Manager

| Function | Behavior |
| --- | --- |
| `createAiModelManager` | Creates model status/download service. |
| `modelDir`, `markerPath` | Resolve feature snapshot paths. |
| `isInstalled`, `status`, `allStatus` | Validate markers and required files. |
| `fetchManifest` | Reads Hugging Face repository tree. |
| `downloadFile` | Streams one model file with aggregate progress. |
| `install` | Downloads required snapshot files and writes marker. |
| `cancel` | Aborts active feature download. |

## Python Runtime Helpers

| Function | Behavior |
| --- | --- |
| `runtimeTarget` | Produces platform/architecture identifier. |
| `pythonExecutable` | Resolves executable inside a runtime directory. |
| `pythonEnvironment` | Prevents user-site leakage and configures private paths. |
| `bundledRuntimeCandidates` | Lists managed and legacy candidate locations. |
| `findBundledPython` | Returns the first existing private executable. |
| `probePython` | Verifies interpreter and required imports with timeout. |

## Logger

| Function | Behavior |
| --- | --- |
| `safeError` | Converts errors to serializable structures. |
| `summarizeValue` | Bounds large/deep log payloads. |
| `RotatingFileStream` | Rotates log files by size and count. |
| `createLogger` | Creates root and module Pino loggers. |
| `installConsoleBridge` | Mirrors console calls into structured logs. |
| `installIpcLogging` | Wraps IPC handlers with duration and result/error logging. |

## Renderer Application

### `RuntimeBootstrap`

Owns readiness detection, onboarding screens, theme choice, internet checks, install resume, retry, progress display, and transition to `App`.

### `App`

Owns global drag/drop, shortcuts, settings hydration, startup page loading, full database hydration, palette backfill, runtime/AI listeners, thumbnail events, and shell composition.

Supporting functions:

- `waitForStartupIdle`: schedules lower-priority hydration.
- `queueExistingPaletteBackfill`: extracts missing palettes in small delayed batches.
- `notifyAssetMutation`: broadcasts cache-invalidating mutation phases.

### `MainContent`

Builds query options, loads/caches pages, applies local ordering that must preserve ranks, synchronizes toolbar counts, and chooses grid/skeleton/empty states.

- `matchSmart`: client fallback for smart rules.
- `getAllChildIds`: recursive folder expansion.
- `loadPage`: bounded SQLite page loader.
- `publishCachedPages`: merges cached pages with optimistic renderer objects.

### `AssetGrid`

Owns virtualized layouts, selection, card actions, context menus, drag out, justified-row computation, thumbnail source selection, labels, image export, and load-more thresholds.

- `pickGridThumb`: selects size/DPR-appropriate variant.
- `thumbnailLabelHeight`: reserves virtual layout height.
- `computeJustifiedRows`: fits rows to container width.
- `columnMetrics`: calculates masonry/grid columns.
- `virtualCardHeight`: supplies virtualizer measurements.

### `Inspector`

Owns single/multi asset editing, rating, notes, tags, folders, name changes, palette display, AI state, export/share/show actions, and metadata.

### `LightboxModal`

Dispatches extension-specific previews and owns lightbox zoom/pan/navigation.

- `ensureThreeJS`: loads Three.js and loaders once.
- `modelEnvironmentUrl`, `applyModelEnvironment`: configure 3D environment.
- `ConvertedImagePreview`: requests cached converted PNG.
- `PdfPreview`, `EpubPreview`, `TextPreview`, `FontPreview`: document viewers.
- `VideoScrubStrip`: lazy frame strip and seek control.
- `TsMpegtsPlayer`, `NativeVideoPlayer`: transport-stream and native playback.
- `PreviewContent`: central preview type dispatcher.

### `TitleBar`

Owns search field selection, AI text/image search controls, sorting, layout, filters, contact sheets, sensitive visibility, settings, and process-progress listeners.

### `Sidebar`

Owns navigation, counts, nested folder tree, tag list, inline folder edits, and sidebar collapse.

### `SettingsPanel`

Owns editable settings drafts, theme CSS application, library relocation, runtime repair, Ollama/model validation, AI feature controls, index deletion/reindexing, and shortcuts.

### `ProcessDock`

Normalizes and vertically displays import, copy, thumbnail, TIPSv2, DINO, and tagging tasks.

## Zustand Store

`useStore` is the renderer's command/state boundary.

### Import And Assets

- `importFiles`: serialized complete local import pipeline.
- `importUrl`: insert or refresh website asset.
- `updateAsset`: optimistic update plus SQLite persistence.
- `renameAsset`: filesystem/database coordinated rename.
- `deleteAssets`: soft-delete to Trash.
- `restoreAssets`: clear soft-delete state.
- `permanentDeleteWithPrompt`: choose disk or DB-only deletion.
- `permanentDeleteDbOnly`: remove library record only.
- `permanentDelete`: legacy hard-delete compatibility action.

### Selection And Navigation

- `setSelectedAssetIds`, `toggleSelectAsset`, `selectAll`, `clearSelection`.
- `setFilteredAssetIds`: publishes current visible IDs.
- `setActiveFolder`: switches navigation and clears selection.
- `setLightboxAsset`: opens preview and records 48-hour recency.

### Organization

- folder add/update/delete;
- smart-folder add/update/delete;
- tag add/delete/delete-all;
- search field/query, sort, filter, view, and thumbnail-size setters.

### AI Tagging

- `isAiTaggableAsset`: determines direct-source versus thumbnail eligibility.
- `hydrateAiSettings`: loads saved state without rewriting it.
- `setAiSettings`: validates Ollama/model before enabling.
- `startAiQueue`: deduplicates assets, acquires shared task, tags serially, persists results.
- `stopAiQueue`: clears pending work and releases/halts state.

### AI Search State

Setters hold TIPSv2/DINO feature status, progress, index state, search result IDs, loading state, and embedded asset flags.

## Thumbnail Engine

| Function | Behavior |
| --- | --- |
| `makeQueue` | Creates a dynamically resizable concurrency queue. |
| `applyImportThreads` | Maps user thread count onto video/3D queues. |
| `bgSaveThumb` | Persists renderer-generated thumbnail and updates store. |
| `bgProcessVideo` | Requests a video frame and saves it. |
| `render3DThumb` | Loads a model into an offscreen Three.js scene and captures WebP. |
| `make3DPlaceholder` | Creates a fallback card for unsupported 3D decoding. |
| `bgProcess3D` | Chooses rendered or placeholder 3D thumbnail. |
| `enqueueBackgroundThumbs` | Queues media assets and optionally starts AI tagging after completion. |
| `generateBackgroundThumbsSequential` | Runs bounded media thumbnail work and returns completed IDs. |

## Renderer Helpers

| Function | Behavior |
| --- | --- |
| `generateId` | Creates UUID-like asset IDs. |
| `formatSize`, `formatDate` | Human-readable metadata. |
| `getFileExt` | Normalizes lowercase extension. |
| `isEditableTarget` | Protects typing controls from global shortcuts. |
| `isImage`, `isVideo`, `isAudio`, `isFont`, `is3D`, `isDoc`, `isDesign` | Extension classifiers. |
| `extractPaletteFromImageSrc` | Quantizes representative colors from an image. |
| `extractPaletteOnceForAsset` | Deduplicates palette work per asset. |
| `createRendererLogger` | Creates structured renderer logging methods. |
| sharing helpers | Use Web Share where available and file-copy fallback otherwise. |

## Contract And Build Scripts

- `audit-code-health.js`: strict preload/IPC reachability, duplicate window, stale file, and unused dependency checks.
- `audit-ai-contracts.js`: AI enablement, scheduling, persistence, cancellation, and coordinator invariants.
- `audit-layout-contracts.js`: grid measurement, recents, icons, and filename wrapping.
- `audit-media-contracts.js`: EXIF orientation, F4V frames, large video, and 48-hour recents.
- `audit-python-runtime-contracts.js`: runtime paths, package strategy, and installer behavior.
- `audit-native-dependency-contracts.js`: all four target architectures and ABI pins.
- `prepare-native-deps.js`: target-specific native package rebuild.
- `prepare-poppler.js`: target-specific Poppler acquisition/preparation.
- `validate-packaged-native-deps.js`: binary format and architecture validation.
- `electron-builder-hooks.js`: after-pack validation entry point.
