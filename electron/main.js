// Enlarge libuv thread pool before any I/O — lets concurrent fs.promises.copyFile
// calls actually run in parallel at the OS level (default is 4).
process.env.UV_THREADPOOL_SIZE = String(Math.max(8, require('os').cpus().length))

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, nativeImage, clipboard, ShareMenu } = require('electron')
const path   = require('path')
const fs     = require('fs')

if (process.platform === 'darwin') {
  const macCliPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const existingPath = process.env.PATH ? process.env.PATH.split(path.delimiter) : []
  process.env.PATH = [...new Set([...macCliPaths, ...existingPath])].join(path.delimiter)
}

const { createLogger, installConsoleBridge, installIpcLogging, safeError } = require('./logger')
const { createRuntimeDependencyManager, runtimeToolEnvironment } = require('./runtimeDependencyManager')
const { createAiTaskCoordinator } = require('./aiTaskCoordinator')
const logger = createLogger(app)
installConsoleBridge(logger)
installIpcLogging(ipcMain, logger)
const mainLog = logger.childFor('main')
const aiTaskCoordinator = createAiTaskCoordinator()
const _rendererAiTaskReleases = new Map()
mainLog.info({ logFile: logger.logFile, logDir: logger.logDir, rotation: logger.rotation }, 'app logger initialized')
process.on('uncaughtException', err => mainLog.fatal({ err: safeError(err) }, 'uncaught exception'))
process.on('unhandledRejection', err => mainLog.error({ err: safeError(err) }, 'unhandled rejection'))

ipcMain.handle('log:renderer', (_ev, entry) => {
  const level = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(entry?.level) ? entry.level : 'info'
  if ((entry?.module === 'startup-ui' || entry?.module === 'assets-ui') && entry?.message) {
    console.log(entry.message)
  }
  logger.child({ process: 'renderer', module: entry?.module || 'renderer' })[level](
    { event: entry?.event, data: logger.summarize(entry?.data) },
    entry?.message || entry?.event || 'renderer log'
  )
  return true
})
// Enable hardware-accelerated video decoding on all platforms
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,HardwareMediaKeyHandling')
app.commandLine.appendSwitch('enable-accelerated-video-decode')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!parseWebsiteUrl(params?.src)) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
  })

  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      const safeUrl = parseWebsiteUrl(url)
      if (safeUrl) shell.openExternal(safeUrl).catch(() => {})
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!parseWebsiteUrl(url)) event.preventDefault()
    })
  }
})
const crypto = require('crypto')
const http   = require('http')
let _sharpLoaded = false
let _sharp = null
function getSharp() {
  if (_sharpLoaded) return _sharp
  _sharpLoaded = true
  try {
    _sharp = require('sharp')
  } catch (e) {
    _sharp = null
    mainLog.warn({ err: safeError(e) }, 'sharp unavailable; thumbnail generation will use fallbacks')
  }
  return _sharp
}

let mainWindow = null
let tray       = null
let forceQuit  = false   // set true when user picks "Quit" from tray menu
const runtimeDependencies = createRuntimeDependencyManager({
  app,
  logger: mainLog,
  sendProgress: progress => mainWindow?.webContents.send('runtime:progress', progress),
})
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  mainLog.info('secondary app instance detected; exiting because primary instance owns the lock')
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    mainLog.info({ commandLine, workingDirectory }, 'secondary app launch detected; restoring primary window')
    restoreMainWindow('second-instance')
  })
}

// ── Settings — tiny JSON, rarely changes ─────────────────────────────────────
function getSettingsPath() { return path.join(app.getPath('userData'), 'stag-settings.json') }
function getDefaultManagedPaths() {
  const stagDir = path.join(app.getPath('pictures'), 'Stag')
  return {
    localGrabDir: path.join(stagDir, 'LocalGrab'),
    webGrabDir: path.join(stagDir, 'WebGrab'),
  }
}
function makeFirstRunSettings() {
  const { localGrabDir, webGrabDir } = getDefaultManagedPaths()
  for (const dir of [localGrabDir, webGrabDir]) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) } catch {}
  }
  return {
    threads: Math.max(1, require('os').cpus().length),
    accentColor: '#cd10da',
    bgColor: '#0a0c10',
    glassOpacity: 0.07,
    blurStrength: 18,
    theme: 'dark',
    aiEmbeddingEnabled: false,
    dinoImageIndexEnabled: false,
    dinoImageIndexUserConfigured: false,
    aiSettings: { enabled: false, ollamaUrl: 'http://localhost:11434', model: 'llava' },
    importCopyPath: localGrabDir,
    webGrabPath: webGrabDir,
    showThumbnailFilename: true,
    showThumbnailExtensionInFilename: true,
    showThumbnailExtensionBadge: true,
  }
}
function migrateLegacyLibraryToDefault(legacyPath) {
  if (!legacyPath || !fs.existsSync(legacyPath)) return
  const source = path.resolve(legacyPath)
  const destination = path.resolve(path.join(app.getPath('userData'), 'stag-library'))
  if (source === destination) return

  try {
    if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
      const backup = `${destination}.backup-${Date.now()}`
      fs.renameSync(destination, backup)
      mainLog.info({ backup }, 'backed up the previous default library before restoring a custom library')
    }
    fs.mkdirSync(destination, { recursive: true })
    fs.cpSync(source, destination, { recursive: true, force: true })
    mainLog.info({ source, destination }, 'migrated legacy custom library to the default location')
  } catch (error) {
    mainLog.error({ error, source, destination }, 'could not migrate legacy custom library to the default location')
    throw error
  }
}
function loadSettings() {
  const defaults = makeFirstRunSettings()
  let stored = {}
  try {
    const p = getSettingsPath()
    if (fs.existsSync(p)) stored = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {}
  if (stored.libraryPath) migrateLegacyLibraryToDefault(stored.libraryPath)
  const normalized = {
    ...defaults,
    ...stored,
    importCopyPath: stored.importCopyPath || defaults.importCopyPath,
    webGrabPath: stored.webGrabPath || defaults.webGrabPath,
  }
  delete normalized.libraryPath
  delete normalized.importCopyEnabled
  if (JSON.stringify(normalized) !== JSON.stringify(stored)) saveSettings(normalized)
  return normalized
}
function saveSettings(s) {
  try {
    const p = getSettingsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(s, null, 2))
    return true
  } catch (e) {
    console.error(e)
    return false
  }
}

// ── Data directory ────────────────────────────────────────────────────────────
let _dataDir = null
function getDataDir() {
  if (_dataDir) { if (!fs.existsSync(_dataDir)) fs.mkdirSync(_dataDir, { recursive: true }); return _dataDir }
  const dir = path.join(app.getPath('userData'), 'stag-library')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  _dataDir = dir; return dir
}

// ── Thumbnail files — never stored in DB, always on disk ─────────────────────
// <dataDir>/thumbs/<first2charsOfId>/<id>.webp is the max thumbnail.
// Smaller variants work like mip levels: the renderer chooses the nearest
// size for the card's displayed dimensions and DPR, then falls back upward.
const THUMB_FULL_WIDTH = 768
const THUMB_MAX_DIM = 900
const THUMB_WEBP_QUALITY = 96
const THUMB_WEBP_OPTIONS = { quality: THUMB_WEBP_QUALITY, smartSubsample: true, effort: 4 }
const THUMB_CANVAS_QUALITY = 0.96
const THUMB_VARIANTS = [
  { key: 'sm', width: 192 },
  { key: 'md', width: 384 },
  { key: 'lg', width: 640 },
]
const THUMB_LEGACY_VARIANTS = [
  { key: 'sm', width: 256 },
  { key: 'md', width: 480 },
]
let _thumbVariantQueue = new Map()
let _thumbVariantRunning = false
let _thumbVariantTimer = null
let _thumbVariantWaiters = []
let _thumbQualityRefreshRows = []
function thumbLog(message, details = {}) {
  const extra = Object.keys(details).length ? ' ' + JSON.stringify(details) : ''
  console.log(`[Thumb ${new Date().toISOString()}] ${message}${extra}`)
}
function emitThumbProgress(data) {
  try {
    if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('thumb:progress', data)
    }
  } catch {}
}
function thumbBucketPath(id) {
  const bucket = path.join(getDataDir(), 'thumbs', id.slice(0, 2))
  if (!fs.existsSync(bucket)) fs.mkdirSync(bucket, { recursive: true })
  return bucket
}
function thumbFilePath(id) {
  return path.join(thumbBucketPath(id), id + '.webp')
}
function thumbVariantFilePath(id, key) {
  return path.join(thumbBucketPath(id), `${id}-${key}.webp`)
}
function fileUrl(p) {
  return 'file://' + p.replace(/\\/g, '/')
}
function thumbVariantUrls(id) {
  const variants = {}
  for (const v of THUMB_VARIANTS) {
    const p = thumbVariantFilePath(id, v.key)
    if (fs.existsSync(p)) variants[v.key] = fileUrl(p)
  }
  return variants
}
async function deleteThumbnailVariantFiles(id) {
  const keys = [...new Set([...THUMB_VARIANTS, ...THUMB_LEGACY_VARIANTS].map(v => v.key))]
  await Promise.all(keys.map(key => fs.promises.unlink(thumbVariantFilePath(id, key)).catch(() => {})))
}
function deleteThumbnailVariantFilesSync(id) {
  const keys = [...new Set([...THUMB_VARIANTS, ...THUMB_LEGACY_VARIANTS].map(v => v.key))]
  for (const key of keys) {
    try { fs.unlinkSync(thumbVariantFilePath(id, key)) } catch {}
  }
}
async function writeThumbnailVariants(id, sourceBuffer) {
  if (!THUMB_VARIANTS.length || !getSharp() || !sourceBuffer || sourceBuffer.length < 64) return {}
  const started = Date.now()
  thumbLog('variants:start', { id, variants: THUMB_VARIANTS.map(v => `${v.key}:${v.width}`).join(','), sourceBytes: sourceBuffer.length })
  const variants = {}
  await Promise.all(THUMB_VARIANTS.map(async v => {
    const variantStarted = Date.now()
    try {
      thumbLog('variant:start', { id, variant: v.key, width: v.width })
      const out = await _sharp(sourceBuffer, { animated: false })
        .resize({ width: v.width, height: v.width, fit: 'inside', withoutEnlargement: true })
        .webp(THUMB_WEBP_OPTIONS)
        .toBuffer()
      if (out && out.length > 64) {
        const p = thumbVariantFilePath(id, v.key)
        await fs.promises.writeFile(p, out)
        variants[v.key] = fileUrl(p)
        thumbLog('variant:done', { id, variant: v.key, ms: Date.now() - variantStarted, bytes: out.length })
      }
    } catch (e) {
      console.warn(`[Thumb] variant ${v.key} failed for ${id}:`, e.message)
    }
  }))
  thumbLog('variants:done', { id, count: Object.keys(variants).length, ms: Date.now() - started })
  return variants
}
function queueThumbnailVariants(id, { notify = true, delayMs = 250 } = {}) {
  if (!THUMB_VARIANTS.length || !getSharp() || !id) return
  _thumbVariantQueue.set(id, { notify })
  thumbLog('variant-queue:add', { id, notify, delayMs, queued: _thumbVariantQueue.size })
  if (_thumbVariantRunning || _thumbVariantTimer) return
  _thumbVariantTimer = setTimeout(() => {
    _thumbVariantTimer = null
    runThumbnailVariantQueue().catch(e => console.warn('[Thumb] variant queue failed:', e.message))
  }, delayMs)
}
function waitForThumbnailVariantQueue() {
  if (!THUMB_VARIANTS.length) return Promise.resolve()
  if (!_thumbVariantRunning && !_thumbVariantTimer && _thumbVariantQueue.size === 0) return Promise.resolve()
  return new Promise(resolve => _thumbVariantWaiters.push(resolve))
}
function resolveThumbnailVariantWaiters() {
  if (_thumbVariantRunning || _thumbVariantTimer || _thumbVariantQueue.size > 0) return
  const waiters = _thumbVariantWaiters
  _thumbVariantWaiters = []
  waiters.forEach(resolve => resolve())
}
async function runThumbnailVariantQueue() {
  if (!THUMB_VARIANTS.length || _thumbVariantRunning || !getSharp()) return
  _thumbVariantRunning = true
  const total = _thumbVariantQueue.size
  let done = 0
  thumbLog('variant-queue:start', { queued: total })
  emitThumbProgress({ type: 'variants', current: 0, total })
  try {
    while (_thumbVariantQueue.size) {
      const first = _thumbVariantQueue.entries().next().value
      if (!first) break
      const [id, opts] = first
      _thumbVariantQueue.delete(id)

      const started = Date.now()
      thumbLog('variant-queue:item:start', { id, remaining: _thumbVariantQueue.size })
      emitThumbProgress({ type: 'variants', current: done, total, file: id })
      const variants = await ensureThumbnailVariants(id)
      thumbLog('variant-queue:item:done', { id, ms: Date.now() - started, variants: Object.keys(variants) })
      done += 1
      emitThumbProgress({ type: 'variants', current: done, total, file: id })
      if (opts.notify && Object.keys(variants).length && mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('thumb:done', {
          id,
          thumbUrl: fileUrl(thumbFilePath(id)),
          thumbnailVariants: variants,
        })
      }
      await new Promise(r => setTimeout(r, 40))
    }
  } finally {
    _thumbVariantRunning = false
    thumbLog('variant-queue:idle', { queued: _thumbVariantQueue.size })
    if (_thumbVariantQueue.size && !_thumbVariantTimer) {
      _thumbVariantTimer = setTimeout(() => {
        _thumbVariantTimer = null
        runThumbnailVariantQueue().catch(e => console.warn('[Thumb] variant queue failed:', e.message))
      }, 120)
    } else {
      emitThumbProgress({ type: 'done', current: done, total })
      resolveThumbnailVariantWaiters()
    }
  }
}
async function saveThumbnailBuffer(id, buffer, options = {}) {
  const started = Date.now()
  const tp = thumbFilePath(id)
  let fullBuffer = buffer
  thumbLog('max:start', { id, mode: options.variantMode || 'async', inputBytes: buffer?.length || 0, width: THUMB_FULL_WIDTH })
  if (getSharp() && buffer?.length > 64) {
    try {
      fullBuffer = await _sharp(buffer, { animated: false })
        .resize({ width: THUMB_FULL_WIDTH, height: THUMB_FULL_WIDTH, fit: 'inside', withoutEnlargement: true })
        .webp(THUMB_WEBP_OPTIONS)
        .toBuffer()
    } catch (e) {
      console.warn(`[Thumb] full resize failed for ${id}:`, e.message)
      fullBuffer = buffer
    }
  }
  await fs.promises.writeFile(tp, fullBuffer)
  await deleteThumbnailVariantFiles(id)
  thumbLog('max:done', { id, ms: Date.now() - started, bytes: fullBuffer?.length || 0, file: tp })
  let variants = {}
  const variantMode = options.variantMode || 'async'
  if (variantMode === 'sync') {
    variants = await writeThumbnailVariants(id, fullBuffer)
  } else if (variantMode !== 'none') {
    queueThumbnailVariants(id, { notify: options.notifyVariants !== false })
  }
  return { tp, thumbUrl: fileUrl(tp), thumbnailVariants: variants }
}
async function ensureThumbnailVariants(id) {
  const tp = thumbFilePath(id)
  if (!THUMB_VARIANTS.length || !fs.existsSync(tp)) return {}
  const current = thumbVariantUrls(id)
  const missing = THUMB_VARIANTS.some(v => !current[v.key])
  if (!missing) return current
  try {
    const buf = await fs.promises.readFile(tp)
    return { ...current, ...(await writeThumbnailVariants(id, buf)) }
  } catch (e) {
    console.warn(`[Thumb] ensure variants failed for ${id}:`, e.message)
    return current
  }
}
function deleteThumbnailFiles(id) {
  fs.promises.unlink(thumbFilePath(id)).catch(() => {})
  deleteThumbnailVariantFiles(id)
}

// ── SQLite database ───────────────────────────────────────────────────────────
// better-sqlite3 uses native SQLite directly against the database file. The
// existing library.db files created by sql.js are regular SQLite files and open
// without conversion.
let _db     = null
let _dbPath = null
let _flushTimer = null
let _dbInitPromise = null
const _assetQueryCache = new Map()
let _ftsBackfillRunning = false
let _startupAssetPage = null
let _startupAssetCacheTimer = null
let _importCopyQueue = Promise.resolve()
const STARTUP_ASSET_PAGE_LIMIT = 50
const STARTUP_ASSET_CACHE_VERSION = 1

function getDbPath() { return path.join(getDataDir(), 'library.db') }

async function initDB() {
  if (_db) return _db
  if (_dbInitPromise) return _dbInitPromise
  _dbInitPromise = (async () => {
  const Database = require('better-sqlite3')
  _dbPath = getDbPath()

  _db = new Database(_dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('synchronous = NORMAL')
  _db.pragma('foreign_keys = ON')

  createSchema()
  cleanupLegacyAiStaging()
  return _db
  })().finally(() => { _dbInitPromise = null })
  return _dbInitPromise
}

// WAL keeps writes durable without exporting the whole DB. These functions are
// kept so existing write paths can request a checkpoint before copying/quitting.
function flushDB() {
  if (!_db) return
  if (_flushTimer) clearTimeout(_flushTimer)
  _flushTimer = setTimeout(() => {
    try { _db.pragma('wal_checkpoint(PASSIVE)') }
    catch (e) { console.error('[DB] checkpoint error:', e) }
  }, 200)
}

function flushDBNow() {
  if (!_db) return
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
  try { _db.pragma('wal_checkpoint(TRUNCATE)') }
  catch (e) { console.error('[DB] checkpointNow error:', e) }
}

function closeDB() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
  if (!_db) return
  try { _db.pragma('wal_checkpoint(TRUNCATE)') } catch {}
  try { _db.close() } catch (e) { console.error('[DB] close error:', e) }
  _db = null
}

function createSchema() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      ext         TEXT NOT NULL,
      filePath    TEXT NOT NULL,
      size        INTEGER NOT NULL DEFAULT 0,
      width       INTEGER,
      height      INTEGER,
      duration    REAL,
      mtime       INTEGER NOT NULL DEFAULT 0,
      btime       INTEGER NOT NULL DEFAULT 0,
      importTime  INTEGER NOT NULL DEFAULT 0,
      rating      INTEGER NOT NULL DEFAULT 0,
      notes       TEXT    NOT NULL DEFAULT '',
      url         TEXT    NOT NULL DEFAULT '',
      deleted     INTEGER NOT NULL DEFAULT 0,
      deletedAt   INTEGER,
      hasThumb    INTEGER NOT NULL DEFAULT 0,
      aiTagged    INTEGER NOT NULL DEFAULT 0,
      aiDescription TEXT NOT NULL DEFAULT '',
      aiEmbedded  INTEGER NOT NULL DEFAULT 0,
      aiEmbeddedVersion TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_assets_filePath   ON assets(filePath);
    CREATE INDEX IF NOT EXISTS idx_assets_importTime ON assets(importTime);
    CREATE INDEX IF NOT EXISTS idx_assets_ext        ON assets(ext);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted    ON assets(deleted);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted_import ON assets(deleted, importTime DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted_name   ON assets(deleted, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted_rating ON assets(deleted, rating DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted_size   ON assets(deleted, size DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted_ext_import ON assets(deleted, ext, importTime DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted_rating_import ON assets(deleted, rating DESC, importTime DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted_size_import ON assets(deleted, size DESC, importTime DESC);

    CREATE TABLE IF NOT EXISTS asset_tags (
      assetId TEXT NOT NULL,
      tag     TEXT NOT NULL,
      PRIMARY KEY (assetId, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_asset_tags_asset_tag ON asset_tags(assetId, tag);
    CREATE INDEX IF NOT EXISTS idx_asset_tags_lower_tag_asset ON asset_tags(lower(tag), assetId);

    CREATE TABLE IF NOT EXISTS asset_folders (
      assetId  TEXT NOT NULL,
      folderId TEXT NOT NULL,
      PRIMARY KEY (assetId, folderId)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_folders_folder ON asset_folders(folderId);
    CREATE INDEX IF NOT EXISTS idx_asset_folders_asset_folder ON asset_folders(assetId, folderId);
    CREATE INDEX IF NOT EXISTS idx_asset_folders_folder_asset ON asset_folders(folderId, assetId);

    CREATE TABLE IF NOT EXISTS asset_colors (
      assetId   TEXT NOT NULL,
      hex       TEXT NOT NULL,
      ratio     REAL NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_asset_colors_asset ON asset_colors(assetId);
    CREATE INDEX IF NOT EXISTS idx_asset_colors_asset_sort ON asset_colors(assetId, sortOrder);
    CREATE INDEX IF NOT EXISTS idx_asset_colors_lower_hex_asset ON asset_colors(lower(hex), assetId);

    CREATE TABLE IF NOT EXISTS asset_annotations (
      id      TEXT PRIMARY KEY,
      assetId TEXT NOT NULL,
      x       REAL NOT NULL,
      y       REAL NOT NULL,
      label   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_asset_annotations_asset ON asset_annotations(assetId);

    CREATE TABLE IF NOT EXISTS folders (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      parentId  TEXT,
      color     TEXT NOT NULL DEFAULT '#4a9eff',
      icon      TEXT NOT NULL DEFAULT '📁',
      sortOrder INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS folder_autotags (
      folderId TEXT NOT NULL,
      tag      TEXT NOT NULL,
      PRIMARY KEY (folderId, tag)
    );

    CREATE TABLE IF NOT EXISTS smart_folders (
      id    TEXT PRIMARY KEY,
      name  TEXT NOT NULL,
      logic TEXT NOT NULL DEFAULT 'ALL',
      rules TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS tags (
      tag TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id        TEXT PRIMARY KEY,
      type      TEXT NOT NULL,
      status    TEXT NOT NULL,
      total     INTEGER NOT NULL DEFAULT 0,
      current   INTEGER NOT NULL DEFAULT 0,
      message   TEXT NOT NULL DEFAULT '',
      payload   TEXT NOT NULL DEFAULT '{}',
      error     TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updatedAt DESC);
  `)

  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
        assetId UNINDEXED,
        name,
        ext,
        notes,
        aiDescription,
        tags
      );
    `)
  } catch (e) {
    console.warn('[DB] FTS unavailable:', e.message)
  }

  // Add new columns to existing DBs (safe — IF NOT EXISTS equivalent for columns)
  try { _db.exec('ALTER TABLE assets ADD COLUMN aiTagged INTEGER NOT NULL DEFAULT 0') } catch {}
  try { _db.exec("ALTER TABLE assets ADD COLUMN aiDescription TEXT NOT NULL DEFAULT ''") } catch {}
  try { _db.exec('ALTER TABLE assets ADD COLUMN aiEmbedded INTEGER NOT NULL DEFAULT 0') } catch {}
  try { _db.exec("ALTER TABLE assets ADD COLUMN aiEmbeddedVersion TEXT NOT NULL DEFAULT ''") } catch {}
}

// ── SQLite query helpers ──────────────────────────────────────────────────────

function dbRun(sql, params = []) {
  return _db.prepare(sql).run(params)
}

function dbAll(sql, params = []) {
  return _db.prepare(sql).all(params)
}

function dbGet(sql, params = []) {
  return _db.prepare(sql).get(params) || null
}

function dbTransaction(fn) {
  return _db.transaction(fn)()
}

// ── Write all relations for one asset (tags, folders, colors, annotations) ────
function writeRelations(asset) {
  dbRun('DELETE FROM asset_tags   WHERE assetId=?', [asset.id])
  dbRun('DELETE FROM asset_folders WHERE assetId=?', [asset.id])
  dbRun('DELETE FROM asset_colors  WHERE assetId=?', [asset.id])
  dbRun('DELETE FROM asset_annotations WHERE assetId=?', [asset.id])

  for (const tag of (asset.tags || [])) {
    dbRun('INSERT OR IGNORE INTO asset_tags (assetId,tag) VALUES (?,?)', [asset.id, tag])
    dbRun('INSERT OR IGNORE INTO tags (tag) VALUES (?)', [tag])
  }
  for (const fid of (asset.folders || []))
    dbRun('INSERT OR IGNORE INTO asset_folders (assetId,folderId) VALUES (?,?)', [asset.id, fid])
  for (let i = 0; i < (asset.colors || []).length; i++)
    dbRun('INSERT INTO asset_colors (assetId,hex,ratio,sortOrder) VALUES (?,?,?,?)', [asset.id, asset.colors[i].hex, asset.colors[i].ratio, i])
  for (const a of (asset.annotation || []))
    dbRun('INSERT OR REPLACE INTO asset_annotations (id,assetId,x,y,label) VALUES (?,?,?,?,?)', [a.id, asset.id, a.x, a.y, a.label])
  upsertAssetFts(asset.id)
  invalidateAssetQueryCache()
}

function upsertAssetFts(id) {
  if (!_db) return
  try {
    const row = dbGet('SELECT id,name,ext,notes,aiDescription FROM assets WHERE id=?', [id])
    if (!row) return
    const tags = dbAll('SELECT tag FROM asset_tags WHERE assetId=? ORDER BY tag', [id]).map(r => r.tag).join(' ')
    dbRun('DELETE FROM asset_fts WHERE assetId=?', [id])
    dbRun('INSERT INTO asset_fts(assetId,name,ext,notes,aiDescription,tags) VALUES(?,?,?,?,?,?)', [
      id, row.name || '', row.ext || '', row.notes || '', row.aiDescription || '', tags,
    ])
  } catch {}
}

function invalidateAssetQueryCache() {
  _assetQueryCache.clear()
  _startupAssetPage = null
  scheduleStartupAssetCacheRefresh()
}

function startupCachePath() {
  return path.join(getDataDir(), 'startup-cache.json')
}

function startupCacheSettingsKey(settings = loadSettings()) {
  const sensitiveTags = Array.isArray(settings?.sensitiveTags)
    ? settings.sensitiveTags.map(t => String(t).toLowerCase()).filter(Boolean).sort()
    : []
  const showSensitiveContent = settings?.showSensitiveContent !== undefined
    ? !!settings.showSensitiveContent
    : false
  return JSON.stringify({ showSensitiveContent, sensitiveTags })
}

function addThumbUrlsToAsset(row) {
  let thumbnailData
  let thumbnailVariants
  if (row?.hasThumb) {
    const tp = thumbFilePath(row.id)
    if (fs.existsSync(tp)) {
      thumbnailData = fileUrl(tp)
      const variants = {}
      for (const v of THUMB_VARIANTS) {
        const vp = thumbVariantFilePath(row.id, v.key)
        if (fs.existsSync(vp)) variants[v.key] = fileUrl(vp)
      }
      thumbnailVariants = variants
    }
  }
  return { thumbnailData, thumbnailVariants }
}

function hydrateStartupAssetRowsLite(assetRows) {
  const tagsMap = {}
  if (assetRows.length) {
    const ids = assetRows.map(r => r.id)
    const placeholders = ids.map(() => '?').join(',')
    for (const r of dbAll(`SELECT assetId, tag FROM asset_tags WHERE assetId IN (${placeholders})`, ids)) {
      ;(tagsMap[r.assetId] = tagsMap[r.assetId] || []).push(r.tag)
    }
  }

  return assetRows.map(row => {
    const { thumbnailData, thumbnailVariants } = addThumbUrlsToAsset(row)
    return {
      id: row.id,
      name: row.name,
      ext: row.ext,
      filePath: row.filePath,
      thumbnailData,
      thumbnailVariants,
      size: row.size,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      duration: row.duration ?? undefined,
      mtime: row.mtime,
      btime: row.btime,
      importTime: row.importTime,
      rating: row.rating,
      notes: '',
      url: '',
      deleted: row.deleted === 1,
      deletedAt: row.deletedAt ?? undefined,
      aiTagged: row.aiTagged === 1,
      aiDescription: undefined,
      aiEmbedded: row.aiEmbedded === 1,
      tags: tagsMap[row.id] || [],
      folders: [],
      colors: [],
      annotation: [],
    }
  })
}

function readStartupAssetCache() {
  try {
    const p = startupCachePath()
    if (!fs.existsSync(p)) return null
    const cached = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (cached?.version !== STARTUP_ASSET_CACHE_VERSION) return null
    if (cached?.settingsKey !== startupCacheSettingsKey()) return null
    if (!Array.isArray(cached?.assets)) return null
    return {
      assets: cached.assets,
      total: Number(cached.total || cached.assets.length),
      limit: STARTUP_ASSET_PAGE_LIMIT,
      offset: 0,
      cached: true,
      lite: true,
    }
  } catch {
    return null
  }
}

function writeStartupAssetCache(page) {
  try {
    if (!page?.assets) return
    const p = startupCachePath()
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({
      version: STARTUP_ASSET_CACHE_VERSION,
      settingsKey: startupCacheSettingsKey(),
      writtenAt: Date.now(),
      total: page.total || page.assets.length,
      assets: page.assets.slice(0, STARTUP_ASSET_PAGE_LIMIT),
    }))
    fs.renameSync(tmp, p)
  } catch (e) {
    console.warn('[Startup] cache write failed:', e?.message || e)
  }
}

function scheduleStartupAssetCacheRefresh(delayMs = 1500) {
  if (!_db) return
  if (_startupAssetCacheTimer) clearTimeout(_startupAssetCacheTimer)
  _startupAssetCacheTimer = setTimeout(() => {
    _startupAssetCacheTimer = null
    if (!_db) return
    try { loadStartupAssetPage({ writeCache: true }) }
    catch (e) { console.warn('[Startup] cache refresh failed:', e?.message || e) }
  }, delayMs)
}

function safeJsonStringify(value) {
  try { return JSON.stringify(value ?? {}) } catch { return '{}' }
}

function createJob(type, payload = {}, total = 0) {
  if (!_db) return null
  const now = Date.now()
  const id = `${type}-${now}-${crypto.randomBytes(4).toString('hex')}`
  dbRun(
    'INSERT INTO jobs(id,type,status,total,current,message,payload,error,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [id, String(type || 'job'), 'queued', Number(total || 0), 0, '', safeJsonStringify(payload), '', now, now],
  )
  return id
}

function updateJob(id, updates = {}) {
  if (!_db || !id) return false
  const cur = dbGet('SELECT * FROM jobs WHERE id=?', [id])
  if (!cur) return false
  dbRun(
    'UPDATE jobs SET status=?, total=?, current=?, message=?, payload=?, error=?, updatedAt=? WHERE id=?',
    [
      updates.status ?? cur.status,
      updates.total ?? cur.total,
      updates.current ?? cur.current,
      updates.message ?? cur.message,
      updates.payload !== undefined ? safeJsonStringify(updates.payload) : cur.payload,
      updates.error ?? cur.error,
      Date.now(),
      id,
    ],
  )
  return true
}

function ensureAssetFtsBackfilled() {
  if (!_db || _ftsBackfillRunning) return
  _ftsBackfillRunning = true
  const batchSize = 500
  let done = 0
  const step = () => {
    if (!_db) { _ftsBackfillRunning = false; return }
    try {
      const rows = dbAll(
        `SELECT a.id
           FROM assets a
           LEFT JOIN asset_fts f ON f.assetId=a.id
          WHERE f.assetId IS NULL
          LIMIT ?`,
        [batchSize],
      )
      if (!rows.length) {
        if (done) console.log(`[DB] FTS backfilled ${done} assets`)
        _ftsBackfillRunning = false
        return
      }
      for (const row of rows) upsertAssetFts(row.id)
      done += rows.length
      if (done % 5000 === 0) console.log(`[DB] FTS backfill progress ${done}`)
      setImmediate(step)
    } catch {
      _ftsBackfillRunning = false
    }
  }
  setImmediate(step)
}

// ── Load everything for startup ───────────────────────────────────────────────
function dbLoadAll(options = {}) {
  if (!_db) return { assets: [], folders: [], tags: [], smartFolders: [] }
  try {
    const started = Date.now()
    const limit = Number(options?.limit || 0)
    const metaOnly = options?.metaOnly === true
    const sensitiveTags = Array.isArray(options?.sensitiveTags)
      ? options.sensitiveTags.map(t => String(t).toLowerCase()).filter(Boolean)
      : []
    const hideSensitive = options?.showSensitiveContent === false && sensitiveTags.length > 0
    const candidateLimit = hideSensitive && limit > 0 ? Math.max(limit * 10, 120) : limit
    let assetRows = metaOnly
      ? []
      : candidateLimit > 0
      ? dbAll('SELECT * FROM assets ORDER BY importTime DESC LIMIT ?', [candidateLimit])
      : dbAll('SELECT * FROM assets ORDER BY importTime DESC')

    const loadRelationsForRows = (rows, { tagsOnly = false } = {}) => {
      const tagsMap = {}, foldMap = {}, colorMap = {}, annotMap = {}
      if (!rows.length) return { tagsMap, foldMap, colorMap, annotMap }
      const ids = rows.map(r => r.id)
      const placeholders = ids.map(() => '?').join(',')
      const allTags = dbAll(`SELECT assetId, tag FROM asset_tags WHERE assetId IN (${placeholders})`, ids)
      for (const r of allTags) { (tagsMap[r.assetId] = tagsMap[r.assetId] || []).push(r.tag) }
      if (tagsOnly) return { tagsMap, foldMap, colorMap, annotMap }

      const allFolds = dbAll(`SELECT assetId, folderId FROM asset_folders WHERE assetId IN (${placeholders})`, ids)
      const allColors = dbAll(`SELECT assetId, hex, ratio FROM asset_colors WHERE assetId IN (${placeholders}) ORDER BY assetId, sortOrder`, ids)
      const allAnnots = dbAll(`SELECT * FROM asset_annotations WHERE assetId IN (${placeholders})`, ids)
      for (const r of allFolds)  { (foldMap[r.assetId]  = foldMap[r.assetId]  || []).push(r.folderId) }
      for (const r of allColors) { (colorMap[r.assetId] = colorMap[r.assetId] || []).push({ hex: r.hex, ratio: r.ratio }) }
      for (const r of allAnnots) { (annotMap[r.assetId] = annotMap[r.assetId] || []).push({ id: r.id, x: r.x, y: r.y, label: r.label }) }
      return { tagsMap, foldMap, colorMap, annotMap }
    }

    let { tagsMap, foldMap, colorMap, annotMap } = loadRelationsForRows(assetRows, { tagsOnly: hideSensitive && limit > 0 })

    if (hideSensitive && limit > 0) {
      const sensitiveSet = new Set(sensitiveTags)
      assetRows = assetRows
        .filter(row => !(tagsMap[row.id] || []).some(tag => sensitiveSet.has(String(tag).toLowerCase())))
      if (assetRows.length < limit && candidateLimit > 0) {
        const allRows = dbAll('SELECT * FROM assets ORDER BY importTime DESC')
        ;({ tagsMap } = loadRelationsForRows(allRows, { tagsOnly: true }))
        assetRows = allRows
          .filter(row => !(tagsMap[row.id] || []).some(tag => sensitiveSet.has(String(tag).toLowerCase())))
      }
      assetRows = assetRows.slice(0, limit)
    } else if (limit > 0) {
      assetRows = assetRows.slice(0, limit)
    }
    ;({ tagsMap, foldMap, colorMap, annotMap } = loadRelationsForRows(assetRows))

    const thumbDirCache = new Map()
    const getThumbBucketFiles = (id) => {
      const bucket = path.join(getDataDir(), 'thumbs', id.slice(0, 2))
      if (!thumbDirCache.has(bucket)) {
        let files = new Set()
        try {
          if (fs.existsSync(bucket)) files = new Set(fs.readdirSync(bucket))
        } catch {}
        thumbDirCache.set(bucket, files)
      }
      return thumbDirCache.get(bucket)
    }

    const assets = assetRows.map(row => {
      let thumbnailData
      let thumbnailVariants
      if (row.hasThumb) {
        const bucketFiles = getThumbBucketFiles(row.id)
        if (bucketFiles.has(`${row.id}.webp`)) {
          const tp = path.join(getDataDir(), 'thumbs', row.id.slice(0, 2), `${row.id}.webp`)
          thumbnailData = fileUrl(tp)
          const variants = {}
          for (const v of THUMB_VARIANTS) {
            const filename = `${row.id}-${v.key}.webp`
            if (bucketFiles.has(filename)) {
              variants[v.key] = fileUrl(path.join(getDataDir(), 'thumbs', row.id.slice(0, 2), filename))
            }
          }
          thumbnailVariants = variants
        }
      }
      return {
        id: row.id, name: row.name, ext: row.ext, filePath: row.filePath,
        thumbnailData,
        thumbnailVariants,
        size: row.size, width: row.width ?? undefined, height: row.height ?? undefined,
        duration: row.duration ?? undefined, mtime: row.mtime, btime: row.btime,
        importTime: row.importTime, rating: row.rating, notes: row.notes, url: row.url,
        deleted: row.deleted === 1, deletedAt: row.deletedAt ?? undefined,
        aiTagged: row.aiTagged === 1, aiDescription: row.aiDescription || undefined,
        aiEmbedded: row.aiEmbedded === 1,
        tags: tagsMap[row.id] || [], folders: foldMap[row.id] || [],
        colors: colorMap[row.id] || [], annotation: annotMap[row.id] || [],
      }
    })

    // Folders with autoTags
    const folderRows = dbAll('SELECT * FROM folders ORDER BY sortOrder')
    const allAutoTags = dbAll('SELECT folderId, tag FROM folder_autotags')
    const atMap = {}
    for (const r of allAutoTags) { (atMap[r.folderId] = atMap[r.folderId] || []).push(r.tag) }
    const folders = folderRows.map(r => ({ id: r.id, name: r.name, parentId: r.parentId, color: r.color, icon: r.icon, sortOrder: r.sortOrder, autoTags: atMap[r.id] || [] }))

    const tags = dbAll('SELECT tag FROM tags ORDER BY tag').map(r => r.tag)
    const smartFolders = dbAll('SELECT * FROM smart_folders').map(r => ({ id: r.id, name: r.name, logic: r.logic, rules: JSON.parse(r.rules) }))

    console.log(`[Startup] dbLoadAll loaded ${assets.length}${limit ? `/${limit}` : ''} assets in ${Date.now() - started}ms${hideSensitive ? ' (sensitive hidden)' : ''}`)
    return { assets, folders, tags, smartFolders }
  } catch (e) { console.error('[DB] dbLoadAll:', e); return { assets: [], folders: [], tags: [], smartFolders: [] } }
}

function hydrateAssetRows(assetRows) {
  const tagsMap = {}, foldMap = {}, colorMap = {}, annotMap = {}
  if (!assetRows.length) return []
  const ids = assetRows.map(r => r.id)
  const placeholders = ids.map(() => '?').join(',')
  for (const r of dbAll(`SELECT assetId, tag FROM asset_tags WHERE assetId IN (${placeholders})`, ids)) {
    ;(tagsMap[r.assetId] = tagsMap[r.assetId] || []).push(r.tag)
  }
  for (const r of dbAll(`SELECT assetId, folderId FROM asset_folders WHERE assetId IN (${placeholders})`, ids)) {
    ;(foldMap[r.assetId] = foldMap[r.assetId] || []).push(r.folderId)
  }
  for (const r of dbAll(`SELECT assetId, hex, ratio FROM asset_colors WHERE assetId IN (${placeholders}) ORDER BY assetId, sortOrder`, ids)) {
    ;(colorMap[r.assetId] = colorMap[r.assetId] || []).push({ hex: r.hex, ratio: r.ratio })
  }
  for (const r of dbAll(`SELECT * FROM asset_annotations WHERE assetId IN (${placeholders})`, ids)) {
    ;(annotMap[r.assetId] = annotMap[r.assetId] || []).push({ id: r.id, x: r.x, y: r.y, label: r.label })
  }

  const thumbDirCache = new Map()
  const getThumbBucketFiles = (id) => {
    const bucket = path.join(getDataDir(), 'thumbs', id.slice(0, 2))
    if (!thumbDirCache.has(bucket)) {
      let files = new Set()
      try { if (fs.existsSync(bucket)) files = new Set(fs.readdirSync(bucket)) } catch {}
      thumbDirCache.set(bucket, files)
    }
    return thumbDirCache.get(bucket)
  }

  return assetRows.map(row => {
    let thumbnailData
    let thumbnailVariants
    if (row.hasThumb) {
      const bucketFiles = getThumbBucketFiles(row.id)
      if (bucketFiles.has(`${row.id}.webp`)) {
        thumbnailData = fileUrl(path.join(getDataDir(), 'thumbs', row.id.slice(0, 2), `${row.id}.webp`))
        const variants = {}
        for (const v of THUMB_VARIANTS) {
          const filename = `${row.id}-${v.key}.webp`
          if (bucketFiles.has(filename)) variants[v.key] = fileUrl(path.join(getDataDir(), 'thumbs', row.id.slice(0, 2), filename))
        }
        thumbnailVariants = variants
      }
    }
    return {
      id: row.id, name: row.name, ext: row.ext, filePath: row.filePath,
      thumbnailData, thumbnailVariants,
      size: row.size, width: row.width ?? undefined, height: row.height ?? undefined,
      duration: row.duration ?? undefined, mtime: row.mtime, btime: row.btime,
      importTime: row.importTime, rating: row.rating, notes: row.notes, url: row.url,
      deleted: row.deleted === 1, deletedAt: row.deletedAt ?? undefined,
      aiTagged: row.aiTagged === 1, aiDescription: row.aiDescription || undefined,
      aiEmbedded: row.aiEmbedded === 1,
      tags: tagsMap[row.id] || [], folders: foldMap[row.id] || [],
      colors: colorMap[row.id] || [], annotation: annotMap[row.id] || [],
    }
  })
}

function appendSmartRuleSql(where, params, rules = [], logic = 'ALL') {
  const parts = []
  for (const rule of Array.isArray(rules) ? rules : []) {
    const field = String(rule?.field || '')
    const operator = String(rule?.operator || '')
    const value = rule?.value
    if (field === 'rating') {
      const n = Number(value)
      if (!Number.isFinite(n)) continue
      if (operator === 'gte') { parts.push('a.rating>=?'); params.push(n) }
      else if (operator === 'lte') { parts.push('a.rating<=?'); params.push(n) }
      continue
    }
    if (field === 'tags') {
      if (operator === 'is' && String(value || '') === '') {
        parts.push('NOT EXISTS (SELECT 1 FROM asset_tags sr_at WHERE sr_at.assetId=a.id)')
      } else if (operator === 'contains') {
        parts.push('EXISTS (SELECT 1 FROM asset_tags sr_at WHERE sr_at.assetId=a.id AND lower(sr_at.tag) LIKE ?)')
        params.push(`%${String(value || '').toLowerCase()}%`)
      }
      continue
    }
    if (field === 'name') {
      parts.push('lower(a.name) LIKE ?')
      params.push(`%${String(value || '').toLowerCase()}%`)
      continue
    }
    if (field === 'ext') {
      parts.push('lower(a.ext)=?')
      params.push(String(value || '').toLowerCase())
      continue
    }
    if (field === 'color') {
      parts.push('EXISTS (SELECT 1 FROM asset_colors sr_ac WHERE sr_ac.assetId=a.id AND lower(sr_ac.hex)=?)')
      params.push(String(value || '').toLowerCase())
    }
  }
  if (parts.length) where.push(`(${parts.join(String(logic).toUpperCase() === 'ANY' ? ' OR ' : ' AND ')})`)
}

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function dbQueryAssets(options = {}) {
  if (!_db) return { assets: [], total: 0, limit: 0, offset: 0, cached: false }
  const key = JSON.stringify(options || {})
  const cached = _assetQueryCache.get(key)
  if (cached) return { ...cached, cached: true }

  const limit = Math.max(1, Math.min(5000, Number(options.limit || 500)))
  const offset = Math.max(0, Number(options.offset || 0))
  const where = []
  const params = []
  const joins = []
  const assetIds = Array.isArray(options.assetIds) ? options.assetIds.map(String).filter(Boolean) : []
  const idWindow = assetIds.length > 900 ? assetIds.slice(offset, offset + limit) : assetIds
  const idWindowMode = assetIds.length > 900

  const deleted = options.activeFolderType === 'trash' ? 1 : 0
  where.push('a.deleted=?')
  params.push(deleted)

  if (options.activeFolderType === 'folder' && Array.isArray(options.folderIds) && options.folderIds.length) {
    joins.push('JOIN asset_folders qf ON qf.assetId=a.id')
    where.push(`qf.folderId IN (${options.folderIds.map(() => '?').join(',')})`)
    params.push(...options.folderIds)
  } else if (options.activeFolderType === 'uncategorized') {
    where.push('NOT EXISTS (SELECT 1 FROM asset_folders af WHERE af.assetId=a.id)')
  } else if (options.activeFolderType === 'untagged') {
    where.push('NOT EXISTS (SELECT 1 FROM asset_tags at WHERE at.assetId=a.id)')
  }

  const q = String(options.searchQuery || '').trim()
  if (q) {
    const allowedFields = new Set(['name', 'description', 'extension', 'tag'])
    const fields = (Array.isArray(options.searchFields) ? options.searchFields : ['name'])
      .map(String)
      .filter(field => allowedFields.has(field))
    if (!fields.length) fields.push('name')
    const value = q.toLowerCase()
    const searchParts = []
    for (const field of fields) {
      if (field === 'description') {
        searchParts.push('(lower(a.notes) LIKE ? OR lower(a.aiDescription) LIKE ?)')
        params.push(`%${value}%`, `%${value}%`)
      } else if (field === 'extension') {
        searchParts.push('lower(a.ext) LIKE ?')
        params.push(`%${value.replace(/^\./, '')}%`)
      } else if (field === 'tag') {
        searchParts.push('EXISTS (SELECT 1 FROM asset_tags search_at WHERE search_at.assetId=a.id AND lower(search_at.tag) LIKE ?)')
        params.push(`%${value}%`)
      } else {
        searchParts.push('lower(a.name) LIKE ?')
        params.push(`%${value}%`)
      }
    }
    where.push(`(${searchParts.join(' OR ')})`)
  }

  if (Number(options.filterRating || 0) > 0) {
    where.push('a.rating>=?')
    params.push(Number(options.filterRating))
  }
  if (assetIds.length) {
    if (!idWindow.length) return { assets: [], total: assetIds.length, limit, offset, cached: false }
    where.push(`a.id IN (${idWindow.map(() => '?').join(',')})`)
    params.push(...idWindow)
  }
  appendSmartRuleSql(where, params, options.smartRules, options.smartLogic)
  if (Array.isArray(options.filterExts) && options.filterExts.length) {
    where.push(`a.ext IN (${options.filterExts.map(() => '?').join(',')})`)
    params.push(...options.filterExts.map(String))
  }
  if (options.showSensitiveContent === false && Array.isArray(options.sensitiveTags) && options.sensitiveTags.length) {
    const tags = options.sensitiveTags.map(t => String(t).toLowerCase())
    where.push(`NOT EXISTS (SELECT 1 FROM asset_tags st WHERE st.assetId=a.id AND lower(st.tag) IN (${tags.map(() => '?').join(',')}))`)
    params.push(...tags)
  }

  const sortMap = {
    name: 'a.name COLLATE NOCASE',
    size: 'a.size',
    rating: 'a.rating',
    date: 'a.importTime',
  }
  const sortCol = sortMap[options.sortBy] || sortMap.date
  const sortDir = String(options.sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const from = `FROM assets a ${joins.join(' ')}`
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = idWindowMode ? assetIds.length : dbGet(`SELECT COUNT(DISTINCT a.id) AS n ${from} ${whereSql}`, params)?.n || 0
  const orderSql = options.random
    ? 'RANDOM()'
    : assetIds.length && idWindow.length <= 900
    ? `CASE a.id ${idWindow.map((id, i) => `WHEN ${sqlStringLiteral(id)} THEN ${i}`).join(' ')} ELSE ${idWindow.length} END`
    : `${sortCol} ${sortDir}, a.id ASC`
  const rows = dbAll(
    `SELECT DISTINCT a.* ${from} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    [...params, limit, idWindowMode ? 0 : offset],
  )
  const result = { assets: hydrateAssetRows(rows), total, limit, offset, cached: false }
  _assetQueryCache.set(key, result)
  if (_assetQueryCache.size > 80) _assetQueryCache.delete(_assetQueryCache.keys().next().value)
  return result
}

function loadStartupAssetPage(options = {}) {
  if (!_db) return null
  const started = Date.now()
  try {
    const settings = loadSettings()
    const sensitiveTags = Array.isArray(settings?.sensitiveTags)
      ? settings.sensitiveTags.map(t => String(t).toLowerCase()).filter(Boolean)
      : []
    const showSensitiveContent = settings?.showSensitiveContent !== undefined
      ? !!settings.showSensitiveContent
      : false
    const hideSensitive = showSensitiveContent === false && sensitiveTags.length > 0
    const where = ['a.deleted=0']
    const params = []
    if (hideSensitive) {
      where.push(`NOT EXISTS (SELECT 1 FROM asset_tags st WHERE st.assetId=a.id AND lower(st.tag) IN (${sensitiveTags.map(() => '?').join(',')}))`)
      params.push(...sensitiveTags)
    }
    const whereSql = `WHERE ${where.join(' AND ')}`
    const rows = dbAll(
      `SELECT a.id,a.name,a.ext,a.filePath,a.size,a.width,a.height,a.duration,a.mtime,a.btime,a.importTime,a.rating,a.deleted,a.deletedAt,a.hasThumb,a.aiTagged,a.aiEmbedded
         FROM assets a
        ${whereSql}
        ORDER BY a.importTime DESC, a.id ASC
        LIMIT ?`,
      [...params, STARTUP_ASSET_PAGE_LIMIT],
    )
    const total = dbGet(`SELECT COUNT(*) AS n FROM assets a ${whereSql}`, params)?.n || rows.length
    _startupAssetPage = {
      assets: hydrateStartupAssetRowsLite(rows),
      total,
      limit: STARTUP_ASSET_PAGE_LIMIT,
      offset: 0,
      cached: false,
      lite: true,
    }
    if (options.writeCache !== false) writeStartupAssetCache(_startupAssetPage)
    console.log(`[Startup] lite first ${STARTUP_ASSET_PAGE_LIMIT} assets loaded in ${Date.now() - started}ms (${_startupAssetPage?.assets?.length || 0}/${_startupAssetPage?.total || 0})`)
  } catch (e) {
    _startupAssetPage = null
    console.warn('[Startup] first 50 assets load failed:', e.message)
  }
  return _startupAssetPage
}

function dbCountAssets(options = {}) {
  if (!_db) return { all: 0, uncategorized: 0, untagged: 0, trash: 0, folders: {}, tags: {}, extensions: {} }
  const sensitiveTags = Array.isArray(options.sensitiveTags) ? options.sensitiveTags.map(t => String(t).toLowerCase()).filter(Boolean) : []
  const hideSensitive = options.showSensitiveContent === false && sensitiveTags.length > 0
  const hiddenSql = hideSensitive
    ? ` AND NOT EXISTS (SELECT 1 FROM asset_tags st WHERE st.assetId=a.id AND lower(st.tag) IN (${sensitiveTags.map(() => '?').join(',')}))`
    : ''
  const visibleParams = hideSensitive ? sensitiveTags : []
  const countVisible = (extraSql = '', extraParams = []) =>
    dbGet(`SELECT COUNT(*) AS n FROM assets a WHERE a.deleted=0${hiddenSql}${extraSql}`, [...visibleParams, ...extraParams])?.n || 0
  const all = countVisible()
  const uncategorized = countVisible(' AND NOT EXISTS (SELECT 1 FROM asset_folders af WHERE af.assetId=a.id)')
  const untagged = countVisible(' AND NOT EXISTS (SELECT 1 FROM asset_tags at WHERE at.assetId=a.id)')
  const trash = dbGet(
    `SELECT COUNT(*) AS n FROM assets a WHERE a.deleted=1${hiddenSql}`,
    visibleParams,
  )?.n || 0
  const folders = {}
  for (const row of dbAll(
    `SELECT af.folderId, COUNT(DISTINCT a.id) AS n
       FROM asset_folders af
       JOIN assets a ON a.id=af.assetId
      WHERE a.deleted=0${hiddenSql}
      GROUP BY af.folderId`,
    visibleParams,
  )) folders[row.folderId] = row.n
  const tags = {}
  for (const row of dbAll(
    `SELECT at.tag, COUNT(DISTINCT a.id) AS n
       FROM asset_tags at
       JOIN assets a ON a.id=at.assetId
      WHERE a.deleted=0${hiddenSql}
      GROUP BY at.tag`,
    visibleParams,
  )) tags[row.tag] = row.n
  const extensions = {}
  for (const row of dbAll(
    `SELECT lower(a.ext) AS ext, COUNT(*) AS n
       FROM assets a
      WHERE a.deleted=0 AND trim(a.ext)<>''${hiddenSql}
      GROUP BY lower(a.ext)
      ORDER BY lower(a.ext)`,
    visibleParams,
  )) extensions[row.ext] = row.n
  return { all, uncategorized, untagged, trash, folders, tags, extensions }
}

// ── One-time migration from old library.json ──────────────────────────────────
function migrateFromJSON() {
  const jsonPath = path.join(getDataDir(), 'library.json')
  const doneFlag = path.join(getDataDir(), '.migrated_v2')
  if (!fs.existsSync(jsonPath) || fs.existsSync(doneFlag)) return
    console.log('[DB] Migrating library.json → SQLite …')
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    for (const f of (data.folders || [])) {
      dbRun('INSERT OR REPLACE INTO folders (id,name,parentId,color,icon,sortOrder) VALUES (?,?,?,?,?,?)',
        [f.id, f.name, f.parentId ?? null, f.color || '#4a9eff', f.icon || '📁', f.sortOrder || 0])
      dbRun('DELETE FROM folder_autotags WHERE folderId=?', [f.id])
      for (const t of (f.autoTags || [])) dbRun('INSERT OR IGNORE INTO folder_autotags (folderId,tag) VALUES (?,?)', [f.id, t])
    }
    for (const sf of (data.smartFolders || []))
      dbRun('INSERT OR REPLACE INTO smart_folders (id,name,logic,rules) VALUES (?,?,?,?)', [sf.id, sf.name, sf.logic, JSON.stringify(sf.rules)])
    for (const tag of (data.tags || []))
      dbRun('INSERT OR IGNORE INTO tags (tag) VALUES (?)', [tag])
    for (const asset of (data.assets || [])) {
      let hasThumb = 0
      if (asset.thumbnailData && asset.thumbnailData.startsWith('data:')) {
        try { fs.writeFileSync(thumbFilePath(asset.id), Buffer.from(asset.thumbnailData.split(',')[1], 'base64')); hasThumb = 1 } catch {}
      }
      dbRun(`INSERT OR IGNORE INTO assets (id,name,ext,filePath,size,width,height,duration,mtime,btime,importTime,rating,notes,url,deleted,deletedAt,hasThumb)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [asset.id, asset.name, asset.ext, asset.filePath,
         asset.size||0, asset.width||null, asset.height||null, asset.duration||null,
         asset.mtime||0, asset.btime||0, asset.importTime||Date.now(),
         asset.rating||0, asset.notes||'', asset.url||'',
         asset.deleted?1:0, asset.deletedAt||null, hasThumb])
      writeRelations(asset)
    }
    flushDB()
    fs.writeFileSync(doneFlag, String(Date.now()))
    fs.renameSync(jsonPath, jsonPath + '.bak')
    console.log('[DB] Migration complete.')
  } catch (e) { console.error('[DB] Migration failed:', e) }
}

// ── One-time thumb retry migration ────────────────────────────────────────────
// The old thumbnail code (nativeImage.createFromPath) silently failed for
// GIF, TIFF, WebP, and small-dimension images, but still wrote hasThumb=1.
// This migration resets hasThumb=0 for those formats so the new jimp/Chromium
// generator will retry them on next startup.
function migrateThumbRetry() {
  const doneFlag = path.join(getDataDir(), '.thumb_retry_v3')
  if (!_db || fs.existsSync(doneFlag)) return
  try {
    // Reset hasThumb for formats the old code failed on
    const formatsToRetry = ['gif','webp','tiff','tif','heic','heif','avif','svg',
                            'raw','cr2','nef','arw','dng','orf','rw2']
    const placeholders = formatsToRetry.map(() => '?').join(',')
    dbRun(
      `UPDATE assets SET hasThumb=0 WHERE hasThumb=1 AND ext IN (${placeholders}) AND deleted=0`,
      formatsToRetry
    )
    // Also reset hasThumb for small images where thumb file doesn't actually exist on disk
    // (the old code wrote hasThumb=1 even when toJPEG returned empty)
    const rows = dbAll(`SELECT id FROM assets WHERE hasThumb=1 AND deleted=0`, [])
    let missingCount = 0
    for (const row of rows) {
      const tp = thumbFilePath(row.id)
      if (!fs.existsSync(tp)) {
        dbRun('UPDATE assets SET hasThumb=0 WHERE id=?', [row.id])
        missingCount++
      }
    }
    flushDB()
    fs.writeFileSync(doneFlag, String(Date.now()))
    console.log(`[Migration] thumb_retry_v3: reset formats (${formatsToRetry.join(',')}) + ${missingCount} missing thumb files`)
  } catch (e) {
    console.error('[Migration] thumb_retry_v3 failed:', e)
  }
}

// ── Migration v4: retry pdf/epub now that thumbnail generation is supported ───
function migrateThumbRetryV4() {
  const doneFlag = path.join(getDataDir(), '.thumb_retry_v4')
  if (!_db || fs.existsSync(doneFlag)) return
  try {
    const formatsToRetry = ['pdf', 'epub']
    const placeholders = formatsToRetry.map(() => '?').join(',')
    dbRun(
      `UPDATE assets SET hasThumb=0 WHERE hasThumb=1 AND ext IN (${placeholders}) AND deleted=0`,
      formatsToRetry
    )
    flushDB()
    fs.writeFileSync(doneFlag, String(Date.now()))
    console.log(`[Migration] thumb_retry_v4: reset pdf/epub assets for thumbnail regeneration`)
  } catch (e) {
    console.error('[Migration] thumb_retry_v4 failed:', e)
  }
}

// ── Migration v5: retry newly supported formats ────────────────────────────────
function migrateThumbRetryV5() {
  const doneFlag = path.join(getDataDir(), '.thumb_retry_v5')
  if (!_db || fs.existsSync(doneFlag)) return
  try {
    const formatsToRetry = ['jpe','jfif','hif','icns','tga','dds','eps','m2ts','heic','heif']
    const placeholders = formatsToRetry.map(() => '?').join(',')
    dbRun(
      `UPDATE assets SET hasThumb=0 WHERE ext IN (${placeholders}) AND deleted=0`,
      formatsToRetry
    )
    flushDB()
    fs.writeFileSync(doneFlag, String(Date.now()))
    console.log(`[Migration] thumb_retry_v5: reset ${formatsToRetry.join(',')} for thumbnail regeneration`)
  } catch (e) {
    console.error('[Migration] thumb_retry_v5 failed:', e)
  }
}

// ── Migration v7: retry PDF/ICO after stronger macOS fallbacks ───────────────
function migrateThumbRetryV7() {
  const doneFlag = path.join(getDataDir(), '.thumb_retry_v7')
  if (!_db || fs.existsSync(doneFlag)) return
  try {
    const formatsToRetry = ['pdf', 'ico']
    const placeholders = formatsToRetry.map(() => '?').join(',')
    dbRun(
      `UPDATE assets SET hasThumb=0 WHERE ext IN (${placeholders}) AND deleted=0`,
      formatsToRetry
    )
    flushDB()
    fs.writeFileSync(doneFlag, String(Date.now()))
    console.log(`[Migration] thumb_retry_v7: reset ${formatsToRetry.join(',')} assets for thumbnail regeneration`)
  } catch (e) {
    console.error('[Migration] thumb_retry_v7 failed:', e)
  }
}

// ── Migration v8: retry after ICO Chromium decode and large-PDF support ──────
function migrateThumbRetryV8() {
  const doneFlag = path.join(getDataDir(), '.thumb_retry_v8')
  if (!_db || fs.existsSync(doneFlag)) return
  try {
    const formatsToRetry = ['pdf', 'ico']
    const placeholders = formatsToRetry.map(() => '?').join(',')
    dbRun(
      `UPDATE assets SET hasThumb=0 WHERE ext IN (${placeholders}) AND deleted=0`,
      formatsToRetry
    )
    flushDB()
    fs.writeFileSync(doneFlag, String(Date.now()))
    console.log(`[Migration] thumb_retry_v8: reset ${formatsToRetry.join(',')} assets for thumbnail regeneration`)
  } catch (e) {
    console.error('[Migration] thumb_retry_v8 failed:', e)
  }
}

// ── Migration v9: regenerate thumbnails that ignored EXIF orientation ────────
async function migrateOrientedImageThumbsV9() {
  const doneFlag = path.join(getDataDir(), '.thumb_orientation_v9')
  if (!_db || fs.existsSync(doneFlag) || !getSharp()) return
  try {
    const rows = dbAll(
      `SELECT id, filePath FROM assets
       WHERE hasThumb=1 AND deleted=0 AND ext IN ('jpg','jpeg','jpe','jfif','tif','tiff','heic','heif')`,
      [],
    )
    let reset = 0
    for (const row of rows) {
      if (!row.filePath || !fs.existsSync(row.filePath)) continue
      try {
        const meta = await _sharp(row.filePath, { animated: false }).metadata()
        if (!meta.orientation || meta.orientation === 1) continue
        await fs.promises.unlink(thumbFilePath(row.id)).catch(() => {})
        await deleteThumbnailVariantFiles(row.id)
        dbRun('UPDATE assets SET hasThumb=0 WHERE id=?', [row.id])
        reset += 1
      } catch {}
    }
    if (reset) {
      invalidateAssetQueryCache()
      flushDB()
    }
    fs.writeFileSync(doneFlag, String(Date.now()))
    console.log(`[Migration] thumb_orientation_v9: reset ${reset} EXIF-oriented thumbnails`)
  } catch (e) {
    console.error('[Migration] thumb_orientation_v9 failed:', e)
  }
}

// ── Migration v6: regenerate older compressed thumbnails at higher quality ────
function migrateThumbQualityV6() {
  const doneFlag = path.join(getDataDir(), '.thumb_quality_v6')
  if (!_db || fs.existsSync(doneFlag)) return
  try {
    fs.writeFileSync(doneFlag, String(Date.now()))
    _thumbQualityRefreshRows = []
    console.log('[Migration] thumb_quality_v6: skipped legacy full-thumbnail refresh; missing variants will be backfilled on demand')
  } catch (e) {
    console.error('[Migration] thumb_quality_v6 failed:', e)
  }
}

function reconcileMissingThumbnailFiles() {
  if (!_db) return 0
  const rows = dbAll('SELECT id FROM assets WHERE hasThumb=1 AND deleted=0', [])
  const missingIds = rows
    .filter(row => !fs.existsSync(thumbFilePath(row.id)))
    .map(row => row.id)
  if (!missingIds.length) return 0

  const batchSize = 400
  for (let offset = 0; offset < missingIds.length; offset += batchSize) {
    const batch = missingIds.slice(offset, offset + batchSize)
    const placeholders = batch.map(() => '?').join(',')
    dbRun(`UPDATE assets SET hasThumb=0 WHERE id IN (${placeholders})`, batch)
  }
  invalidateAssetQueryCache()
  flushDB()
  console.log(`[Thumb] Reset ${missingIds.length} assets whose thumbnail files are missing`)
  return missingIds.length
}

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Dead-asset watcher
// Watches the parent directories of all imported assets. When a file is removed
// from disk, we mark it deleted in the DB and push 'assets:removed' to the
// renderer. Everything runs asynchronously in idle batches so the UI is never
// blocked.
// ══════════════════════════════════════════════════════════════════════════════
const _dirWatchers   = new Map()  // dirPath → FSWatcher
const _pendingChecks = new Set()  // assetId → queued for existence check
let   _checkTimer    = null
let   _suppressWatcher = false    // true while we are doing a programmatic delete
let   _thumbWorkerRunning = false // prevents concurrent thumb worker instances

// Called once on startup and again whenever new assets are imported.
function rebuildDirWatchers() {
  if (!_db) return

  // Collect every unique parent directory of non-deleted assets
  let rows = []
  try { rows = dbAll(`SELECT id, filePath FROM assets WHERE deleted=0`, []) } catch { return }

  const dirToIds = new Map()
  for (const { id, filePath } of rows) {
    if (!filePath || typeof filePath !== 'string') continue
    const dir = path.dirname(filePath)
    if (!dirToIds.has(dir)) dirToIds.set(dir, [])
    dirToIds.get(dir).push(id)
  }

  // Stop watchers for dirs we no longer care about
  for (const [dir, watcher] of _dirWatchers) {
    if (!dirToIds.has(dir)) { try { watcher.close() } catch {} ; _dirWatchers.delete(dir) }
  }

  // Start new watchers
  for (const [dir, ids] of dirToIds) {
    if (_dirWatchers.has(dir)) continue
    if (!fs.existsSync(dir)) {
      // Entire directory is gone — queue all its assets for removal
      for (const id of ids) _pendingChecks.add(id)
      scheduleDeadAssetFlush()
      continue
    }
    try {
      // IMPORTANT: do NOT close over `ids` — that snapshot goes stale when new
      // assets are added to this dir. Instead, re-query the DB live on every event
      // so newly-imported assets in the same dir are always covered.
      const watchedDir = dir
      const watcher = fs.watch(dir, { persistent: false }, (event) => {
        if (event !== 'rename' && event !== 'change') return
        // Ignore events we triggered ourselves (programmatic delete/import)
        if (_suppressWatcher) return
        // Re-query current live IDs for this dir
        try {
          const liveRows = dbAll(`SELECT id FROM assets WHERE deleted=0 AND filePath LIKE ?`, [watchedDir + path.sep + '%'])
          const liveRows2 = process.platform === 'win32' ? [] :
            dbAll(`SELECT id FROM assets WHERE deleted=0 AND filePath LIKE ?`, [watchedDir + '/%'])
          const allIds = [...new Set([...liveRows, ...liveRows2].map(r => r.id))]
          for (const id of allIds) _pendingChecks.add(id)
        } catch {}
        scheduleDeadAssetFlush()
      })
      watcher.on('error', () => { _dirWatchers.delete(dir) })
      _dirWatchers.set(dir, watcher)
    } catch { /* dir not watchable — skip */ }
  }
}

function scheduleDeadAssetFlush() {
  if (_checkTimer) clearTimeout(_checkTimer)
  // Debounce: coalesce rapid rename events (e.g. batch delete) into one pass
  _checkTimer = setTimeout(flushDeadAssetChecks, 800)
}

async function flushDeadAssetChecks() {
  if (!_pendingChecks.size || !_db) return
  const ids = [..._pendingChecks]
  _pendingChecks.clear()

  const removedIds = []

  // Check in small async batches — yield between each so main thread stays free
  const BATCH = 50
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    for (const id of batch) {
      let row
      try { row = dbGet(`SELECT filePath, deleted FROM assets WHERE id=?`, [id]) } catch { continue }
      if (!row || row.deleted === 1) continue
      try {
        await fs.promises.access(row.filePath, fs.constants.F_OK)
        // File still exists — no action
      } catch {
        // File is gone — mark deleted in DB
        try {
          dbRun(`UPDATE assets SET deleted=1, deletedAt=? WHERE id=?`, [Date.now(), id])
          flushDB()
          removedIds.push(id)
          console.log('[DeadAsset] Removed:', row.filePath)
        } catch {}
      }
    }
    // Yield to event loop between batches
    await new Promise(r => setImmediate(r))
  }

  if (removedIds.length && mainWindow?.webContents) {
    mainWindow.webContents.send('assets:removed', removedIds)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Browser Extension Bridge
//
// Architecture:
//   • Local HTTP server on 127.0.0.1:57432  (only accessible from this machine)
//   • Extension POSTs to http://localhost:57432/imagegrab with JSON:
//       { filename: string, dataUrl: string }   — base64 image from extension
//   • Server saves the file to <dataDir>/inbox/<timestamp>_<filename>
//   • An fs.watch on the inbox dir picks up new files → imports them into DB
//     → pushes 'assets:added' to renderer (if open)
//   • On every app launch: scan inbox for any files accumulated while app was closed
//
// App-closed resilience:
//   • The HTTP server runs inside the Electron main process, which is alive
//     whenever the app is open.
//   • Files saved to inbox/ are processed immediately if app is open, OR on
//     next launch via scanInboxOnStartup(). The inbox folder persists on disk.
// ══════════════════════════════════════════════════════════════════════════════
const BRIDGE_PORT    = 57432
const BRIDGE_HOST    = '127.0.0.1'
let   _bridgeServer  = null
let   _inboxWatcher  = null

const IMAGE_EXTS = new Set(['jpg','jpeg','jpe','jfif','png','gif','webp','bmp','tiff','tif','avif','heic','heif','hif','icns','tga','dds','eps','svg'])
const VIDEO_EXTS = new Set(['mp4','webm','mov','avi','mkv','m4v','f4v','ts','mts','m2ts','mpg','mpeg','flv','wmv','3gp'])

// ── Detect real image format from magic bytes ─────────────────────────────────
// Reads the first few bytes of a Buffer and returns the true extension.
// This prevents saving a JPEG with a .webp extension (or vice versa) when
// the browser extension encodes the payload in a different format than the URL.
function detectImageExt(buf) {
  if (!buf || buf.length < 12) return null
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg'
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png'
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif'
  // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp'
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp'
  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
      (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)) return 'tiff'
  // AVIF/HEIC/MP4/MOV: all use an ftyp box at bytes 4-7
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.slice(8, 12).toString('ascii')
    if (/avif|avis/i.test(brand)) return 'avif'
    if (/heic|heix|hevc|mif1|msf1/i.test(brand)) return 'heic'
    // MP4/MOV/M4V brands — do NOT override filename ext; return null so caller uses it
    if (/isom|iso2|mp4[1-9]|M4V |M4A |M4P |avc1|dash|qt  |mmp4|f4v |f4p |crx2|MSNV/i.test(brand)) return null
    return null // unknown ftyp: trust the filename extension
  }
  // SVG: starts with '<svg' or '<?xml'
  const head = buf.slice(0, 32).toString('utf8').trimStart()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg'
  return null
}

// Convert MIME type string to extension
function mimeToExt(mime) {
  if (!mime) return null
  const map = {
    'jpeg': 'jpg', 'jpg': 'jpg', 'png': 'png', 'gif': 'gif',
    'webp': 'webp', 'bmp': 'bmp', 'tiff': 'tiff', 'avif': 'avif',
    'heic': 'heic', 'heif': 'heif', 'svg+xml': 'svg', 'svg': 'svg',
  }
  return map[mime.toLowerCase()] || null
}

function getInboxDir() {
  // User-configurable via settings.webGrabPath; falls back to <dataDir>/inbox
  let dir
  try {
    const s = loadSettings()
    if (s.webGrabPath && s.webGrabPath.trim()) dir = s.webGrabPath.trim()
  } catch {}
  if (!dir) dir = path.join(getDataDir(), 'inbox')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function restartInboxWatcher() {
  if (_inboxWatcher) { try { _inboxWatcher.close() } catch {} ; _inboxWatcher = null }
  startInboxWatcher()
}

// ── HTTP server — receives POSTs from the extension ──────────────────────────
function startBridgeServer() {
  if (_bridgeServer) return

  _bridgeServer = http.createServer((req, res) => {
    // CORS — allow the extension's chrome-extension:// origin
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // ── Video stream endpoint — serves local files with range request support ──
    // Used by the mpegts.js player in the renderer for .ts playback.
    if (req.method === 'GET' && req.url?.startsWith('/videostream')) {
      try {
        const qs = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`).searchParams
        const filePath = qs.get('path')
        if (!filePath || !fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return }
        const ext  = path.extname(filePath).slice(1).toLowerCase()
        const mime = ext === 'ts' || ext === 'mts' || ext === 'm2ts'
          ? 'video/mp2t'
          : ext === 'flv' ? 'video/x-flv' : `video/${ext || 'mp4'}`
        const stat = fs.statSync(filePath)
        const total = stat.size
        res.setHeader('Content-Type', mime)
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        const range = req.headers.range
        if (range) {
          const [s, e] = range.replace(/bytes=/, '').split('-')
          const start = parseInt(s, 10)
          const end   = e ? parseInt(e, 10) : total - 1
          if (start >= total) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return }
          const chunkSize = end - start + 1
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': chunkSize })
          fs.createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.writeHead(200, { 'Content-Length': total })
          fs.createReadStream(filePath).pipe(res)
        }
      } catch (e) { res.writeHead(500); res.end(String(e)) }
      return
    }

    if (req.method !== 'POST' || req.url !== '/imagegrab') {
      res.writeHead(404); res.end('Not found'); return
    }

    let body = ''
    req.on('data', chunk => { body += chunk; if (body.length > 30 * 1024 * 1024) req.destroy() })
    req.on('end', async () => {
      try {
        const { filename, dataUrl } = JSON.parse(body)
        if (!dataUrl || !filename) { res.writeHead(400); res.end('missing fields'); return }

        // Decode base64 payload
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
        const imgBuf = Buffer.from(base64, 'base64')

        // ── Detect ACTUAL format from magic bytes, then from data URL MIME ──
        // Do NOT trust the filename extension — Chrome often sends a .webp filename
        // but encodes the payload as JPEG (or vice versa). The magic bytes never lie.
        const actualExt = detectImageExt(imgBuf) ||
          mimeToExt(dataUrl.match(/data:image\/([^;,]+)/)?.[1]) ||
          path.extname(filename).slice(1).toLowerCase() ||
          'jpg'

        // Build the destination path using the REAL extension
        const stem = path.basename(filename, path.extname(filename))
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 150)
        const dest = path.join(getInboxDir(), `${Date.now()}_${stem}.${actualExt}`)

        await fs.promises.writeFile(dest, imgBuf)
        console.log('[Bridge] Saved to inbox:', dest, '(ext corrected to:', actualExt + ')')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, saved: dest }))
      } catch (e) {
        console.error('[Bridge] Error:', e)
        res.writeHead(500); res.end(String(e))
      }
    })
  })

  _bridgeServer.on('error', e => {
    // Port already in use (another app instance) — that's fine, just skip
    console.warn('[Bridge] Server error (port in use?):', e.message)
    _bridgeServer = null
  })

  _bridgeServer.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`[Bridge] Listening on ${BRIDGE_HOST}:${BRIDGE_PORT}`)
  })
}

// ── Inbox watcher — picks up files written by the HTTP server ─────────────────
function startInboxWatcher() {
  if (_inboxWatcher) return
  const inboxDir = getInboxDir()
  try {
    _inboxWatcher = fs.watch(inboxDir, { persistent: false }, (event, filename) => {
      if (event !== 'rename' || !filename) return
      const full = path.join(inboxDir, filename)
      // Small delay so the write is fully flushed before we read it
      setTimeout(() => processInboxFile(full), 300)
    })
    _inboxWatcher.on('error', () => { _inboxWatcher = null })
  } catch (e) { console.warn('[Bridge] Cannot watch inbox:', e.message) }
}

// ── Re-generate thumbnail for an already-imported asset that is missing one ──
async function _regenerateThumb(id, filePath, ext) {
  try {
    let result = null
    if (IMAGE_EXTS.has(ext)) {
      result = await generateThumbForFile(filePath, ext, id)
      if (result) {
        dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
        flushDB()
        scheduleAiIndexingForThumbnailAsset(id, 'regenerated image thumbnail')
        if (mainWindow?.webContents) {
          mainWindow.webContents.send('assets:thumbReady', { id, thumbnailData: result.thumbUrl, thumbnailVariants: result.thumbnailVariants })
          mainWindow.webContents.send('thumb:done', { id, thumbUrl: result.thumbUrl, thumbnailVariants: result.thumbnailVariants, width: result.imgW, height: result.imgH })
        }
        console.log(`[Thumb] regenerated for ${id}`)
      }
    } else if (VIDEO_EXTS.has(ext)) {
      if (ext === 'ts' || ext === 'mts') {
        result = await captureVideoFrameFFmpeg(filePath, id)
      } else {
        result = await captureVideoFrame(filePath)
        if (!result) result = await captureVideoFrameFFmpeg(filePath, id)
      }
      if (result?.imgBuf?.length > 64) {
        const saved = await saveThumbnailBuffer(id, result.imgBuf)
        dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
        flushDB()
        scheduleAiIndexingForThumbnailAsset(id, 'regenerated video thumbnail')
        if (mainWindow?.webContents) {
          mainWindow.webContents.send('assets:thumbReady', { id, thumbnailData: saved.thumbUrl, thumbnailVariants: saved.thumbnailVariants })
          mainWindow.webContents.send('thumb:done', { id, thumbUrl: saved.thumbUrl, thumbnailVariants: saved.thumbnailVariants, width: result.imgW, height: result.imgH })
        }
        console.log(`[Thumb] video regenerated for ${id}`)
      }
    }
  } catch (e) { console.error('[Thumb] _regenerateThumb error:', e.message) }
}

// ── Process a single inbox file — import it into the DB ──────────────────────
async function processInboxFile(filePath, sourceTag = 'web-grab') {
  if (!fs.existsSync(filePath)) return
  if (!_db) return

  // Read first bytes to detect the real format — the filename extension may be wrong
  // (e.g. Chrome saving a WebP as .jpeg, or the bridge server correcting .webp→.jpg)
  // For VIDEO files, never override the filename extension with magic-byte detection —
  // detectImageExt only knows image formats; a .ts file must stay 'ts'.
  const filenameExt = path.extname(filePath).slice(1).toLowerCase()
  let realExt
  if (!VIDEO_EXTS.has(filenameExt)) {
    try {
      const head = Buffer.alloc(12)
      const fd = await fs.promises.open(filePath, 'r')
      await fd.read(head, 0, 12, 0)
      await fd.close()
      realExt = detectImageExt(head)
    } catch {}
  }

  const ext  = realExt || filenameExt || 'jpg'
  const name = path.basename(filePath, path.extname(filePath))
    .replace(/^\d+_/, '')          // strip timestamp prefix
    .replace(/[_-]+/g, ' ')        // underscores → spaces for readability
    .trim()

  console.log(`[processInboxFile] ${path.basename(filePath)} → ext=${ext} filenameExt=${filenameExt}`)

  // Check if already imported (by filePath)
  try {
    const existing = dbGet(`SELECT id, hasThumb FROM assets WHERE filePath=?`, [filePath])
    if (existing) {
      // If imported before but missing thumbnail, try to generate it now
      if (!existing.hasThumb && (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext))) {
        console.log(`[processInboxFile] re-generating missing thumb for ${path.basename(filePath)}`)
        await _regenerateThumb(existing.id, filePath, ext)
      }
      return
    }
  } catch {}

  let stat
  try { stat = await fs.promises.stat(filePath) } catch { return }

  const id = crypto.randomUUID().replace(/-/g, '').substring(0, 20)

  // ── Generate compressed thumbnail + read real image dimensions ──────────────
  // nativeImage: createFromPath → getSize (real dims) → resize → toJPEG (compressed)
  let hasThumb = 0
  let thumbnailData = undefined
  let thumbnailVariants = undefined
  let imgWidth  = null
  let imgHeight = null

  if (IMAGE_EXTS.has(ext)) {
    try {
      if (stat.size < 60 * 1024 * 1024) {
        const result = await generateThumbForFile(filePath, ext, id)
        if (result) {
          imgWidth  = result.imgW
          imgHeight = result.imgH
          hasThumb  = 1
          thumbnailData = result.thumbUrl
          thumbnailVariants = result.thumbnailVariants
          console.log('[Bridge] Thumb: ' + imgWidth + 'x' + imgHeight + ', file=' + result.tp)
        }
      }
    } catch (e) { console.warn('[Bridge] Thumb generation failed:', e.message) }
  } else if (VIDEO_EXTS.has(ext)) {
    try {
      // .ts/.mts/.m2ts files: always use ffmpeg (Chromium cannot seek MPEG-TS reliably)
      // Other videos: try Chromium canvas first, fall back to ffmpeg
      let result = null
      if (ext === 'ts' || ext === 'mts' || ext === 'm2ts') {
        result = await captureVideoFrameFFmpeg(filePath, id)
      } else {
        result = await captureVideoFrame(filePath)
        if (!result) result = await captureVideoFrameFFmpeg(filePath, id)
      }
      if (result && result.imgBuf && result.imgBuf.length > 64) {
        const saved = await saveThumbnailBuffer(id, result.imgBuf)
        imgWidth  = result.imgW
        imgHeight = result.imgH
        hasThumb  = 1
        thumbnailData = saved.thumbUrl
        thumbnailVariants = saved.thumbnailVariants
        console.log('[Bridge] Video thumb: ' + imgWidth + 'x' + imgHeight + ', file=' + saved.tp)
      }
    } catch (e) { console.warn('[Bridge] Video thumb generation failed:', e.message) }
  }

  const importTime = Date.now()
  const asset = {
    id, name, ext, filePath,
    size: stat.size,
    width: imgWidth, height: imgHeight, duration: null,
    mtime: stat.mtimeMs, btime: stat.birthtimeMs,
    importTime,
    tags: sourceTag && (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) ? [sourceTag] : [],
    folders: [], rating: 0,
    notes: '', url: '', colors: [],
    deleted: 0, deletedAt: null, hasThumb,
    aiTagged: 0, aiDescription: '',
    thumbnailData,
    thumbnailVariants,
  }

  try {
    dbRun(
      `INSERT OR IGNORE INTO assets (id,name,ext,filePath,size,width,height,duration,mtime,btime,importTime,rating,notes,url,deleted,deletedAt,hasThumb,aiTagged,aiDescription)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, ext, filePath, stat.size, imgWidth, imgHeight, null,
       stat.mtimeMs, stat.birthtimeMs, importTime,
       0, '', '', 0, null, hasThumb, 0, '']
    )
    if (sourceTag && (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext))) {
      dbRun(`INSERT OR IGNORE INTO tags(tag) VALUES(?)`, [sourceTag])
      dbRun(`INSERT OR IGNORE INTO asset_tags(assetId,tag) VALUES(?,?)`, [id, sourceTag])
    }
    upsertAssetFts(id)
    invalidateAssetQueryCache()
    flushDB()
    console.log('[Bridge] Imported from inbox:', filePath, hasThumb ? '(thumb saved)' : '(no thumb)')

    // Notify renderer if it's open
    if (mainWindow?.webContents) {
      mainWindow.webContents.send('assets:added', [asset])
    }
    if (AI_ORIGINAL_EXTS.has((ext || '').toLowerCase()) || hasThumb) {
      scheduleAiIndexingForNewAssets(1, 'web-grab asset')
    }
    scheduleDinoIndexing('web-grab asset')
    // Rebuild watchers so the inbox dir is watched for future deletions
    setImmediate(rebuildDirWatchers)
  } catch (e) { console.error('[Bridge] Import error:', e) }
}

// ── On startup: sweep inbox for any files saved while app was closed ──────────
async function scanInboxOnStartup() {
  const inboxDir = getInboxDir()
  await scanManagedAssetFolder(inboxDir, 'web-grab')
}

async function scanImportCopyOnStartup() {
  const s = loadSettings()
  if (!s.importCopyPath || !fs.existsSync(s.importCopyPath)) return
  await scanManagedAssetFolder(s.importCopyPath, 'local-library')
}

async function scanManagedAssetFolder(dir, sourceTag) {
  let files = []
  try { files = fs.readdirSync(dir) } catch { return }

  for (const file of files) {
    const full = path.join(dir, file)
    try {
      const st = fs.statSync(full)
      if (!st.isFile()) continue

      // Check DB state before calling processInboxFile to avoid redundant work
      let existingRow = null
      try { existingRow = dbGet('SELECT id, deleted, hasThumb FROM assets WHERE filePath=?', [full]) } catch {}

      // Skip soft-deleted assets (user trashed them — don't re-import)
      if (existingRow && existingRow.deleted === 1) continue

      // Skip already-imported assets that have a valid thumbnail on disk
      // processInboxFile would do nothing for these — avoid the redundant log/work
      if (existingRow && existingRow.hasThumb) {
        const tp = thumbFilePath(existingRow.id)
        if (fs.existsSync(tp)) continue
        // Thumb file missing on disk despite hasThumb=1 — fall through to regenerate
      }

      await processInboxFile(full, sourceTag)
    } catch {}
    await new Promise(r => setImmediate(r))
  }
}

// ── Tray icon ─────────────────────────────────────────────────────────────────
function createTray() {
  if (tray) return
  // Use dedicated tray PNG — pre-sized at 16px so no resize needed (sharper on Windows).
  // Falls back to main icon resized if tray-specific file is missing.
  const trayPng = path.join(__dirname, '../build/tray-icon.png')
  const mainPng = path.join(__dirname, '../public/icon.png')
  let trayIcon
  try {
    const fs2 = require('fs')
    const p = fs2.existsSync(trayPng) ? trayPng : mainPng
    trayIcon = nativeImage.createFromPath(p)
    if (trayIcon.isEmpty()) trayIcon = nativeImage.createEmpty()
    else if (trayIcon.getSize().width !== 16) trayIcon = trayIcon.resize({ width: 16, height: 16 })
  } catch { trayIcon = nativeImage.createEmpty() }

  tray = new Tray(trayIcon)
  tray.setToolTip('Stag — Asset Manager')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Stag', click: () => restoreMainWindow('tray-menu') },
    { type: 'separator' },
    { label: 'Quit Stag', click: () => { forceQuit = true; app.quit() } },
  ]))

  // Single-click → show window
  tray.on('click', () => {
    restoreMainWindow('tray-click')
  })
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  const theme = loadSettings().theme === 'light' ? 'light' : 'dark'
  nativeTheme.themeSource = theme
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    backgroundColor: theme === 'light' ? '#f2f0fb' : '#0a0c10',
    icon: path.join(__dirname, '../public/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: runtimeDependencies.isAiReady() ? ['--stag-runtime-ready=1'] : [],
    },
  })
  if (isDev) mainWindow.loadURL('http://localhost:3000')
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))

  // Intercept close button — hide to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow.hide()
      if (process.platform === 'win32' && tray) {
        try {
          tray.displayBalloon({
            title: 'Stag is running in the background',
            content: 'Right-click the tray icon to quit.',
            noSound: true,
          })
        } catch {}
      }
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function restoreMainWindow(reason = 'restore') {
  if (!gotSingleInstanceLock) return
  if (!app.isReady()) {
    app.whenReady().then(() => restoreMainWindow(reason))
    return
  }

  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  try { mainWindow.moveTop() } catch {}
  mainLog.info({ reason }, 'main window restored')
}

// ── Background thumbnail worker ───────────────────────────────────────────────
// Runs entirely in the main process so it survives renderer close/reload.
// Picks up any hasThumb=0 assets (including ones from a previous interrupted session).
// Supported: jpg/jpeg/png/gif/webp/bmp/ico/avif/tiff/tif/heic + raw formats via buffer
const THUMB_EXTS = new Set([
  'jpg','jpeg','jpe','jfif','png','gif','webp','bmp','ico','avif',
  'tiff','tif','heic','heif','hif','icns','tga','dds','eps',
  'raw','cr2','nef','arw','dng','orf','rw2','svg',
  'pdf','epub',
  'm2ts',
])

// ── Jimp-supported formats (pure JS, no native binary needed) ─────────────────
// jimp 1.x bundles: jpeg, png, gif, tiff, bmp
const JIMP_EXTS = new Set(['jpg','jpeg','png','gif','tiff','tif','bmp','ico'])

// ── Browser-decoded formats (Chromium inside Electron handles these) ───────────
// webp, avif, heic, heif, svg, ico — decoded via hidden offscreen BrowserWindow
const BROWSER_EXTS = new Set(['webp','avif','heic','heif','svg','ico'])

// ── Offscreen BrowserWindow for formats Chromium decodes but jimp can't ────────
let _offscreenWin = null

function getOffscreenWin() {
  if (_offscreenWin && !_offscreenWin.isDestroyed()) return _offscreenWin
  _offscreenWin = new BrowserWindow({
    width: 800, height: 600,
    show: false,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,   // allow file:// URLs
    },
  })
  // Blank page — we only use executeJavaScript
  _offscreenWin.loadURL('data:text/html,<html><body></body></html>')
  _offscreenWin.on('closed', () => { _offscreenWin = null })
  return _offscreenWin
}

// Decode any Chromium-supported image (webp/avif/heic/svg) to WebP via canvas.
// Returns a Buffer of WebP bytes, or null on failure.
async function decodeViaChromium(filePath, ext) {
  return new Promise((resolve) => {
    try {
      const win = getOffscreenWin()
      if (!win || win.isDestroyed()) { resolve(null); return }

      const fileUrl = 'file://' + filePath.replace(/\\/g, '/')
      const maxDim  = THUMB_MAX_DIM
      const timeout = setTimeout(() => resolve(null), 12000)

      win.webContents.executeJavaScript(`
        (function() {
          return new Promise((ok, fail) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              try {
                const maxD = ${maxDim}
                const scale = Math.min(maxD / img.naturalWidth, maxD / img.naturalHeight, 1)
                const w = Math.max(1, Math.round(img.naturalWidth  * scale))
                const h = Math.max(1, Math.round(img.naturalHeight * scale))
                const c = document.createElement('canvas')
                c.width = w; c.height = h
                const ctx = c.getContext('2d')
                ctx.drawImage(img, 0, 0, w, h)
                const dataUrl = c.toDataURL('image/webp', ${THUMB_CANVAS_QUALITY})
                ok({ dataUrl, w: img.naturalWidth, h: img.naturalHeight })
              } catch(e) { fail(e.message) }
            }
            img.onerror = () => fail('img load error')
            img.src = ${JSON.stringify(fileUrl)}
          })
        })()
      `).then(result => {
        clearTimeout(timeout)
        if (!result || !result.dataUrl || !result.dataUrl.startsWith('data:image/webp;base64,')) {
          resolve(null); return
        }
        const b64   = result.dataUrl.split(',')[1]
        const imgBuf = Buffer.from(b64, 'base64')
        resolve({ imgBuf, imgW: result.w, imgH: result.h })
      }).catch(e => {
        clearTimeout(timeout)
        console.warn('[Thumb] decodeViaChromium error:', e)
        resolve(null)
      })
    } catch(e) {
      console.warn('[Thumb] decodeViaChromium setup error:', e.message)
      resolve(null)
    }
  })
}

// Capture a frame from a local video file via the offscreen Chromium window.
// Seeks to ~10% into the video (or 2s, whichever is less) for a representative frame.
// Returns { imgBuf, imgW, imgH } or null.
async function captureVideoFrame(filePath, timeSec = null, maxDim = THUMB_MAX_DIM) {
  return new Promise((resolve) => {
    try {
      const win = getOffscreenWin()
      if (!win || win.isDestroyed()) { resolve(null); return }
      const fileUrl = 'file://' + filePath.replace(/\\/g, '/')
      const timeout = setTimeout(() => { console.warn('[Thumb] video frame capture timed out'); resolve(null) }, 20000)

      win.webContents.executeJavaScript(`
        (function() {
          return new Promise((ok, fail) => {
            const video = document.createElement('video')
            video.crossOrigin = 'anonymous'
            video.muted = true
            video.preload = 'metadata'
            video.src = ${JSON.stringify(fileUrl)}

            video.addEventListener('loadedmetadata', () => {
              const dur = video.duration || 0
              const requested = ${JSON.stringify(timeSec)}
              const fallback = Math.min(dur * 0.1, 2)
              const target = Number.isFinite(requested) ? requested : fallback
              video.currentTime = Math.max(0, Math.min(target, Math.max(0, dur - 0.05)))
            })

            video.addEventListener('seeked', () => {
              try {
                const vw = video.videoWidth  || 0
                const vh = video.videoHeight || 0
                if (!vw || !vh) { fail('zero dimensions'); return }
                const maxD  = ${maxDim}
                const scale = Math.min(maxD / vw, maxD / vh, 1)
                const w = Math.max(1, Math.round(vw * scale))
                const h = Math.max(1, Math.round(vh * scale))
                const c = document.createElement('canvas')
                c.width = w; c.height = h
                c.getContext('2d').drawImage(video, 0, 0, w, h)
                const dataUrl = c.toDataURL('image/webp', ${THUMB_CANVAS_QUALITY})
                video.src = ''
                ok({ dataUrl, vw, vh })
              } catch(e) { fail(e.message) }
            }, { once: true })

            video.addEventListener('error', () => fail('video load error'))
          })
        })()
      `).then(result => {
        clearTimeout(timeout)
        if (!result?.dataUrl?.startsWith('data:image/webp;base64,')) { resolve(null); return }
        const imgBuf = Buffer.from(result.dataUrl.split(',')[1], 'base64')
        resolve({ imgBuf, imgW: result.vw, imgH: result.vh })
      }).catch(e => {
        clearTimeout(timeout)
        console.warn('[Thumb] captureVideoFrame error:', e)
        resolve(null)
      })
    } catch(e) {
      console.warn('[Thumb] captureVideoFrame setup error:', e.message)
      resolve(null)
    }
  })
}

// Convert any image buffer (JPEG, PNG, etc.) to WebP via the Chromium offscreen canvas.
// Returns a Buffer of WebP bytes, or null on failure.
async function bufToWebP(imgBuf, mimeHint = 'image/jpeg') {
  return new Promise((resolve) => {
    try {
      const win = getOffscreenWin()
      if (!win || win.isDestroyed()) { resolve(null); return }
      const b64     = imgBuf.toString('base64')
      const dataUrl = `data:${mimeHint};base64,${b64}`
      const timeout = setTimeout(() => resolve(null), 10000)
      win.webContents.executeJavaScript(
        `(function(src){return new Promise((ok,fail)=>{const img=new Image();img.onload=()=>{try{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);ok(c.toDataURL('image/webp',${THUMB_CANVAS_QUALITY}))}catch(e){fail(e.message)}};img.onerror=()=>fail('onerror');img.src=src})})(${JSON.stringify(dataUrl)})`
      ).then(result => {
        clearTimeout(timeout)
        if (!result || !result.startsWith('data:image/webp;base64,')) { resolve(null); return }
        resolve(Buffer.from(result.split(',')[1], 'base64'))
      }).catch(() => { clearTimeout(timeout); resolve(null) })
    } catch { resolve(null) }
  })
}

// ── Video thumbnail via ffmpeg (ffmpeg-static) ───────────────────────────────
// Used for .ts and as fallback for any video the Chromium canvas can't seek.
// Mirrors the logic in ts-preview/thumbnail.js.
function resolvePackagedExecutablePath(p) {
  if (!p) return null
  const unpacked = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  return unpacked !== p && fs.existsSync(unpacked) ? unpacked : p
}

let _ffmpegPath = null
let _ffprobePath = null
let _magickPath = null
let _ghostscriptPath = null
function refreshManagedToolPaths() {
  const managed = runtimeDependencies.getPaths()
  _ffmpegPath = fs.existsSync(managed.ffmpeg) ? managed.ffmpeg : null
  _ffprobePath = fs.existsSync(managed.ffprobe) ? managed.ffprobe : null
  _magickPath = managed.magick && fs.existsSync(managed.magick) ? managed.magick : null
  _ghostscriptPath = managed.ghostscript && fs.existsSync(managed.ghostscript) ? managed.ghostscript : null
  if (!app.isPackaged) {
    if (!_ffmpegPath) {
      try { _ffmpegPath = resolvePackagedExecutablePath(require('ffmpeg-static')) } catch {}
    }
    if (!_ffprobePath) {
      try { _ffprobePath = resolvePackagedExecutablePath(require('ffprobe-static').path) } catch {}
    }
  }
}
refreshManagedToolPaths()

function managedToolEnvironment() {
  return runtimeToolEnvironment(runtimeDependencies.getPaths())
}

function resolveToolCommand(managedPath, developmentCommand) {
  if (managedPath) return managedPath
  return app.isPackaged ? null : developmentCommand
}

function _ffprobeGetDuration(filePath) {
  return new Promise(resolve => {
    if (!_ffprobePath) return resolve(null)
    const { execFile } = require('child_process')
    execFile(_ffprobePath, [
      '-v','error','-show_entries','format=duration',
      '-of','default=noprint_wrappers=1:nokey=1', filePath,
    ], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const d = parseFloat(stdout.trim())
      resolve(Number.isFinite(d) ? d : null)
    })
  })
}

function _ffmpegPickTime(dur) {
  if (!dur || dur <= 0) return 1
  if (dur < 5)  return 1
  if (dur < 30) return 3
  return Math.min(Math.max(dur * 0.1, 5), 30)
}

async function captureVideoFrameFFmpeg(filePath, id, timeSec = null, maxDim = 600) {
  if (!_ffmpegPath) { console.warn('[VideoThumb] ffmpeg-static not found'); return null }
  const os   = require('os')
  const { spawn } = require('child_process')
  const tmp  = path.join(os.tmpdir(), `stag_vthumb_${id}.jpg`)
  const dur  = await _ffprobeGetDuration(filePath)
  const seek = Number.isFinite(timeSec)
    ? Math.max(0, Math.min(timeSec, dur ? Math.max(0, dur - 0.05) : timeSec))
    : _ffmpegPickTime(dur)
  const scale = Math.max(96, Math.min(900, Math.round(maxDim)))

  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(_ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-300))))
  })

  const fastArgs = [
    '-y','-hide_banner','-loglevel','error',
    '-ss', String(seek), '-i', filePath,
    '-frames:v','1', '-vf',`scale=${scale}:-2`, '-q:v','3', tmp,
  ]
  try {
    await run(fastArgs)
  } catch (fastErr) {
    console.warn('[VideoThumb] fast seek failed, trying accurate seek:', fastErr.message)
    const accurateArgs = [
      '-y','-hide_banner','-loglevel','error',
      '-i', filePath, '-ss', String(seek),
      '-frames:v','1', '-vf',`scale=${scale}:-2`, '-q:v','3', tmp,
    ]
    try { await run(accurateArgs) } catch (e) { console.error('[VideoThumb] accurate seek failed:', e.message); return null }
  }

  try {
    if (!fs.existsSync(tmp)) { console.warn('[VideoThumb] tmp file not found:', tmp); return null }
    const jpgBuf = fs.readFileSync(tmp)
    fs.unlinkSync(tmp)
    if (!jpgBuf || jpgBuf.length < 64) { console.warn('[VideoThumb] tmp file too small'); return null }

    let imgW = 0, imgH = 0, webpBuf = null

    if (getSharp()) {
      // Use sharp directly — no offscreen window needed, more reliable
      const meta = await _sharp(jpgBuf).metadata()
      imgW = meta.width || 0
      imgH = meta.height || 0
      webpBuf = await _sharp(jpgBuf).webp(THUMB_WEBP_OPTIONS).toBuffer()
    } else {
      // Fallback: nativeImage for dims, then convert via Chromium canvas
      const ni = nativeImage.createFromBuffer(jpgBuf)
      if (!ni.isEmpty()) { const sz = ni.getSize(); imgW = sz.width; imgH = sz.height }
      webpBuf = await bufToWebP(jpgBuf, 'image/jpeg')
    }

    if (!webpBuf || webpBuf.length < 64) { console.warn('[VideoThumb] WebP conversion failed'); return null }
    console.log(`[VideoThumb] ffmpeg thumb: ${imgW}x${imgH}, ${webpBuf.length}B`)
    return { imgBuf: webpBuf, imgW, imgH }
  } catch (e) { console.error('[VideoThumb] post-process error:', e.message); return null }
}

async function hasPdfSignature(filePath) {
  let handle = null
  try {
    handle = await fs.promises.open(filePath, 'r')
    const head = Buffer.alloc(1024)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return head.subarray(0, bytesRead).includes(Buffer.from('%PDF-'))
  } catch {
    return false
  } finally {
    try { await handle?.close() } catch {}
  }
}

function getPopplerRuntimeRoot() {
  const platformArch = `${process.platform}-${process.arch}`
  const candidates = [
    path.join(process.resourcesPath || '', 'poppler'),
    path.join(app.getAppPath(), 'resources', 'poppler', platformArch),
    path.join(__dirname, '..', 'resources', 'poppler', platformArch),
  ]
  return candidates.find(candidate => {
    const executable = process.platform === 'win32'
      ? path.join(candidate, 'Library', 'bin', 'pdftocairo.exe')
      : path.join(candidate, 'bin', 'pdftocairo')
    return fs.existsSync(executable)
  }) || null
}

function getPopplerExecutable(root) {
  return process.platform === 'win32'
    ? path.join(root, 'Library', 'bin', 'pdftocairo.exe')
    : path.join(root, 'bin', 'pdftocairo')
}

function getPopplerEnvironment(root) {
  const binDir = process.platform === 'win32'
    ? path.join(root, 'Library', 'bin')
    : path.join(root, 'bin')
  const libDir = process.platform === 'win32'
    ? path.join(root, 'Library', 'lib')
    : path.join(root, 'lib')
  const shareDir = process.platform === 'win32'
    ? path.join(root, 'Library', 'share')
    : path.join(root, 'share')
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    DYLD_LIBRARY_PATH: process.platform === 'darwin'
      ? `${libDir}${path.delimiter}${process.env.DYLD_LIBRARY_PATH || ''}`
      : process.env.DYLD_LIBRARY_PATH,
    FONTCONFIG_PATH: process.platform === 'win32'
      ? path.join(root, 'Library', 'etc', 'fonts')
      : path.join(root, 'etc', 'fonts'),
    FONTCONFIG_FILE: 'fonts.conf',
    XDG_DATA_DIRS: `${shareDir}${path.delimiter}${process.env.XDG_DATA_DIRS || ''}`,
  }
}

// ── PDF thumbnail generation ─────────────────────────────────────────────────
// Uses a complete, architecture-specific Poppler runtime on every platform.
async function renderPdfThumb(filePath) {
  if (!(await hasPdfSignature(filePath))) {
    console.warn('[Thumb] PDF signature missing; skipping invalid or mislabeled file:', filePath)
    return null
  }

  const os   = require('os')
  const { execFile } = require('child_process')
  const popplerRoot = getPopplerRuntimeRoot()
  if (!popplerRoot) {
    console.warn(`[Thumb] Packaged Poppler runtime missing for ${process.platform}-${process.arch}`)
    return null
  }

  // Create a unique temp dir so concurrent conversions don't collide
  let tmpDir = null
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stag-pdf-'))

    const executable = getPopplerExecutable(popplerRoot)
    const runPoppler = () => new Promise((resolve, reject) => {
      execFile(executable, [
        '-png',
        '-f', '1',
        '-l', '1',
        '-scale-to', String(THUMB_FULL_WIDTH),
        filePath,
        path.join(tmpDir, 'p'),
      ], {
        windowsHide: true,
        timeout: 45000,
        env: getPopplerEnvironment(popplerRoot),
      }, (error) => error ? reject(error) : resolve())
    })
    try {
      await runPoppler()
    } catch (firstError) {
      console.warn('[Thumb] Poppler first attempt failed; retrying:', firstError.message)
      await new Promise(resolve => setTimeout(resolve, 250))
      await runPoppler()
    }

    // pdftocairo names output files: <prefix>-<N>.png where N is zero-padded
    // to the width of the total page count. For single-page requests it is
    // always "p-1.png" but some builds emit "p-01.png".  Glob for any .png.
    const pngFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort()                  // lexical sort puts p-1 before p-2

    if (!pngFiles.length) {
      console.warn('[Thumb] Poppler produced no PNG output in', tmpDir)
      return null
    }

    const pngPath = path.join(tmpDir, pngFiles[0])
    const pngBuf  = fs.readFileSync(pngPath)

    const { Jimp, JimpMime } = require('jimp')
    const img  = await Jimp.read(pngBuf)
    const imgW = img.width
    const imgH = img.height
    if (!imgW || !imgH) return null

    const scale = Math.min(THUMB_MAX_DIM / imgW, THUMB_MAX_DIM / imgH, 1)
    img.resize({ w: Math.max(1, Math.round(imgW * scale)), h: Math.max(1, Math.round(imgH * scale)) })
    const interimBuf = await img.getBuffer(JimpMime.png)
    if (!interimBuf || interimBuf.length < 64) return null

    const imgBuf = await bufToWebP(interimBuf, 'image/png') || interimBuf
    console.log(`[Thumb] poppler: ${imgW}x${imgH}, ${imgBuf.length}B`)
    return { imgBuf, imgW, imgH }

  } catch (e) {
    console.warn('[Thumb] Poppler error:', e.message)
    return null
  } finally {
    // Always clean up temp dir
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  }
}
// ── EPUB thumbnail — cover image extraction ──────────────────────────────────
// Read only container.xml and the OPF package metadata. Avoid full book/TOC
// parsing because malformed navigation documents must not block thumbnails.
async function renderEpubThumb(filePath) {
  try {
    const AdmZip = require('adm-zip')
    const { parseStringPromise } = require('xml2js')
    const zip = new AdmZip(filePath)
    const entries = zip.getEntries()
    const entryMap = new Map(entries.map(entry => [
      path.posix.normalize(entry.entryName).toLowerCase(),
      entry,
    ]))
    const getEntry = entryPath => entryMap.get(
      path.posix.normalize(decodeURIComponent(String(entryPath || '').replace(/^\/+/, ''))).toLowerCase()
    )
    const parseXmlEntry = async entryPath => {
      const entry = getEntry(entryPath)
      if (!entry || entry.isDirectory) return null
      return parseStringPromise(entry.getData().toString('utf8'), {
        explicitArray: false,
        mergeAttrs: true,
        trim: true,
      })
    }

    const container = await parseXmlEntry('META-INF/container.xml')
    const rootfiles = container?.container?.rootfiles?.rootfile
    const rootfile = (Array.isArray(rootfiles) ? rootfiles : [rootfiles])
      .find(item => item?.['full-path'])
    const opfPath = rootfile?.['full-path']
    if (!opfPath) return null

    const packageDoc = await parseXmlEntry(opfPath)
    const packageRoot = packageDoc?.package
    const manifestItemsRaw = packageRoot?.manifest?.item
    const manifestItems = (Array.isArray(manifestItemsRaw) ? manifestItemsRaw : [manifestItemsRaw])
      .filter(Boolean)
    const imageItems = manifestItems.filter(item =>
      String(item['media-type'] || item.mediaType || '').toLowerCase().startsWith('image/')
    )
    if (!imageItems.length) return null

    const metadataRaw = packageRoot?.metadata?.meta
    const metadata = (Array.isArray(metadataRaw) ? metadataRaw : [metadataRaw]).filter(Boolean)
    const declaredCover = metadata.find(item =>
      String(item.name || item.property || '').toLowerCase() === 'cover'
    )
    const declaredCoverRef = String(
      declaredCover?.content || declaredCover?.['#text'] || ''
    ).trim()

    let coverItem = null
    if (declaredCoverRef) {
      coverItem = imageItems.find(item => item.id === declaredCoverRef)
        || imageItems.find(item => {
          const href = String(item.href || '')
          return href === declaredCoverRef
            || path.posix.normalize(href).toLowerCase() === path.posix.normalize(declaredCoverRef).toLowerCase()
        })
    }
    if (!coverItem) {
      coverItem = imageItems.find(item =>
        String(item.properties || '').toLowerCase().split(/\s+/).includes('cover-image')
      )
    }
    if (!coverItem) {
      coverItem = imageItems.find(item =>
        /cover/i.test(String(item.id || '')) || /cover/i.test(String(item.href || ''))
      )
    }
    coverItem ||= imageItems[0]

    const opfDir = path.posix.dirname(path.posix.normalize(opfPath))
    const coverPath = path.posix.join(opfDir === '.' ? '' : opfDir, String(coverItem.href || '').split('#')[0])
    const coverEntry = getEntry(coverPath)
    if (!coverEntry || coverEntry.isDirectory) return null

    const coverBuf = coverEntry.getData()
    const mimeType = String(coverItem['media-type'] || coverItem.mediaType || 'image/jpeg')
    if (!coverBuf || coverBuf.length < 64) return null

    if (getSharp()) {
      try {
        const meta = await _sharp(coverBuf).metadata()
        const imgW = meta.width || 0
        const imgH = meta.height || 0
        if (imgW > 0 && imgH > 0) {
          const imgBuf = await _sharp(coverBuf)
            .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
            .webp(THUMB_WEBP_OPTIONS)
            .toBuffer()
          if (imgBuf && imgBuf.length > 64) return { imgBuf, imgW, imgH }
        }
      } catch (e) {
        console.warn('[Thumb] EPUB Sharp decode failed; trying Chromium:', e.message)
      }
    }

    const win = getOffscreenWin()
    if (!win || win.isDestroyed()) return null
    const b64src = `data:${mimeType};base64,${coverBuf.toString('base64')}`
    const result = await Promise.race([
      win.webContents.executeJavaScript(`
        (function() {
          return new Promise((ok, fail) => {
            const img = new Image()
            img.onload = () => {
              try {
                const maxD = ${THUMB_MAX_DIM}
                const scale = Math.min(maxD / img.naturalWidth, maxD / img.naturalHeight, 1)
                const w = Math.max(1, Math.round(img.naturalWidth * scale))
                const h = Math.max(1, Math.round(img.naturalHeight * scale))
                const c = document.createElement('canvas')
                c.width = w; c.height = h
                c.getContext('2d').drawImage(img, 0, 0, w, h)
                ok({ dataUrl: c.toDataURL('image/webp', ${THUMB_CANVAS_QUALITY}), w: img.naturalWidth, h: img.naturalHeight })
              } catch(e) { fail(e.message) }
            }
            img.onerror = () => fail('load error')
            img.src = ${JSON.stringify(b64src)}
          })
        })()
      `),
      new Promise(resolve => setTimeout(() => resolve(null), 10000)),
    ]).catch(() => null)
    if (!result?.dataUrl) return null
    const b64 = result.dataUrl.split(',')[1]
    return b64 ? { imgBuf: Buffer.from(b64, 'base64'), imgW: result.w, imgH: result.h } : null
  } catch (e) {
    console.warn('[Thumb] EPUB cover extraction failed:', e.message)
    return null
  }
}

// ── Main thumbnail generator ──────────────────────────────────────────────────
// Track 1: jimp (pure JS) — jpg/png/gif/tiff/bmp.  Works on all platforms,
//          handles small dimensions (like 450×788) perfectly.
// Track 2: Chromium canvas — webp/avif/heic/heif/svg.  Uses the hidden
//          offscreen BrowserWindow to let Chromium decode the image, then
//          captures it via canvas.
// Track 3: nativeImage fallback — last resort for anything else.
async function generateThumbForFile(filePath, ext, id, saveOptions = {}) {
  try {
    // Only read the full file buffer for image tracks (1/2/3).
    // pdf and epub handle their own file I/O inside renderPdfThumb/renderEpubThumb.
    const needsBuf = JIMP_EXTS.has(ext) || BROWSER_EXTS.has(ext)
    const buf = needsBuf ? await fs.promises.readFile(filePath).catch(() => null) : Buffer.alloc(0)
    if (needsBuf && (!buf || buf.length < 8)) return null

    let imgBuf = null  // will hold final WebP bytes
    let imgW = 0, imgH = 0

    // ── Track 0a: native ICO decoder ────────────────────────────────────────
    // Electron can preview .ico files even when generic image libraries reject
    // multi-resolution icon containers, so use that decoder first.
    if (!imgBuf && ext === 'ico') {
      try {
        const img = nativeImage.createFromPath(filePath)
        if (!img.isEmpty()) {
          const sz = img.getSize()
          imgW = sz.width
          imgH = sz.height
          const scale = Math.min(THUMB_MAX_DIM / imgW, THUMB_MAX_DIM / imgH, 1)
          const outW = Math.max(1, Math.round(imgW * scale))
          const outH = Math.max(1, Math.round(imgH * scale))
          const pngBuf = img.resize({ width: outW, height: outH, quality: 'best' }).toPNG()
          imgBuf = await bufToWebP(pngBuf, 'image/png')
          if (imgBuf && imgBuf.length > 64) {
            console.log(`[Thumb] nativeImage ico: ${imgW}x${imgH}, ${imgBuf.length}B`)
          } else {
            imgBuf = null
          }
        }
      } catch (e) {
        console.warn('[Thumb] nativeImage ico failed:', e.message)
        imgBuf = null
      }
    }

    // ── Track 0: sharp — fast, multi-threaded, handles most raster formats ────
    // Covers jpg/png/gif/webp/avif/heif/heic/tiff/bmp. Falls through on failure.
    const _sharpSkip = new Set(['svg', 'pdf', 'epub', 'raw', 'cr2', 'nef', 'arw', 'dng', 'orf', 'rw2'])
    if (getSharp() && !_sharpSkip.has(ext)) {
      try {
        const meta = await _sharp(filePath).metadata()
        const swapsAxes = meta.orientation != null && meta.orientation >= 5 && meta.orientation <= 8
        imgW = (swapsAxes ? meta.height : meta.width) || 0
        imgH = (swapsAxes ? meta.width : meta.height) || 0
        if (imgW > 0 && imgH > 0) {
          imgBuf = await _sharp(filePath)
            .rotate()
            .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
            .webp(THUMB_WEBP_OPTIONS)
            .toBuffer()
          if (!imgBuf || imgBuf.length < 64) imgBuf = null
          else console.log(`[Thumb] sharp: ${ext} ${imgW}x${imgH}, ${imgBuf.length}B`)
        }
      } catch (e) {
        console.warn(`[Thumb] sharp failed for ${ext}:`, e.message)
        imgBuf = null
      }
    }

    // ── Track 1: jimp (jpg/png/gif/tiff/bmp) ─────────────────────────────────
    if (!imgBuf && JIMP_EXTS.has(ext)) {
      try {
        const { Jimp, JimpMime } = require('jimp')
        const img = await Jimp.read(buf)
        imgW = img.width
        imgH = img.height
        if (!imgW || !imgH) throw new Error('zero dimensions')

        // Scale so longest side fits the thumbnail source size; never upscale
        const scale = Math.min(THUMB_MAX_DIM / imgW, THUMB_MAX_DIM / imgH, 1)
        const outW  = Math.max(1, Math.round(imgW * scale))
        const outH  = Math.max(1, Math.round(imgH * scale))
        img.resize({ w: outW, h: outH })
        const pngBuf = await img.getBuffer(JimpMime.png)  // PNG preserves alpha
        imgBuf = await bufToWebP(pngBuf, 'image/png')
        if (imgBuf && imgBuf.length > 64) {
          console.log(`[Thumb] jimp+webp: ${ext} ${imgW}x${imgH} -> ${outW}x${outH}, ${imgBuf.length}B`)
        } else {
          imgBuf = null
        }
      } catch (e) {
        console.warn(`[Thumb] jimp failed for ${ext}:`, e.message)
        imgBuf = null
      }
    }

    // ── Track 2: Chromium canvas (webp/avif/heic/svg) ────────────────────────
    if (!imgBuf && (BROWSER_EXTS.has(ext))) {
      try {
        const result = await decodeViaChromium(filePath, ext)
        if (result) {
          imgBuf = result.imgBuf
          imgW   = result.imgW
          imgH   = result.imgH
          console.log(`[Thumb] chromium: ${ext} ${imgW}x${imgH}, ${imgBuf.length}B`)
        }
      } catch (e) {
        console.warn(`[Thumb] chromium failed for ${ext}:`, e.message)
      }
    }

    // ── Track 2a: heic-convert for HEIC/HEIF/HIF ─────────────────────────────
    // sharp's built-in HEIF support requires libheif with HEVC decode codec,
    // which is not always present. heic-convert is a pure-JS fallback.
    if (!imgBuf && (ext === 'heic' || ext === 'heif' || ext === 'hif')) {
      try {
        const convertHeic = require('heic-convert')
        const fileBuf = await fs.promises.readFile(filePath)
        const pngBuf = await convertHeic({ buffer: fileBuf, format: 'PNG', quality: 1 })
        const pngBuffer = Buffer.from(pngBuf)
        if (getSharp()) {
          const meta = await _sharp(pngBuffer).metadata()
          imgW = meta.width || 0
          imgH = meta.height || 0
          imgBuf = await _sharp(pngBuffer)
            .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
            .webp(THUMB_WEBP_OPTIONS)
            .toBuffer()
          if (!imgBuf || imgBuf.length < 64) imgBuf = null
          else console.log(`[Thumb] heic-convert: ${ext} ${imgW}x${imgH}, ${imgBuf.length}B`)
        } else {
          imgBuf = await bufToWebP(pngBuffer, 'image/png')
        }
      } catch (e) {
        console.warn(`[Thumb] heic-convert failed for ${ext}:`, e.message)
        imgBuf = null
      }
    }

    // ── Track 2b: @fiahfy/icns for ICNS ──────────────────────────────────────
    // Parses the ICNS container and picks the largest embedded image.
    if (!imgBuf && ext === 'icns') {
      try {
        const { Icns } = require('@fiahfy/icns')
        const fileBuf = await fs.promises.readFile(filePath)
        const icns = Icns.from(fileBuf)
        const images = icns.images
          .map(i => Buffer.from(i.image))
          .sort((a, b) => b.length - a.length)
        for (const embeddedBuf of images) {
          try {
          if (!getSharp()) break
            const meta = await _sharp(embeddedBuf).metadata()
            imgW = meta.width || 0
            imgH = meta.height || 0
            if (imgW > 0 && imgH > 0) {
              imgBuf = await _sharp(embeddedBuf)
                .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
                .webp(THUMB_WEBP_OPTIONS)
                .toBuffer()
              if (imgBuf && imgBuf.length > 64) {
                console.log(`[Thumb] icns+sharp: ${imgW}x${imgH}, ${imgBuf.length}B`)
                break
              }
              imgBuf = null
            }
          } catch {}
        }
      } catch (e) {
        console.warn(`[Thumb] @fiahfy/icns failed:`, e.message)
        imgBuf = null
      }
    }

    // ── Track 2c: ImageMagick CLI for TGA/DDS/EPS, then ffmpeg fallback ───────
    if (!imgBuf && (ext === 'tga' || ext === 'dds' || ext === 'eps')) {
      try {
        const { spawn: _spawn } = require('child_process')
        const magickCommand = resolveToolCommand(_magickPath, 'magick')
        if (!magickCommand) throw new Error('Managed ImageMagick runtime is unavailable')
        const magickBuf = await new Promise((resolve, reject) => {
          const child = _spawn(magickCommand, [
            `${filePath}[0]`, '-auto-orient', '-thumbnail', `${THUMB_MAX_DIM}x${THUMB_MAX_DIM}>`,
            '-background', 'white', '-flatten', '-quality', String(THUMB_WEBP_QUALITY), 'webp:-',
          ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: managedToolEnvironment(),
          })
          const chunks = []
          child.stdout.on('data', d => chunks.push(d))
          child.on('error', reject)
          child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`magick exit ${code}`)))
        })
        if (magickBuf && magickBuf.length > 64) {
          if (getSharp()) {
            const meta = await _sharp(magickBuf).metadata()
            imgW = meta.width || 0
            imgH = meta.height || 0
          }
          imgBuf = magickBuf
          console.log(`[Thumb] imagemagick: ${ext} ${imgW}x${imgH}, ${imgBuf.length}B`)
        }
      } catch (e) {
        console.warn(`[Thumb] imagemagick failed for ${ext}:`, e.message)
        // ffmpeg fallback
        if (_ffmpegPath) {
          try {
            const { spawn: _spawn2 } = require('child_process')
            const ffBuf = await new Promise((resolve, reject) => {
              const child = _spawn2(_ffmpegPath, [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-i', filePath, '-frames:v', '1',
                '-vf', `scale=${THUMB_MAX_DIM}:${THUMB_MAX_DIM}:force_original_aspect_ratio=decrease`,
                '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1',
              ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
              const chunks = []
              child.stdout.on('data', d => chunks.push(d))
              child.on('error', reject)
              child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exit ${code}`)))
            })
            if (ffBuf && ffBuf.length > 64) {
              if (getSharp()) {
                const meta = await _sharp(ffBuf).metadata()
                imgW = meta.width || 0
                imgH = meta.height || 0
                imgBuf = await _sharp(ffBuf).webp(THUMB_WEBP_OPTIONS).toBuffer()
              } else {
                imgBuf = await bufToWebP(ffBuf, 'image/jpeg')
              }
              if (imgBuf && imgBuf.length > 64) console.log(`[Thumb] ffmpeg-image: ${ext} ${imgW}x${imgH}, ${imgBuf.length}B`)
              else imgBuf = null
            }
          } catch (e2) {
            console.warn(`[Thumb] ffmpeg fallback failed for ${ext}:`, e2.message)
          }
        }
      }
    }

    // ── Track 3: nativeImage fallback ─────────────────────────────────────────
    // Last resort — works well for jpg/png on all platforms. May fail for
    // gif/tiff/webp on Windows but we already tried jimp/chromium above.
    // Skip for pdf/epub — nativeImage cannot decode them.
    if (!imgBuf && ext !== 'pdf' && ext !== 'epub') {
      try {
        const img = nativeImage.createFromPath(filePath)
        if (!img.isEmpty()) {
          const sz = img.getSize()
          imgW = sz.width; imgH = sz.height
          if (imgW > 0 && imgH > 0) {
            const scale = Math.min(THUMB_MAX_DIM / imgW, THUMB_MAX_DIM / imgH, 1)
            const outW  = Math.max(1, Math.round(imgW * scale))
            const outH  = Math.max(1, Math.round(imgH * scale))
            const resized = img.resize({ width: outW, height: outH, quality: 'good' })
            const pngBuf  = resized.toPNG()
            imgBuf = await bufToWebP(pngBuf, 'image/png')
            if (imgBuf && imgBuf.length > 64) {
              console.log(`[Thumb] nativeImage fallback: ${ext} ${imgW}x${imgH}, ${imgBuf.length}B`)
            } else {
              imgBuf = null
            }
          }
        }
      } catch (e) {
        console.warn(`[Thumb] nativeImage fallback failed for ${ext}:`, e.message)
      }
    }

    // ── Track 4: PDF — first page via packaged Poppler ───────────────────────
    if (!imgBuf && ext === 'pdf') {
      try {
        const result = await renderPdfThumb(filePath)
        if (result) {
          imgBuf = result.imgBuf
          imgW   = result.imgW
          imgH   = result.imgH
          console.log(`[Thumb] Poppler result: ${imgW}x${imgH}, ${imgBuf.length}B`)
        }
      } catch (e) {
        console.warn('[Thumb] Poppler failed:', e.message)
        imgBuf = null
      }
    }

    // ── Track 5: EPUB — cover image from package metadata ────────────────────
    if (!imgBuf && ext === 'epub') {
      try {
        const result = await renderEpubThumb(filePath)
        if (result) {
          imgBuf = result.imgBuf
          imgW   = result.imgW
          imgH   = result.imgH
          console.log(`[Thumb] EPUB cover: ${imgW}x${imgH}, ${imgBuf.length}B`)
        }
      } catch (e) {
        console.warn('[Thumb] EPUB cover extraction failed:', e.message)
        imgBuf = null
      }
    }

    if (!imgBuf || imgBuf.length < 64) return null

    const saved = await saveThumbnailBuffer(id, imgBuf, saveOptions)
    return { ...saved, imgW, imgH }
  } catch (e) {
    console.warn('[Thumb] generateThumbForFile error:', e.message)
    return null
  }
}

async function runThumbWorker() {
  if (_thumbWorkerRunning || !_db) return
  if (app.isPackaged && !runtimeDependencies.isCoreReady()) {
    thumbLog('worker:deferred:runtime-not-ready')
    return
  }
  _thumbWorkerRunning = true
  let thumbWorkerTotal = 0
  let thumbWorkerDone = 0
  try {
    const countRows = dbAll(`SELECT COUNT(*) AS count FROM assets WHERE hasThumb=0 AND deleted=0`, [])
    thumbWorkerTotal = Number(countRows?.[0]?.count || 0)
  } catch {}
  thumbLog('worker:start')
  emitThumbProgress({ type: 'worker', current: 0, total: thumbWorkerTotal })

  try {
    while (true) {
      if (!_db) break

      // Fetch a small batch to avoid holding a giant array in memory
      let rows = []
      try {
        rows = dbAll(
          `SELECT id, filePath, ext FROM assets WHERE hasThumb=0 AND deleted=0 ORDER BY importTime DESC LIMIT 20`,
          []
        )
      } catch { break }

      if (rows.length === 0) break  // all done
      thumbLog('worker:batch', { count: rows.length })

      for (const row of rows) {
        if (!_db) break
        const { id, filePath, ext } = row
        const itemStarted = Date.now()
        const name = path.basename(filePath || '')
        let thumbItemFinished = false
        const finishThumbItem = () => {
          if (thumbItemFinished) return
          thumbItemFinished = true
          thumbWorkerDone += 1
          emitThumbProgress({ type: 'worker', current: thumbWorkerDone, total: thumbWorkerTotal || thumbWorkerDone, file: name })
        }
        emitThumbProgress({ type: 'worker', current: thumbWorkerDone, total: thumbWorkerTotal || rows.length, file: name })

        try {
          // Skip unsupported types
          if (!THUMB_EXTS.has(ext)) {
            thumbLog('worker:item:skip:unsupported', { id, name, ext })
            dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
            finishThumbItem()
            continue
          }

          const stat = await fs.promises.stat(filePath).catch(() => null)
          if (!stat) {
            thumbLog('worker:item:skip:missing', { id, name })
            dbRun('UPDATE assets SET deleted=1, deletedAt=?, hasThumb=0 WHERE id=?', [Date.now(), id])
            flushDB()
            if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.send('assets:removed', [id])
            }
            finishThumbItem()
            continue
          }
          if (stat.size > 60 * 1024 * 1024 && ext !== 'pdf' && ext !== 'epub') {
            // PDF page rendering and EPUB cover extraction do not decode the whole
            // document into memory, so large documents are safe to attempt.
            thumbLog('worker:item:skip:too-large', { id, name, size: stat.size })
            dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
            finishThumbItem()
            continue
          }

          // Video formats — use ffmpeg frame capture instead of image decoder
          if (VIDEO_EXTS.has(ext)) {
            thumbLog('worker:item:start', { id, name, ext, route: 'video' })
            const vResult = await captureVideoFrameFFmpeg(filePath, id)
            if (!vResult || !vResult.imgBuf || vResult.imgBuf.length < 64) {
              thumbLog('worker:item:video-frame-empty', { id, name, ms: Date.now() - itemStarted })
              dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
              continue
            }
            const saved = await saveThumbnailBuffer(id, vResult.imgBuf)
            dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [vResult.imgW, vResult.imgH, id])
            flushDB()
            scheduleAiIndexingForThumbnailAsset(id, 'background video thumbnail')
            if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.send('thumb:done', { id, thumbUrl: saved.thumbUrl, thumbnailVariants: saved.thumbnailVariants, width: vResult.imgW, height: vResult.imgH })
            }
            thumbLog('worker:item:done', { id, name, ext, ms: Date.now() - itemStarted, width: vResult.imgW, height: vResult.imgH })
            finishThumbItem()
            continue
          }

          thumbLog('worker:item:start', { id, name, ext, route: 'image' })
          const result = await generateThumbForFile(filePath, ext, id)
          if (!result) {
            thumbLog('worker:item:empty', { id, name, ext, ms: Date.now() - itemStarted })
            dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
            finishThumbItem()
            continue
          }

          const { thumbUrl, thumbnailVariants, imgW, imgH } = result
          dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [imgW, imgH, id])
          flushDB()
          scheduleAiIndexingForThumbnailAsset(id, 'background thumbnail')

          if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('thumb:done', { id, thumbUrl, thumbnailVariants, width: imgW, height: imgH })
          }
          thumbLog('worker:item:done', { id, name, ext, ms: Date.now() - itemStarted, width: imgW, height: imgH })
          finishThumbItem()
        } catch (e) {
          console.warn('[Thumb] Failed for', filePath, e.message)
          try { dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id]) } catch {}
          finishThumbItem()
        }

        await new Promise(r => setImmediate(r))
      }

      await new Promise(r => setTimeout(r, 60))
    }
  } finally {
    _thumbWorkerRunning = false
    thumbLog('worker:done')
    emitThumbProgress({ type: 'done', current: thumbWorkerDone, total: thumbWorkerTotal || thumbWorkerDone })
  }
}

async function runThumbQualityRefresh() {
  if (!_db || !_thumbQualityRefreshRows.length) return
  const doneFlag = path.join(getDataDir(), '.thumb_quality_v6')
  if (fs.existsSync(doneFlag)) {
    _thumbQualityRefreshRows = []
    return
  }

  const rows = _thumbQualityRefreshRows
  _thumbQualityRefreshRows = []
  let done = 0
  thumbLog('quality-refresh:start', { total: rows.length, quality: THUMB_WEBP_QUALITY, maxDim: THUMB_MAX_DIM })
  try {
    for (const row of rows) {
      if (!_db) break
      const { id, filePath, ext } = row
      const itemStarted = Date.now()
      const name = path.basename(filePath || '')
      try {
        if (!THUMB_EXTS.has(ext)) continue
        const stat = await fs.promises.stat(filePath).catch(() => null)
        if (!stat || stat.size > 60 * 1024 * 1024) continue

        let result = null
        if (VIDEO_EXTS.has(ext)) {
          const vResult = await captureVideoFrameFFmpeg(filePath, id)
          if (vResult?.imgBuf?.length > 64) {
            const saved = await saveThumbnailBuffer(id, vResult.imgBuf)
            result = { ...saved, imgW: vResult.imgW, imgH: vResult.imgH }
          }
        } else {
          result = await generateThumbForFile(filePath, ext, id)
        }

        if (result?.thumbUrl) {
          dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [result.imgW || null, result.imgH || null, id])
          flushDB()
          scheduleAiIndexingForThumbnailAsset(id, 'thumbnail quality refresh')
          if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('thumb:done', {
              id,
              thumbUrl: result.thumbUrl,
              thumbnailVariants: result.thumbnailVariants,
              width: result.imgW,
              height: result.imgH,
            })
          }
        }
        done += 1
        if (done % 25 === 0) thumbLog('quality-refresh:progress', { done, total: rows.length })
      } catch (e) {
        console.warn('[Thumb] quality refresh failed for', name || id, e.message)
      }
      thumbLog('quality-refresh:item', { id, name, ext, ms: Date.now() - itemStarted })
      await new Promise(r => setTimeout(r, 40))
    }
    fs.writeFileSync(doneFlag, String(Date.now()))
    thumbLog('quality-refresh:done', { done, total: rows.length })
  } catch (e) {
    console.warn('[Thumb] quality refresh stopped:', e.message)
  }
}

// IPC: renderer asks main to (re)start the thumb worker after an import
ipcMain.handle('thumb:startWorker', () => { setImmediate(runThumbWorker); return true })
ipcMain.handle('thumb:queueVariants', async (_ev, ids, opts = {}) => {
  if (!THUMB_VARIANTS.length) return true
  const uniqueIds = [...new Set((ids || []).filter(Boolean))]
  const notify = opts.notify !== false
  thumbLog('variant-queue:bulk-add', { count: uniqueIds.length, notify })
  for (const id of uniqueIds) queueThumbnailVariants(id, { notify })
  await waitForThumbnailVariantQueue()
  thumbLog('variant-queue:bulk-done', { count: uniqueIds.length, notify })
  return true
})

// IPC: generate thumbnails for a batch of assets in parallel (used during import).
ipcMain.handle('thumb:generateBatch', async (_ev, items, options = {}) => {
  const batchStarted = Date.now()
  const batchItems = items || []
  const requestedConcurrency = Number(options?.concurrency || 8)
  const concurrency = Math.max(1, Math.min(requestedConcurrency, batchItems.length || 1))
  const progressType = options?.progressType || 'batch'
  const progressOffset = Math.max(0, Number(options?.progressOffset || 0))
  const progressTotal = Math.max(batchItems.length, Number(options?.progressTotal || batchItems.length))
  const emitBatchProgress = (current, file) => emitThumbProgress({
    type: progressType,
    current: Math.min(progressTotal, progressOffset + current),
    total: progressTotal,
    ...(file ? { file } : {}),
  })
  let completed = 0
  thumbLog('batch:start', { count: batchItems.length, concurrency })
  emitBatchProgress(0)
  const results = new Array(batchItems.length)
  let nextIndex = 0
  const emitThumbDone = (result) => {
    if (!result?.thumbUrl) return
    if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('thumb:done', {
        id: result.id,
        thumbUrl: result.thumbUrl,
        thumbnailVariants: result.thumbnailVariants,
        width: result.width,
        height: result.height,
      })
    }
  }
  const worker = async () => {
    while (nextIndex < batchItems.length) {
      const index = nextIndex++
      const { id, filePath, ext } = batchItems[index]
      const itemStarted = Date.now()
      const name = path.basename(filePath || '')
      emitBatchProgress(completed, name)
      try {
        thumbLog('batch:item:start', { id, name, ext })
        if (!THUMB_EXTS.has(ext)) {
          thumbLog('batch:item:skip:unsupported', { id, name, ext })
          results[index] = { id, thumbUrl: null }
          continue
        }
        const stat = await fs.promises.stat(filePath).catch(() => null)
        if (!stat) {
          thumbLog('batch:item:skip:missing', { id, name })
          results[index] = { id, thumbUrl: null }
          continue
        }
        if (stat.size > 60 * 1024 * 1024 && ext !== 'pdf' && ext !== 'epub') {
          thumbLog('batch:item:skip:too-large', { id, name, size: stat.size })
          results[index] = { id, thumbUrl: null }
          continue
        }

        if (VIDEO_EXTS.has(ext)) {
          const vResult = await captureVideoFrameFFmpeg(filePath, id)
          if (!vResult || !vResult.imgBuf || vResult.imgBuf.length < 64) {
            thumbLog('batch:item:video-frame-empty', { id, name, ms: Date.now() - itemStarted })
            results[index] = { id, thumbUrl: null }
            continue
          }
          const saved = await saveThumbnailBuffer(id, vResult.imgBuf, { variantMode: 'async' })
          dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [vResult.imgW, vResult.imgH, id])
          scheduleAiIndexingForThumbnailAsset(id, 'batch video thumbnail')
          thumbLog('batch:item:done', { id, name, ext, ms: Date.now() - itemStarted, width: vResult.imgW, height: vResult.imgH })
          results[index] = { id, thumbUrl: saved.thumbUrl, thumbnailVariants: saved.thumbnailVariants, width: vResult.imgW, height: vResult.imgH }
          emitThumbDone(results[index])
          continue
        }

        const result = await generateThumbForFile(filePath, ext, id, { variantMode: 'async' })
        if (!result) {
          thumbLog('batch:item:empty', { id, name, ext, ms: Date.now() - itemStarted })
          results[index] = { id, thumbUrl: null }
          continue
        }

        const { thumbUrl, thumbnailVariants, imgW, imgH } = result
        dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [imgW, imgH, id])
        scheduleAiIndexingForThumbnailAsset(id, 'batch thumbnail')
        thumbLog('batch:item:done', { id, name, ext, ms: Date.now() - itemStarted, width: imgW, height: imgH })
        results[index] = { id, thumbUrl, thumbnailVariants, width: imgW, height: imgH }
        emitThumbDone(results[index])
      } catch (e) {
        console.warn('[Thumb] generateBatch failed for', filePath, e.message)
        results[index] = { id, thumbUrl: null }
      } finally {
        completed += 1
        emitBatchProgress(completed, name)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  try { flushDB() } catch {}
  thumbLog('batch:done', { count: batchItems.length, returned: results.filter(r => r?.thumbUrl).length, ms: Date.now() - batchStarted })
  if (progressType === 'batch') {
    emitThumbProgress({ type: 'done', current: completed, total: batchItems.length })
  } else {
    emitBatchProgress(completed)
  }
  return results
})

// IPC: renderer asks main to generate a video thumbnail via ffmpeg (fallback when canvas fails)
ipcMain.handle('thumb:videoFrame', async (_ev, { id, filePath, ext, variantMode, notifyVariants, timeSec, transient, maxDim }) => {
  try {
    console.log('[VideoThumb] Main-process ffmpeg fallback for:', filePath)
    if (!VIDEO_EXTS.has(ext)) return null
    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat || !stat.isFile()) return null

    let result = null
    const requestedTime = Number.isFinite(timeSec) ? Number(timeSec) : null
    const requestedDim = Number.isFinite(maxDim) ? Number(maxDim) : 600
    if (transient || ext === 'ts' || ext === 'mts' || ext === 'm2ts' || ext === 'f4v') {
      result = await captureVideoFrameFFmpeg(filePath, id, requestedTime, requestedDim)
    } else {
      result = await captureVideoFrame(filePath, requestedTime, requestedDim)
      if (!result) result = await captureVideoFrameFFmpeg(filePath, id, requestedTime, requestedDim)
    }
    if (!result || !result.imgBuf || result.imgBuf.length < 64) {
      console.warn('[VideoThumb] No frame captured for:', filePath)
      return null
    }
    if (transient) {
      return {
        thumbUrl: `data:image/webp;base64,${result.imgBuf.toString('base64')}`,
        width: result.imgW,
        height: result.imgH,
      }
    }
    const saved = await saveThumbnailBuffer(id, result.imgBuf, {
      variantMode: variantMode || 'async',
      notifyVariants,
    })
    if (_db) {
      dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [result.imgW || 0, result.imgH || 0, id])
      flushDB()
      scheduleAiIndexingForThumbnailAsset(id, 'video thumbnail')
    }
    console.log('[VideoThumb] Saved', result.imgW, 'x', result.imgH, 'for', path.basename(filePath))
    return { thumbUrl: saved.thumbUrl, thumbnailVariants: saved.thumbnailVariants, width: result.imgW, height: result.imgH }
  } catch (e) {
    console.warn('[VideoThumb] thumb:videoFrame error:', e.message)
    return null
  }
})

// ── Migration v5: convert existing .jpg thumbnails to .webp ──────────────────
// Reads each .jpg thumb, re-encodes as WebP via Chromium canvas, saves as .webp.
// Falls back to resetting hasThumb=0 (re-generate) if conversion fails.
async function migrateThumbsToWebP() {
  const doneFlag = path.join(getDataDir(), '.thumb_webp_v1')
  if (!_db || fs.existsSync(doneFlag)) return
  console.log('[Migration] thumb_webp_v1: converting thumbnails to WebP...')
  try {
    const rows = dbAll('SELECT id FROM assets WHERE hasThumb=1 AND deleted=0', [])
    let converted = 0, reset = 0
    for (const row of rows) {
      const oldPath = path.join(getDataDir(), 'thumbs', row.id.slice(0, 2), row.id + '.jpg')
      if (!fs.existsSync(oldPath)) continue
      try {
        const jpgBuf  = fs.readFileSync(oldPath)
        const webpBuf = await bufToWebP(jpgBuf, 'image/jpeg')
        if (webpBuf && webpBuf.length > 64) {
          const newPath = thumbFilePath(row.id)  // .webp
          fs.writeFileSync(newPath, webpBuf)
          try { fs.unlinkSync(oldPath) } catch {}
          converted++
          // Notify renderer so it can display the converted thumbnail
          if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('thumb:done', { id: row.id, thumbUrl: 'file://' + newPath.replace(/\\/g, '/') })
          }
        } else {
          dbRun('UPDATE assets SET hasThumb=0 WHERE id=?', [row.id])
          try { fs.unlinkSync(oldPath) } catch {}
          reset++
        }
      } catch {
        dbRun('UPDATE assets SET hasThumb=0 WHERE id=?', [row.id])
        reset++
      }
      if ((converted + reset) % 50 === 0) await new Promise(r => setImmediate(r))
    }
    flushDB()
    fs.writeFileSync(doneFlag, String(Date.now()))
    console.log(`[Migration] thumb_webp_v1: converted=${converted}, reset=${reset}`)
  } catch (e) {
    console.error('[Migration] thumb_webp_v1 failed:', e)
  }
}

async function ensureExistingThumbVariants() {
  if (!_db) return
  if (!THUMB_VARIANTS.length) {
    const doneFlag = path.join(getDataDir(), '.thumb_variants_disabled_v1')
    if (fs.existsSync(doneFlag)) return
    try {
      const rows = dbAll('SELECT id FROM assets WHERE hasThumb=1 AND deleted=0', [])
      for (const row of rows) deleteThumbnailVariantFilesSync(row.id)
      fs.writeFileSync(doneFlag, String(Date.now()))
      if (rows.length) console.log(`[Thumb] Removed legacy thumbnail variants for ${rows.length} assets; variants are disabled`)
    } catch (e) {
      console.warn('[Thumb] legacy variant cleanup failed:', e.message)
    }
    return
  }
  if (!getSharp()) return
  const doneFlag = path.join(getDataDir(), '.thumb_variants_v4')
  try {
    const shouldMarkMigration = !fs.existsSync(doneFlag)
    const rows = dbAll('SELECT id FROM assets WHERE hasThumb=1 AND deleted=0', [])
      .filter(row => fs.existsSync(thumbFilePath(row.id)))
      .filter(row => THUMB_VARIANTS.some(v => !fs.existsSync(thumbVariantFilePath(row.id, v.key))))

    if (!rows.length) {
      if (shouldMarkMigration) fs.writeFileSync(doneFlag, String(Date.now()))
      return
    }
    console.log(`[Thumb] Backfilling missing thumbnail variants for ${rows.length} existing assets (${THUMB_VARIANTS.map(v => `${v.key}=${v.width}px`).join(', ')})`)
    let done = 0
    for (const row of rows) {
      const thumbnailVariants = await ensureThumbnailVariants(row.id)
      if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('thumb:done', {
          id: row.id,
          thumbUrl: fileUrl(thumbFilePath(row.id)),
          thumbnailVariants,
        })
      }
      done++
      if (done % 25 === 0) await new Promise(r => setTimeout(r, 30))
      else await new Promise(r => setImmediate(r))
    }
    if (shouldMarkMigration) fs.writeFileSync(doneFlag, String(Date.now()))
    console.log(`[Thumb] Existing thumbnail variants ready: ${done}`)
  } catch (e) {
    console.warn('[Thumb] ensureExistingThumbVariants failed:', e.message)
  }
}

// ── AI Image Search (TIPSv2) ─────────────────────────────────────────────────
const AI_ORIGINAL_EXTS = new Set(['jpg','jpeg','png','webp'])
const { createAiModelManager } = require('./aiModelManager')
const { findBundledPython, probePython, pythonEnvironment } = require('./pythonRuntime')

let _aiIndexProc = null
let _aiIndexRunActive = false
let _aiIndexScheduleTimer = null
let _aiIndexScheduledCount = 0
let _aiIndexRerunRequested = false
let _aiIndexCancelled = false
let _aiIndexGeneration = 0
let _aiTaskPromise = null
let _pythonBinPromise = null
let _aiSearchProc = null
let _aiSearchReadyPromise = null
let _aiSearchRequests = new Map()
let _aiSearchRequestId = 0
let _aiSearchGeneration = 0
let _dinoPythonBinPromise = null
let _dinoIndexPromise = null
let _dinoTaskPromise = null
let _dinoIndexProc = null
let _dinoSearchProc = null
let _dinoSearchReadyPromise = null
let _dinoSearchRequests = new Map()
let _dinoSearchRequestId = 0
let _dinoSearchGeneration = 0
let _dinoIndexScheduleTimer = null
let _dinoIndexRerunRequested = false
let _dinoIndexCancelled = false
const aiModels = createAiModelManager({
  getRootDir: getDataDir,
  sendProgress: progress => mainWindow?.webContents.send('ai:modelDownloadProgress', progress),
})

function getAiIndexDir() {
  const dir = path.join(getDataDir(), 'ai-index')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getAiStateFile() { return path.join(getAiIndexDir(), 'ai-index-state.json') }
function getAiIndexFile() { return path.join(getAiIndexDir(), 'tipsv2_index.pt') }
function getDinoIndexDir() { return path.join(getAiIndexDir(), 'dinov3') }

let _legacyAiStagingCleaned = false
function cleanupLegacyAiStaging() {
  if (_legacyAiStagingCleaned) return
  _legacyAiStagingCleaned = true
  for (const name of ['ai-staging', 'dino-staging', 'ai-run-pending']) {
    try { fs.rmSync(path.join(getDataDir(), name), { recursive: true, force: true }) }
    catch (error) { mainLog.warn({ error, name }, 'could not remove legacy AI staging directory') }
  }
}

function createAiAssetManifest(prefix, assets) {
  cleanupLegacyAiStaging()
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), `stag-${prefix}-`))
  const manifestPath = path.join(tempDir, 'assets.json')
  const items = assets.map(asset => ({
    asset_id: String(asset.id),
    source_path: asset.sourcePath,
    source_version: asset.sourceVersion,
  }))
  fs.writeFileSync(manifestPath, JSON.stringify(items))
  return {
    path: manifestPath,
    cleanup: () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
    },
  }
}

function getAiFeatureStatus() {
  const models = aiModels.allStatus()
  const dinoEnabled = isDinoImageIndexEnabled()
  const settings = loadSettings()
  const tipsStatus = getAiIndexStatus()
  const dinoStatus = getDinoIndexStatus()
  const tagging = settings.aiSettings || {}
  return {
    tipsv2: {
      ...models.tipsv2,
      enabled: models.tipsv2.installed && settings.aiEmbeddingEnabled === true,
      hasIndex: tipsStatus.hasIndex,
      indexPath: tipsStatus.indexPath,
      indexed: tipsStatus.indexed,
      pending: tipsStatus.pending,
      total: tipsStatus.total,
      running: tipsStatus.running,
    },
    dinov3: {
      ...models.dinov3,
      enabled: dinoEnabled,
      hasIndex: dinoStatus.hasIndex,
      indexPath: dinoStatus.indexPath,
      indexed: dinoStatus.indexed,
      pending: dinoStatus.pending,
      total: dinoStatus.total,
      running: dinoStatus.running,
    },
    tagging: {
      enabled: tagging.enabled === true,
      ollamaUrl: tagging.ollamaUrl || 'http://localhost:11434',
      model: tagging.model || '',
    },
  }
}

function broadcastAiFeatureStatus() {
  const features = getAiFeatureStatus()
  mainWindow?.webContents.send('ai:featureStatusChanged', features)
  return features
}

function saveAiState(state) {
  try { fs.writeFileSync(getAiStateFile(), JSON.stringify(state)) } catch {}
}
function loadAiState() {
  try { return JSON.parse(fs.readFileSync(getAiStateFile(), 'utf8')) }
  catch { return {} }
}

function getPythonScript() {
  const candidates = [
    // In packaged builds, external Python cannot execute files inside app.asar.
    // Prefer the real unpacked filesystem path created by electron-builder.
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'AI-index', 'tipsv2_search.py'),
    path.join(process.resourcesPath || '', 'AI-index', 'tipsv2_search.py'),
    path.join(app.getAppPath(), 'AI-index', 'tipsv2_search.py'),
  ]
  return candidates.find(p => p && fs.existsSync(p)) || candidates[0]
}

function getDinoPythonScript() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'AI-index', 'dinov3_search.py'),
    path.join(process.resourcesPath || '', 'AI-index', 'dinov3_search.py'),
    path.join(app.getAppPath(), 'AI-index', 'dinov3_search.py'),
  ]
  return candidates.find(p => p && fs.existsSync(p)) || candidates[0]
}

function getPythonBin() {
  if (_pythonBinPromise) return _pythonBinPromise
  const { execFile } = require('child_process')
  const os = require('os')
  const home = os.homedir()
  const candidates = process.platform === 'win32'
    ? [process.env.STAG_PYTHON, 'python', 'py', 'python3']
    : [
        process.env.STAG_PYTHON,
        path.join(home, 'miniconda3/bin/python3'),
        path.join(home, 'miniforge3/bin/python3'),
        path.join(home, 'anaconda3/bin/python3'),
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        'python3',
        'python',
      ]
  const seen = new Set()
  const uniqueCandidates = candidates.filter(bin => bin && !seen.has(bin) && seen.add(bin))
  const importCheck = 'import torch, torchvision, transformers, PIL, tqdm'
  const canRun = (bin, args, timeout) => new Promise(resolve => {
    execFile(bin, args, { windowsHide: true, timeout }, error => resolve(!error))
  })
  _pythonBinPromise = (async () => {
    if (app.isPackaged && !runtimeDependencies.isAiReady()) {
      const installed = await runtimeDependencies.ensureAi()
      if (!installed.ok) return null
    }
    const managedPython = runtimeDependencies.getPaths().python
    const bundled = app.isPackaged && fs.existsSync(managedPython)
      ? { executable: managedPython }
      : findBundledPython({ app })
    if (bundled) {
      const probe = await probePython(bundled.executable, 'tipsv2')
      if (probe.ok) {
        console.log(`[ai-embed] using bundled Python ${probe.version}: ${bundled.executable}`)
        return bundled.executable
      }
      mainLog.error({
        feature: 'tipsv2',
        python: bundled.executable,
        runtimeTarget: `${process.platform}-${process.arch}`,
        error: probe.error,
      }, 'AI embedding Python probe failed')
      if (app.isPackaged) return null
    } else if (app.isPackaged) {
      console.error('[ai-embed] bundled Python runtime not found')
      return null
    }
    for (const bin of uniqueCandidates) {
      if (await canRun(bin, ['-c', importCheck], 10000)) {
        console.log(`[ai-embed] using Python with AI deps: ${bin}`)
        return bin
      }
    }
    return null
  })()
  return _pythonBinPromise
}

function getDinoPythonBin() {
  if (_dinoPythonBinPromise) return _dinoPythonBinPromise
  const { execFile } = require('child_process')
  const os = require('os')
  const home = os.homedir()
  const candidates = process.platform === 'win32'
    ? [process.env.STAG_PYTHON, 'python', 'py', 'python3']
    : [
        process.env.STAG_PYTHON,
        path.join(home, 'miniconda3/bin/python3'),
        path.join(home, 'miniforge3/bin/python3'),
        path.join(home, 'anaconda3/bin/python3'),
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3',
        'python3',
        'python',
      ]
  const seen = new Set()
  const uniqueCandidates = candidates.filter(bin => bin && !seen.has(bin) && seen.add(bin))
  const modelImportCheck = 'import numpy, torch, torchvision, transformers, PIL'
  const faissImportCheck = 'import faiss, numpy'
  const canRun = (bin, args, timeout) => new Promise(resolve => {
    execFile(bin, args, { windowsHide: true, timeout }, error => resolve(!error))
  })
  _dinoPythonBinPromise = (async () => {
    if (app.isPackaged && !runtimeDependencies.isAiReady()) {
      const installed = await runtimeDependencies.ensureAi()
      if (!installed.ok) return null
    }
    const managedPython = runtimeDependencies.getPaths().python
    const bundled = app.isPackaged && fs.existsSync(managedPython)
      ? { executable: managedPython }
      : findBundledPython({ app })
    if (bundled) {
      const probe = await probePython(bundled.executable, 'dinov3')
      if (probe.ok) {
        console.log(`[dino-search] using bundled Python ${probe.version}: ${bundled.executable}`)
        return bundled.executable
      }
      mainLog.error({
        feature: 'dinov3',
        python: bundled.executable,
        runtimeTarget: `${process.platform}-${process.arch}`,
        error: probe.error,
      }, 'DINOv3 Python probe failed')
      if (app.isPackaged) return null
    } else if (app.isPackaged) {
      console.error('[dino-search] bundled Python runtime not found')
      return null
    }
    for (const bin of uniqueCandidates) {
      const hasModelDependencies = await canRun(bin, ['-c', modelImportCheck], 10000)
      const hasFaiss = hasModelDependencies && await canRun(bin, ['-c', faissImportCheck], 10000)
      if (hasModelDependencies && hasFaiss) {
        console.log(`[dino-search] using Python with DINOv3 dependencies: ${bin}`)
        return bin
      }
    }
    return null
  })()
  return _dinoPythonBinPromise
}

function stopAiSearchWorker(reason = 'stopped') {
  _aiSearchGeneration += 1
  const proc = _aiSearchProc
  _aiSearchProc = null
  _aiSearchReadyPromise = null
  for (const pending of _aiSearchRequests.values()) {
    clearTimeout(pending.timer)
    pending.resolve({ ok: false, error: reason, assetIds: [] })
  }
  _aiSearchRequests.clear()
  if (proc) {
    try { proc.kill() } catch {}
  }
}

function startAiSearchWorker() {
  if (_aiSearchProc && _aiSearchReadyPromise) return _aiSearchReadyPromise
  if (!isAiEmbeddingEnabled()) return Promise.resolve({ ok: false, error: 'embedding-disabled' })
  const indexFile = getAiIndexFile()
  if (!aiModels.isInstalled('tipsv2')) return Promise.resolve({ ok: false, error: 'model-not-installed' })
  if (!fs.existsSync(indexFile)) return Promise.resolve({ ok: false, error: 'not-indexed' })
  const script = getPythonScript()
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: 'script-not-found' })

  const generation = ++_aiSearchGeneration
  _aiSearchReadyPromise = (async () => {
    const { spawn } = require('child_process')
    const pythonBin = await getPythonBin()
    if (!pythonBin) return { ok: false, error: 'python-runtime-missing' }
    if (generation !== _aiSearchGeneration) return { ok: false, error: 'search-worker-cancelled' }
    return new Promise(resolve => {
      const proc = spawn(pythonBin, [
        script, 'serve',
        '--index', indexFile,
        '--model', aiModels.getModelPath('tipsv2'),
      ], {
        env: pythonEnvironment(pythonBin),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      _aiSearchProc = proc
      let settled = false
      let stdoutBuf = ''
      const readyTimer = setTimeout(() => {
        if (settled) return
        settled = true
        stopAiSearchWorker('search-worker-timeout')
        resolve({ ok: false, error: 'search-worker-timeout' })
      }, 120000)

      proc.stdout.on('data', chunk => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split(/\r?\n/)
        stdoutBuf = lines.pop() || ''
        for (const line of lines) {
          const text = line.trim()
          if (!text.startsWith('{')) continue
          try {
            const msg = JSON.parse(text)
            if (msg.type === 'ready' && !settled) {
              settled = true
              clearTimeout(readyTimer)
              console.log(`[ai-search] worker ready on ${msg.device} with ${msg.entries} entries`)
              resolve({ ok: true, device: msg.device, entries: msg.entries })
            } else if (msg.type === 'result') {
              const pending = _aiSearchRequests.get(msg.id)
              if (!pending) continue
              _aiSearchRequests.delete(msg.id)
              clearTimeout(pending.timer)
              if (msg.error) pending.resolve({ ok: false, error: msg.error, assetIds: [] })
              else pending.resolve(formatAiSearchResults(msg.results))
            }
          } catch {}
        }
      })
      proc.stderr.on('data', chunk => {
        const text = chunk.toString().trim()
        if (text) console.log(`[ai-search] Python stderr: ${text}`)
      })
      proc.on('error', error => {
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          resolve({ ok: false, error: error.message })
        }
        stopAiSearchWorker(error.message)
      })
      proc.on('close', code => {
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          resolve({ ok: false, error: `search worker exited ${code}` })
        }
        if (_aiSearchProc === proc) stopAiSearchWorker(`search worker exited ${code}`)
      })
    })
  })()
  return _aiSearchReadyPromise
}

function formatAiSearchResults(rawResults) {
  const results = (Array.isArray(rawResults) ? rawResults : [])
    .filter(result => Number(result?.score ?? 0) > 0.1)
  const assetIds = results
    .map(result => result.assetId || path.basename(String(result.path || ''), path.extname(String(result.path || ''))))
    .filter(Boolean)
  return { ok: true, results, assetIds }
}

function stopDinoSearchWorker(reason = 'stopped') {
  _dinoSearchGeneration += 1
  const proc = _dinoSearchProc
  _dinoSearchProc = null
  _dinoSearchReadyPromise = null
  for (const pending of _dinoSearchRequests.values()) {
    clearTimeout(pending.timer)
    pending.resolve({ ok: false, error: reason, assetIds: [] })
  }
  _dinoSearchRequests.clear()
  if (proc) {
    try { proc.kill() } catch {}
  }
}

function isDinoImageIndexEnabled() {
  return aiModels.isInstalled('dinov3') &&
    loadSettings().dinoImageIndexEnabled === true
}

function getDinoIndexedAssetIds() {
  try {
    const metadataPath = path.join(getDinoIndexDir(), 'metadata.json')
    if (!fs.existsSync(metadataPath)) return []
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    return (Array.isArray(metadata.asset_ids) ? metadata.asset_ids : (metadata.paths || [])
      .map(filePath => path.basename(String(filePath), path.extname(String(filePath)))))
      .map(String)
      .filter(Boolean)
  } catch {
    return []
  }
}

function getDinoIndexStatus() {
  const eligibleAssets = getAiEligibleAssets()
  const eligibleById = new Map(eligibleAssets.map(asset => [String(asset.id), asset]))
  let indexedVersions = new Map()
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(getDinoIndexDir(), 'metadata.json'), 'utf8'))
    const ids = metadata.asset_ids || (metadata.paths || [])
      .map(filePath => path.basename(String(filePath), path.extname(String(filePath))))
    const versions = metadata.source_versions || metadata.mtimes || []
    indexedVersions = new Map(ids.map((id, index) => [String(id), String(versions[index] ?? '')]))
  } catch {}
  const assetIds = [...indexedVersions.entries()]
    .filter(([id, version]) => eligibleById.get(id)?.sourceVersion === version)
    .map(([id]) => id)
  return {
    enabled: isDinoImageIndexEnabled(),
    hasIndex: assetIds.length > 0 && fs.existsSync(path.join(getDinoIndexDir(), 'images.faiss')),
    indexed: assetIds.length,
    pending: Math.max(0, eligibleById.size - assetIds.length),
    total: eligibleById.size,
    running: !!_dinoIndexPromise || !!_dinoIndexProc,
    modelLoaded: !!_dinoSearchProc,
    modelInstalled: aiModels.isInstalled('dinov3'),
    indexPath: fs.existsSync(path.join(getDinoIndexDir(), 'images.faiss')) ? getDinoIndexDir() : '',
    assetIds,
  }
}

function sendDinoProgress(message) {
  mainWindow?.webContents.send('ai:imageSearchProgress', message)
}

function stopDinoIndexing(reason = 'cancelled') {
  _dinoIndexCancelled = true
  const proc = _dinoIndexProc
  _dinoIndexProc = null
  if (proc) {
    try { proc.kill() } catch {}
  }
  sendDinoProgress({ type: 'cancelled', error: reason, status: { ...getDinoIndexStatus(), running: false } })
}

function clearDinoIndexData() {
  try {
    if (_dinoIndexScheduleTimer) {
      clearTimeout(_dinoIndexScheduleTimer)
      _dinoIndexScheduleTimer = null
    }
    _dinoIndexRerunRequested = false
    stopDinoIndexing('DINOv3 index cleared')
    stopDinoSearchWorker('DINOv3 index cleared')
    try { fs.rmSync(getDinoIndexDir(), { recursive: true, force: true }) } catch {}
    cleanupLegacyAiStaging()
    const status = getDinoIndexStatus()
    sendDinoProgress({ type: 'done', current: 0, total: status.total, indexed: 0, status })
    return { ok: true, status }
  } catch (error) {
    return { ok: false, error: error?.message || String(error), status: getDinoIndexStatus() }
  }
}

function scheduleDinoIndexing(reason = 'new assets') {
  if (!isDinoImageIndexEnabled()) return
  if (_dinoIndexScheduleTimer) clearTimeout(_dinoIndexScheduleTimer)
  _dinoIndexScheduleTimer = setTimeout(() => {
    _dinoIndexScheduleTimer = null
    if (_dinoIndexPromise || _dinoIndexProc) {
      _dinoIndexRerunRequested = true
      console.log(`[dino-search] Indexer already running; ${reason} will be picked up after current run`)
      return
    }
    console.log(`[dino-search] Starting automatic index update for ${reason}`)
    ensureDinoIndex().catch(error => sendDinoProgress({ type: 'error', error: error?.message || String(error) }))
  }, 2500)
}

function dinoIndexIsFresh(assets) {
  try {
    const indexDir = getDinoIndexDir()
    const metadataPath = path.join(indexDir, 'metadata.json')
    const faissPath = path.join(indexDir, 'images.faiss')
    if (!fs.existsSync(metadataPath) || !fs.existsSync(faissPath)) return false
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    if (metadata.model_id !== aiModels.getModelPath('dinov3')) return false
    const ids = metadata.asset_ids || (metadata.paths || [])
      .map(filePath => path.basename(String(filePath), path.extname(String(filePath))))
    const versions = metadata.source_versions || metadata.mtimes || []
    const indexed = new Map(ids.map((id, index) => [String(id), String(versions[index] ?? '')]))
    return assets.length === indexed.size &&
      assets.every(asset => indexed.get(String(asset.id)) === asset.sourceVersion)
  } catch {
    return false
  }
}

async function ensureDinoIndex(options = {}) {
  if (_dinoTaskPromise) return _dinoTaskPromise
  _dinoTaskPromise = aiTaskCoordinator.run('dino-index', () => runDinoIndex(options))
  try {
    return await _dinoTaskPromise
  } finally {
    _dinoTaskPromise = null
  }
}

async function runDinoIndex() {
  if (!aiModels.isInstalled('dinov3')) return { ok: false, error: 'model-not-installed' }
  if (!isDinoImageIndexEnabled()) {
    return { ok: false, error: 'dinov3-index-disabled' }
  }
  if (_dinoIndexPromise) return _dinoIndexPromise
  _dinoIndexCancelled = false
  _dinoIndexPromise = (async () => {
    if (!_db) await initDB()
    const assets = getAiEligibleAssets()
    if (!assets.length) {
      stopDinoSearchWorker('DINOv3 index is empty')
      try { fs.rmSync(getDinoIndexDir(), { recursive: true, force: true }) } catch {}
      const result = { ok: true, indexed: 0, assetIds: [] }
      sendDinoProgress({ type: 'done', current: 0, total: 0, ...result })
      return result
    }
    if (dinoIndexIsFresh(assets)) {
      const result = { ok: true, indexed: assets.length, assetIds: getDinoIndexedAssetIds() }
      sendDinoProgress({ type: 'done', current: assets.length, total: assets.length, ...result })
      return result
    }

    if (_dinoIndexCancelled || !isDinoImageIndexEnabled()) {
      return { ok: false, error: _dinoIndexCancelled ? 'cancelled' : 'dinov3-index-disabled' }
    }
    stopDinoSearchWorker('DINOv3 index rebuilding')
    const pythonBin = await getDinoPythonBin()
    if (!pythonBin) return { ok: false, error: 'dinov3-dependencies-missing' }
    const script = getDinoPythonScript()
    if (!fs.existsSync(script)) return { ok: false, error: 'dinov3-script-not-found' }
    const indexDir = getDinoIndexDir()
    fs.mkdirSync(indexDir, { recursive: true })
    const manifest = createAiAssetManifest('dino-index', assets)
    const { spawn } = require('child_process')
    try {
    return await new Promise(resolve => {
      const proc = spawn(pythonBin, [
        script, 'index',
        '--manifest', manifest.path,
        '--index', indexDir,
        '--batch-size', '1',
        '--model', aiModels.getModelPath('dinov3'),
      ], {
        env: pythonEnvironment(pythonBin),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      _dinoIndexProc = proc
      let settled = false
      let stdoutBuf = ''
      let lastError = ''
      const settle = result => {
        if (settled) return
        settled = true
        resolve(result)
      }
      proc.stdout.on('data', chunk => {
        if (_dinoIndexCancelled) return
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split(/\r?\n/)
        stdoutBuf = lines.pop() || ''
        for (const line of lines) {
          const text = line.trim()
          if (!text.startsWith('{')) continue
          try {
            const message = JSON.parse(text)
            sendDinoProgress(message)
          } catch {}
        }
      })
      proc.stderr.on('data', chunk => {
        lastError = chunk.toString().trim() || lastError
        if (lastError) console.log(`[dino-search] Python stderr: ${lastError}`)
      })
      proc.on('error', error => {
        if (_dinoIndexProc === proc) _dinoIndexProc = null
        if (!_dinoIndexCancelled) sendDinoProgress({ type: 'error', error: error.message })
        settle({ ok: false, error: _dinoIndexCancelled ? 'cancelled' : error.message })
      })
      proc.on('close', code => {
        if (_dinoIndexProc === proc) _dinoIndexProc = null
        const result = code === 0
          ? { ok: true, indexed: assets.length, assetIds: getDinoIndexedAssetIds() }
          : { ok: false, error: _dinoIndexCancelled ? 'cancelled' : lastError || `DINOv3 indexer exited ${code}` }
        const status = { ...getDinoIndexStatus(), running: false }
        if (!_dinoIndexCancelled) sendDinoProgress(code === 0
          ? { type: 'done', current: status.indexed, total: status.total, ...result, status }
          : { type: 'error', error: result.error })
        settle(result)
      })
    })
    } finally {
      manifest.cleanup()
    }
  })()
  try {
    return await _dinoIndexPromise
  } finally {
    _dinoIndexPromise = null
    if (_dinoIndexRerunRequested && isDinoImageIndexEnabled()) {
      _dinoIndexRerunRequested = false
      scheduleDinoIndexing('assets added during previous DINOv3 run')
    }
  }
}

async function startDinoSearchWorker() {
  if (_dinoSearchProc && _dinoSearchReadyPromise) return _dinoSearchReadyPromise
  const indexed = await ensureDinoIndex()
  if (!indexed.ok) return indexed
  const pythonBin = await getDinoPythonBin()
  if (!pythonBin) return { ok: false, error: 'dinov3-dependencies-missing' }
  const script = getDinoPythonScript()
  const generation = ++_dinoSearchGeneration
  _dinoSearchReadyPromise = new Promise(resolve => {
    const { spawn } = require('child_process')
    sendDinoProgress({ type: 'model_loading' })
    const proc = spawn(pythonBin, [script, 'serve', '--index', getDinoIndexDir()], {
      env: pythonEnvironment(pythonBin),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    _dinoSearchProc = proc
    let settled = false
    let stdoutBuf = ''
    const readyTimer = setTimeout(() => {
      if (settled) return
      settled = true
      stopDinoSearchWorker('DINOv3 worker timeout')
      resolve({ ok: false, error: 'dinov3-worker-timeout' })
    }, 180000)
    proc.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() || ''
      for (const line of lines) {
        const text = line.trim()
        if (!text.startsWith('{')) continue
        try {
          const message = JSON.parse(text)
          if (message.type === 'ready' && !settled) {
            settled = true
            clearTimeout(readyTimer)
            sendDinoProgress({ type: 'model_ready', device: message.device, indexed: message.entries })
            resolve({ ok: true, device: message.device, entries: message.entries })
          } else if (message.type === 'result') {
            const pending = _dinoSearchRequests.get(message.id)
            if (!pending) continue
            _dinoSearchRequests.delete(message.id)
            clearTimeout(pending.timer)
            pending.resolve(message.error
              ? { ok: false, error: message.error, assetIds: [] }
              : formatAiSearchResults(message.results))
          }
        } catch {}
      }
    })
    proc.stderr.on('data', chunk => {
      const text = chunk.toString().trim()
      if (text) console.log(`[dino-search] Python stderr: ${text}`)
    })
    proc.on('error', error => {
      if (!settled) {
        settled = true
        clearTimeout(readyTimer)
        resolve({ ok: false, error: error.message })
      }
      stopDinoSearchWorker(error.message)
    })
    proc.on('close', code => {
      if (!settled) {
        settled = true
        clearTimeout(readyTimer)
        resolve({ ok: false, error: `DINOv3 worker exited ${code}` })
      }
      if (generation === _dinoSearchGeneration && _dinoSearchProc === proc) {
        stopDinoSearchWorker(`DINOv3 worker exited ${code}`)
      }
    })
  })
  return _dinoSearchReadyPromise
}

function runNodeWorker(scriptName, payload, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const { fork } = require('child_process')
    const workerPath = path.join(__dirname, scriptName)
    const child = fork(workerPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      reject(new Error(`${scriptName} timed out`))
    }, timeoutMs)

    child.on('message', msg => {
      if (!msg || msg.type !== 'result') return
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.disconnect() } catch {}
      try { child.kill() } catch {}
      resolve(msg.result)
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`${scriptName} exited with code ${code}`))
    })
    child.send(payload)
  })
}

function markAssetsEmbeddedIds(ids, immediate = false, versionById = null) {
  try {
    if (!_db || !Array.isArray(ids) || ids.length === 0) return
    const uniqueIds = [...new Set(ids)]
    dbTransaction(() => {
      for (const id of uniqueIds) {
        const sourceVersion = versionById?.get(String(id)) || ''
        dbRun('UPDATE assets SET aiEmbedded=1, aiEmbeddedVersion=? WHERE id=?', [sourceVersion, id])
      }
    })
    invalidateAssetQueryCache()
    if (immediate) flushDBNow()
    else flushDB()
    mainWindow?.webContents.send('ai:embeddedUpdated', uniqueIds)
  } catch (e) { console.error('[ai-embed] markAssetsEmbeddedIds error:', e) }
}

function getAiEligibleAssets() {
  if (!_db) return []
  return dbAll(
    `SELECT id, name, ext, filePath, size, mtime, hasThumb, aiEmbedded, aiEmbeddedVersion
       FROM assets WHERE deleted=0 ORDER BY importTime DESC`
  ).map(asset => {
    const ext = (asset.ext || '').toLowerCase()
    const sourcePath = AI_ORIGINAL_EXTS.has(ext) ? asset.filePath : thumbFilePath(asset.id)
    let sourceVersion = ''
    if (AI_ORIGINAL_EXTS.has(ext)) {
      sourceVersion = `${Math.round(Number(asset.mtime || 0))}:${Number(asset.size || 0)}`
    } else {
      try {
        const stat = fs.statSync(sourcePath)
        sourceVersion = `${Math.round(stat.mtimeMs)}:${stat.size}`
      } catch {}
    }
    return { ...asset, sourcePath, sourceVersion }
  }).filter(a => {
    const ext = (a.ext || '').toLowerCase()
    if (AI_ORIGINAL_EXTS.has(ext)) return !!a.filePath && fs.existsSync(a.filePath)
    return a.hasThumb === 1 && fs.existsSync(a.sourcePath)
  })
}

function getAiIndexStatus() {
  try {
    const assets = getAiEligibleAssets()
    cleanupLegacyAiStaging()
    const hasIndex = fs.existsSync(getAiIndexFile())
    if (!hasIndex && _db && assets.some(asset => asset.aiEmbedded === 1)) {
      dbRun("UPDATE assets SET aiEmbedded=0, aiEmbeddedVersion='' WHERE aiEmbedded=1 OR aiEmbeddedVersion<>''")
      invalidateAssetQueryCache()
      flushDB()
    }
    const indexed = hasIndex
      ? assets.filter(a => a.aiEmbedded === 1 && String(a.aiEmbeddedVersion || '') === a.sourceVersion).length
      : 0
    return {
      hasIndex,
      indexed,
      pending: assets.length - indexed,
      total: assets.length,
      running: isAiIndexingActive(),
      modelInstalled: aiModels.isInstalled('tipsv2'),
      indexPath: fs.existsSync(getAiIndexFile()) ? getAiIndexFile() : '',
    }
  } catch (e) {
    console.error('[ai-embed] getAiIndexStatus:', e)
    return { hasIndex: false, indexed: 0, pending: 0, total: 0, running: isAiIndexingActive() }
  }
}

function isAiIndexingActive() {
  return _aiIndexRunActive || !!_aiIndexProc
}

function finishAiIndexRun(generation = _aiIndexGeneration) {
  if (generation !== _aiIndexGeneration) return
  _aiIndexRunActive = false
  if (_aiIndexRerunRequested) {
    _aiIndexRerunRequested = false
    if (isAiEmbeddingEnabled()) scheduleAiIndexingForNewAssets(1, 'pending assets after current run')
  }
}

function scheduleAiIndexingForNewAssets(newAssetCount, reason = 'new assets') {
  if (!newAssetCount || newAssetCount <= 0) return
  _aiIndexScheduledCount += newAssetCount
  if (_aiIndexScheduleTimer) clearTimeout(_aiIndexScheduleTimer)
  _aiIndexScheduleTimer = setTimeout(() => {
    const count = _aiIndexScheduledCount
    _aiIndexScheduledCount = 0
    _aiIndexScheduleTimer = null
    if (isAiIndexingActive()) {
      _aiIndexRerunRequested = true
      console.log(`[ai-embed] Indexer already running; ${reason} will be picked up after the current run`)
      return
    }
    if (!isAiEmbeddingEnabled()) {
      console.log(`[ai-embed] Skipping incremental embedding for ${reason}; embedding is disabled`)
      return
    }
    console.log(`[ai-embed] Starting incremental embedding for ${count} ${reason}`)
    runAiIndexing().catch(e => console.error('[ai-embed] Incremental embed error:', e))
  }, 2000)
}

function scheduleAiIndexingForThumbnailAsset(id, reason = 'thumbnail-ready asset') {
  try {
    if (!_db || !id) return
    const asset = dbGet('SELECT id, ext, filePath, mtime, hasThumb, aiEmbedded, aiEmbeddedVersion, deleted FROM assets WHERE id=?', [id])
    if (!asset || asset.deleted === 1 || asset.hasThumb !== 1) return
    scheduleDinoIndexing(reason)
    const ext = (asset.ext || '').toLowerCase()
    if (AI_ORIGINAL_EXTS.has(ext)) return
    if (!fs.existsSync(thumbFilePath(id))) return
    const eligible = getAiEligibleAssets().find(item => item.id === id)
    if (eligible?.aiEmbedded === 1 && String(eligible.aiEmbeddedVersion || '') === eligible.sourceVersion) return
    scheduleAiIndexingForNewAssets(1, reason)
  } catch (e) {
    console.warn('[ai-embed] thumbnail-ready schedule failed:', e?.message || e)
  }
}

function isAiEmbeddingEnabled() {
  return aiModels.isInstalled('tipsv2') && loadSettings().aiEmbeddingEnabled === true
}

function clearAiIndexData() {
  try {
    _aiIndexGeneration += 1
    _aiIndexCancelled = true
    if (_aiIndexScheduleTimer) { clearTimeout(_aiIndexScheduleTimer); _aiIndexScheduleTimer = null }
    _aiIndexScheduledCount = 0
    _aiIndexRerunRequested = false
    if (_aiIndexProc) { _aiIndexProc.kill(); _aiIndexProc = null }
    _aiIndexRunActive = false
    for (const file of [getAiIndexFile(), getAiStateFile()]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch {}
    }
    cleanupLegacyAiStaging()
    if (_db) {
      dbRun("UPDATE assets SET aiEmbedded=0, aiEmbeddedVersion='' WHERE aiEmbedded=1 OR aiEmbeddedVersion<>''")
      invalidateAssetQueryCache()
      flushDBNow()
    }
    const status = getAiIndexStatus()
    mainWindow?.webContents.send('ai:indexProgress', { type: 'done', indexed: status.indexed, total: status.total, pending: status.pending })
    return { ok: true, status }
  } catch (e) {
    console.error('[ai-embed] clearAiIndexData error:', e)
    return { ok: false, error: e?.message || String(e) }
  }
}

async function runAiIndexing(options = {}) {
  if (_aiTaskPromise) return _aiTaskPromise
  _aiTaskPromise = aiTaskCoordinator.run('ai-embedding', () => runAiIndexingExclusive(options))
  try {
    return await _aiTaskPromise
  } finally {
    _aiTaskPromise = null
  }
}

async function runAiIndexingExclusive() {
  if (!aiModels.isInstalled('tipsv2')) {
    return { ok: false, error: 'model-not-installed', status: getAiIndexStatus() }
  }
  if (!isAiEmbeddingEnabled()) {
    const status = getAiIndexStatus()
    mainWindow?.webContents.send('ai:indexProgress', { type: 'done', indexed: status.indexed, total: status.total, pending: status.pending })
    return { ok: false, error: 'embedding-disabled', status }
  }
  if (isAiIndexingActive()) return { ok: false, error: 'already running' }
  const runGeneration = ++_aiIndexGeneration
  _aiIndexCancelled = false
  _aiIndexRunActive = true
  let handedToPython = false
  let manifestHandle = null
  try {
  if (!_db) await initDB()

  // SQLite is the source of truth. Python receives a small temporary manifest
  // containing stable asset ids, source paths, and source versions. Originals
  // are read directly; unsupported formats use Stag's existing thumbnails.
  const imageAssets = getAiEligibleAssets()
  const indexFile = getAiIndexFile()
  const pendingAssets = imageAssets.filter(asset =>
    asset.aiEmbedded !== 1 || String(asset.aiEmbeddedVersion || '') !== asset.sourceVersion)

  const total = imageAssets.length
  console.log(`[ai-embed] runAiIndexing: ${total} eligible image assets found, ${pendingAssets.length} pending`)

  const savedState = loadAiState()
  if (pendingAssets.length === 0 && fs.existsSync(indexFile) && Number(savedState.indexed) === total) {
    const status = getAiIndexStatus()
    mainWindow?.webContents.send('ai:indexProgress', { type: 'done', indexed: status.indexed, total: status.total, pending: status.pending })
    finishAiIndexRun(runGeneration)
    return { ok: true, skipped: true }
  }

  if (pendingAssets.length > 0) {
    const pendingIds = pendingAssets.map(a => a.id)
    const placeholders = pendingIds.map(() => '?').join(',')
    dbRun(`UPDATE assets SET aiEmbedded=0, aiEmbeddedVersion='' WHERE id IN (${placeholders})`, pendingIds)
    flushDB()
  }

  mainWindow?.webContents.send('ai:indexProgress', { type: 'converting', current: 0, total: pendingAssets.length, indexed: total - pendingAssets.length })
  const runIds = pendingAssets.map(asset => String(asset.id))
  const versionById = new Map(imageAssets.map(asset => [String(asset.id), asset.sourceVersion]))

  const indexedBeforeRun = Math.max(0, total - pendingAssets.length)
  mainWindow?.webContents.send('ai:indexProgress', {
    type: 'indexing',
    current: indexedBeforeRun,
    total,
  })

  const script = getPythonScript()
  if (!fs.existsSync(script)) {
    const message = `AI script not found: ${script}`
    console.error(`[ai-embed] ${message}`)
    mainWindow?.webContents.send('ai:indexProgress', { type: 'error', error: message })
    finishAiIndexRun(runGeneration)
    return { ok: false, error: message }
  }
  try {
    const stat = fs.existsSync(indexFile) ? fs.statSync(indexFile) : null
    if (stat && stat.size === 0) {
      const badPath = `${indexFile}.corrupt-${Date.now()}`
      fs.renameSync(indexFile, badPath)
      console.warn(`[ai-embed] Ignoring empty AI index; moved to ${badPath}`)
    }
  } catch (e) {
    console.warn('[ai-embed] Empty index preflight failed:', e?.message || e)
  }

  const { spawn } = require('child_process')
  const pythonBin = await getPythonBin()
  if (!pythonBin) {
    finishAiIndexRun(runGeneration)
    return { ok: false, error: 'python-runtime-missing' }
  }
  const manifest = createAiAssetManifest('tips-index', imageAssets)
  manifestHandle = manifest
  const proc = spawn(pythonBin, [
    script, 'index',
    '--manifest', manifest.path,
    '--index', indexFile,
    '--model', aiModels.getModelPath('tipsv2'),
    '--json-progress',
  ], { env: pythonEnvironment(pythonBin), windowsHide: true })
  _aiIndexProc = proc
  handedToPython = true

  let stdoutBuf = ''
  const failedThisRun = new Set()
  proc.stdout.on('data', chunk => {
    if (_aiIndexCancelled || runGeneration !== _aiIndexGeneration) return
    const text = chunk.toString()
    console.log(`[ai-embed] Python stdout: ${text.trim()}`)
    stdoutBuf += text
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop() || ''
    for (const line of lines) {
      const t = line.trim()
      if (!t || !t.startsWith('{')) continue
      try {
        const msg = JSON.parse(t)
        if (msg.type === 'progress') {
          const id = path.basename(String(msg.file || ''), '.jpg')
          if (id && runIds.includes(id)) {
            if (msg.embedded === false) failedThisRun.add(id)
            else {
              markAssetsEmbeddedIds([id], true, versionById)
            }
          }
          mainWindow?.webContents.send('ai:indexProgress', {
            type: 'indexing',
            current: Math.min(total, indexedBeforeRun + Number(msg.current || 0)),
            total,
            file: msg.file,
          })
        } else if (msg.type === 'scan') {
          mainWindow?.webContents.send('ai:indexProgress', {
            type: 'indexing',
            current: indexedBeforeRun,
            total,
          })
        } else if (msg.type === 'model_loading' || msg.type === 'model_ready') {
          mainWindow?.webContents.send('ai:indexProgress', msg)
        } else if (msg.type === 'done') {
          const state = { indexed: msg.totalInIndex ?? msg.indexed ?? 0, total }
          saveAiState(state)
          for (const f of (msg.failedFiles || [])) failedThisRun.add(path.basename(String(f), '.jpg'))
          markAssetsEmbeddedIds(runIds.filter(id => !failedThisRun.has(id)), true, versionById)
          mainWindow?.webContents.send('ai:indexProgress', { type: 'done', indexed: state.indexed, total })
        }
      } catch {}
    }
  })

  proc.stderr.on('data', c => {
    const text = c.toString().trim()
    if (text) console.log(`[ai-embed] Python stderr: ${text}`)
  })
  return await new Promise(resolve => {
    let settled = false
    const settle = result => {
      if (settled) return
      settled = true
      resolve(result)
    }
    proc.on('close', code => {
      manifest.cleanup()
      if (runGeneration !== _aiIndexGeneration) {
        settle({ ok: false, error: 'cancelled' })
        return
      }
      if (_aiIndexProc === proc) _aiIndexProc = null
      console.log(`[ai-embed] Python process exited with code ${code}`)
      if (code !== 0 && !_aiIndexCancelled) mainWindow?.webContents.send('ai:indexProgress', { type: 'error', code })
      else markAssetsEmbeddedIds(runIds.filter(id => !failedThisRun.has(id)), true, versionById)
      finishAiIndexRun(runGeneration)
      settle(code === 0 ? { ok: true } : { ok: false, error: _aiIndexCancelled ? 'cancelled' : `AI indexer exited ${code}` })
    })
    proc.on('error', e => {
      manifest.cleanup()
      if (runGeneration !== _aiIndexGeneration) {
        settle({ ok: false, error: 'cancelled' })
        return
      }
      if (_aiIndexProc === proc) _aiIndexProc = null
      console.error(`[ai-embed] Python spawn error: ${e.message}`)
      if (!_aiIndexCancelled) mainWindow?.webContents.send('ai:indexProgress', { type: 'error', error: e.message })
      finishAiIndexRun(runGeneration)
      settle({ ok: false, error: e.message })
    })
  })
  } catch (e) {
    if (!handedToPython) manifestHandle?.cleanup()
    if (!handedToPython) finishAiIndexRun(runGeneration)
    if (_aiIndexCancelled) return { ok: false, error: 'cancelled' }
    throw e
  }
}

ipcMain.handle('ai:startIndexing', async () => {
  console.log('[ai-embed] startIndexing called, running:', isAiIndexingActive())
  if (isAiIndexingActive()) return { ok: false, error: 'already running' }
  if (!isAiEmbeddingEnabled()) return { ok: false, error: 'embedding-disabled', status: getAiIndexStatus() }
  runAiIndexing().catch(e => {
    console.error('[ai-embed] fatal error in runAiIndexing:', e)
    mainWindow?.webContents.send('ai:indexProgress', { type: 'error', error: e?.message || String(e) })
  })
  return { ok: true }
})

ipcMain.handle('ai:getIndexStatus', () => getAiIndexStatus())

ipcMain.handle('ai:getEmbeddingEnabled', () => isAiEmbeddingEnabled())

ipcMain.handle('ai:setEmbeddingEnabled', (_ev, enabled) => {
  const settings = loadSettings()
  const next = !!enabled
  if (next && !aiModels.isInstalled('tipsv2')) {
    return { ok: false, error: 'model-not-installed', enabled: false, status: getAiIndexStatus() }
  }
  saveSettings({ ...settings, aiEmbeddingEnabled: next })
  if (!next) {
    _aiIndexGeneration += 1
    _aiIndexCancelled = true
    if (_aiIndexProc) {
      try { _aiIndexProc.kill() } catch {}
      _aiIndexProc = null
    }
    stopAiSearchWorker('embedding-disabled')
    if (_aiIndexScheduleTimer) { clearTimeout(_aiIndexScheduleTimer); _aiIndexScheduleTimer = null }
    _aiIndexScheduledCount = 0
    _aiIndexRerunRequested = false
    _aiIndexRunActive = false
    const status = { ...getAiIndexStatus(), running: false }
    mainWindow?.webContents.send('ai:indexProgress', { type: 'cancelled', status })
  }
  const result = { ok: true, enabled: next, status: getAiIndexStatus(), features: broadcastAiFeatureStatus() }
  return result
})

ipcMain.handle('ai:deleteIndex', async () => {
  if (!_db) await initDB()
  stopAiSearchWorker('index-deleted')
  return clearAiIndexData()
})

ipcMain.handle('ai:reindexAll', async () => {
  if (!aiModels.isInstalled('tipsv2')) return { ok: false, error: 'model-not-installed' }
  if (!_db) await initDB()
  stopAiSearchWorker('index-rebuilding')
  saveSettings({ ...loadSettings(), aiEmbeddingEnabled: true })
  const cleared = clearAiIndexData()
  if (!cleared.ok) return cleared
  runAiIndexing().catch(e => {
    console.error('[ai-embed] fatal error in reindexAll:', e)
    mainWindow?.webContents.send('ai:indexProgress', { type: 'error', error: e?.message || String(e) })
  })
  return { ok: true, status: getAiIndexStatus() }
})

ipcMain.handle('ai:warmSearch', () => startAiSearchWorker())

ipcMain.handle('ai:stopSearch', () => {
  stopAiSearchWorker()
  return { ok: true }
})

ipcMain.handle('ai:search', async (_ev, query, topK = 20) => {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'empty-query', assetIds: [] }
  const indexFile = getAiIndexFile()
  if (!fs.existsSync(indexFile)) return { ok: false, error: 'not-indexed', assetIds: [] }
  const ready = await startAiSearchWorker()
  if (!ready?.ok || !_aiSearchProc?.stdin?.writable) {
    return { ok: false, error: ready?.error || 'search-worker-unavailable', assetIds: [] }
  }

  return new Promise(resolve => {
    const id = ++_aiSearchRequestId
    const timer = setTimeout(() => {
      _aiSearchRequests.delete(id)
      resolve({ ok: false, error: 'search-timeout', assetIds: [] })
    }, 30000)
    _aiSearchRequests.set(id, { resolve, timer })
    _aiSearchProc.stdin.write(`${JSON.stringify({ id, query: q, topK })}\n`, error => {
      if (!error) return
      const pending = _aiSearchRequests.get(id)
      if (!pending) return
      _aiSearchRequests.delete(id)
      clearTimeout(timer)
      pending.resolve({ ok: false, error: error.message, assetIds: [] })
    })
  })
})

ipcMain.handle('ai:imageSearch', async (_ev, imagePath, topK = 20) => {
  const queryPath = String(imagePath || '').trim()
  if (!queryPath || !fs.existsSync(queryPath)) return { ok: false, error: 'query-image-not-found', assetIds: [] }
  const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'])
  if (!allowed.has(path.extname(queryPath).toLowerCase())) return { ok: false, error: 'unsupported-query-image', assetIds: [] }
  if (!isDinoImageIndexEnabled()) return { ok: false, error: 'dinov3-index-disabled', assetIds: [] }
  const indexed = await ensureDinoIndex()
  if (!indexed?.ok) return { ok: false, error: indexed?.error || 'dinov3-index-failed', assetIds: [] }
  const ready = await startDinoSearchWorker()
  if (!ready?.ok || !_dinoSearchProc?.stdin?.writable) {
    return { ok: false, error: ready?.error || 'dinov3-worker-unavailable', assetIds: [] }
  }

  return new Promise(resolve => {
    const id = ++_dinoSearchRequestId
    const timer = setTimeout(() => {
      _dinoSearchRequests.delete(id)
      resolve({ ok: false, error: 'search-timeout', assetIds: [] })
    }, 60000)
    _dinoSearchRequests.set(id, { resolve, timer })
    _dinoSearchProc.stdin.write(`${JSON.stringify({ id, imagePath: queryPath, topK })}\n`, error => {
      if (!error) return
      const pending = _dinoSearchRequests.get(id)
      if (!pending) return
      _dinoSearchRequests.delete(id)
      clearTimeout(timer)
      pending.resolve({ ok: false, error: error.message, assetIds: [] })
    })
  })
})

ipcMain.handle('ai:getImageIndexStatus', async () => {
  if (!_db) await initDB()
  return getDinoIndexStatus()
})

ipcMain.handle('ai:startImageIndexing', async () => {
  if (!_db) await initDB()
  if (!isDinoImageIndexEnabled()) return { ok: false, error: 'dinov3-index-disabled', status: getDinoIndexStatus() }
  ensureDinoIndex().catch(error => sendDinoProgress({ type: 'error', error: error?.message || String(error) }))
  return { ok: true, status: getDinoIndexStatus() }
})

ipcMain.handle('ai:setImageIndexEnabled', async (_event, enabled) => {
  const next = !!enabled
  if (next && !aiModels.isInstalled('dinov3')) {
    return { ok: false, error: 'model-not-installed', enabled: false, status: getDinoIndexStatus() }
  }
  saveSettings({
    ...loadSettings(),
    dinoImageIndexEnabled: next,
    dinoImageIndexUserConfigured: true,
  })
  if (!next) {
    if (_dinoIndexScheduleTimer) { clearTimeout(_dinoIndexScheduleTimer); _dinoIndexScheduleTimer = null }
    _dinoIndexRerunRequested = false
    stopDinoIndexing('DINOv3 indexing disabled')
    stopDinoSearchWorker('DINOv3 image search disabled')
  } else {
    scheduleDinoIndexing('DINOv3 indexing enabled')
  }
  return { ok: true, enabled: next, status: getDinoIndexStatus(), features: broadcastAiFeatureStatus() }
})

ipcMain.handle('ai:deleteImageIndex', async () => {
  if (!_db) await initDB()
  if (_dinoIndexPromise) {
    stopDinoIndexing('DINOv3 index deletion requested')
    await _dinoIndexPromise.catch(() => {})
  }
  return clearDinoIndexData()
})

ipcMain.handle('ai:reindexImageAll', async () => {
  if (!aiModels.isInstalled('dinov3')) return { ok: false, error: 'model-not-installed' }
  if (!_db) await initDB()
  if (_dinoIndexPromise) {
    stopDinoIndexing('DINOv3 reindex requested')
    await _dinoIndexPromise.catch(() => {})
  }
  saveSettings({
    ...loadSettings(),
    dinoImageIndexEnabled: true,
    dinoImageIndexUserConfigured: true,
  })
  const cleared = clearDinoIndexData()
  if (!cleared.ok) return cleared
  ensureDinoIndex().catch(error => {
    sendDinoProgress({ type: 'error', error: error?.message || String(error) })
  })
  return { ok: true, status: getDinoIndexStatus() }
})

ipcMain.handle('ai:warmImageSearch', async () => {
  const result = await startDinoSearchWorker()
  return { ...result, status: getDinoIndexStatus() }
})

ipcMain.handle('ai:stopImageSearch', () => {
  stopDinoSearchWorker()
  return { ok: true, status: getDinoIndexStatus() }
})

ipcMain.handle('ai:getFeatureStatus', async () => {
  if (!_db) await initDB()
  return getAiFeatureStatus()
})

ipcMain.handle('ai:downloadModel', async (_event, feature) => {
  const modelFeature = String(feature || '')
  const wasInstalled = aiModels.isInstalled(modelFeature)
  const result = await aiModels.download(modelFeature)
  if (result.ok && !wasInstalled) {
    if (modelFeature === 'tipsv2') {
      if (!_db) await initDB()
      stopAiSearchWorker('model-installed')
      clearAiIndexData()
    } else if (modelFeature === 'dinov3') {
      stopDinoSearchWorker('model-installed')
      try { fs.rmSync(getDinoIndexDir(), { recursive: true, force: true }) } catch {}
    }
  }
  const features = broadcastAiFeatureStatus()
  return { ...result, features }
})

ipcMain.handle('ai:cancelModelDownload', (_event, feature) => {
  return { ok: aiModels.cancel(String(feature || '')) }
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  createTray()
  createWindow()

  setTimeout(async () => {
    const started = Date.now()
    console.log('[Startup] database initialization starting')
    await initDB()
    migrateFromJSON()
    migrateThumbRetry()   // reset hasThumb for formats the old code failed on
    migrateThumbRetryV4() // reset hasThumb for pdf/epub now that thumbnails are supported
    migrateThumbRetryV5() // reset hasThumb for jpe/jfif/hif/icns/tga/dds/eps/m2ts/heic/heif
    migrateThumbRetryV7() // reset pdf/ico after stronger macOS fallback generation
    migrateThumbRetryV8() // reset pdf/ico after ICO Chromium decode and large-PDF support
    migrateThumbQualityV6() // regenerate older thumbnails with higher dimensions/quality
    reconcileMissingThumbnailFiles()
    console.log(`[Startup] database ready in ${Date.now() - started}ms`)
    loadStartupAssetPage()

    setTimeout(() => {
      console.log('[Startup] local bridge/web grab servers starting')
      startBridgeServer()
      startWebGrabServers()
    }, 10000)

    setTimeout(() => {
      console.log('[Startup] inbox watcher starting')
      startInboxWatcher()
    }, 14000)

    setTimeout(async () => {
      console.log('[Startup] inbox/import folder scans starting')
      await scanInboxOnStartup()
      await scanImportCopyOnStartup()
      rebuildDirWatchers()
    }, 22000)

    setTimeout(async () => {
      console.log('[Startup] FTS backfill starting')
      ensureAssetFtsBackfilled()
    }, 30000)

    setTimeout(async () => {
      console.log('[Startup] EXIF thumbnail orientation migration starting')
      await migrateOrientedImageThumbsV9()
      runThumbWorker()
    }, 34000)

    setTimeout(async () => {
      console.log('[Startup] thumbnail maintenance starting')
      await migrateThumbsToWebP()
      ensureExistingThumbVariants().catch(e => console.warn('[Thumb] variant backfill failed:', e.message))
    }, 38000)

    setTimeout(() => {
      console.log('[Startup] missing thumbnail worker starting')
      runThumbWorker()
    }, 52000)

    setTimeout(() => {
      if (_thumbQualityRefreshRows.length) {
        console.log('[Startup] thumbnail quality refresh starting')
        runThumbQualityRefresh()
      }
    }, 65000)
  }, 50)

  // Auto-start AI image embedding after startup maintenance has had room to breathe.
  setTimeout(async () => {
    await initDB()
    if (!isAiEmbeddingEnabled()) {
      console.log('[ai-embed] Auto-start skipped because embedding is disabled')
      return
    }
    console.log('[ai-embed] Auto-starting background embedding on app launch')
    runAiIndexing().catch(e => console.error('[ai-embed] Auto-start error:', e))
  }, 30000)

  setTimeout(async () => {
    await initDB()
    if (!isDinoImageIndexEnabled()) {
      console.log('[dino-search] Auto-start skipped because image indexing is disabled')
      return
    }
    console.log('[dino-search] Auto-starting background image indexing on app launch')
    ensureDinoIndex().catch(e => console.error('[dino-search] Auto-start error:', e))
  }, 34000)
})

app.on('before-quit', () => {
  forceQuit = true
  stopAiSearchWorker('app-quitting')
  closeDB()
})

app.on('window-all-closed', () => {
  // Only actually quit if forceQuit — otherwise keep running as tray app
  if (forceQuit) {
    closeDB()
    for (const s of _webGrabServers) { try { s.close() } catch {} }
    if (process.platform !== 'darwin') app.quit()
  }
})

app.on('activate', () => {
  restoreMainWindow('activate')
})

// ── IPC: Window ───────────────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:maximize', () => { if (!mainWindow) return; mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize() })
ipcMain.handle('window:close',    () => mainWindow?.close())

// ── IPC: Dialogs ──────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFiles', async () => {
  if (!mainWindow) return []
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'All Supported', extensions: [
      'jpg','jpeg','jpe','jfif','png','gif','webp','svg','bmp','tiff','tif','ico','avif','heic','heif','hif','icns','tga','dds','eps',
      'mp4','webm','mov','avi','mkv','m4v','f4v','ts','mts','m2ts','mpg','mpeg','flv','wmv','rmvb','3gp',
      'mp3','wav','flac','aac','m4a','ogg','opus','wma',
      'pdf','psd','ai','sketch','xd','fig','eps','ttf','otf','woff','woff2',
      'glb','gltf','obj','fbx','stl','dae','blend','3ds','ply',
      'txt','md','json','csv','xml','html','css','js','ts','py','sh',
      'doc','docx','xls','xlsx','ppt','pptx','epub','zip','rar','7z',
    ]}],
  })
  return res.canceled ? [] : res.filePaths
})
ipcMain.handle('dialog:openSearchImage', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an image to search with',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif'] }],
  })
  return result.canceled ? null : result.filePaths[0]
})
ipcMain.handle('dialog:selectDirectory', async () => { if (!mainWindow) return null; const r = await dialog.showOpenDialog(mainWindow, { title: 'Select Library Location', properties: ['openDirectory','createDirectory'] }); return r.canceled ? null : r.filePaths[0] })
ipcMain.handle('dialog:selectDestFolder',async () => { if (!mainWindow) return null; const r = await dialog.showOpenDialog(mainWindow, { title: 'Send Files To…', properties: ['openDirectory','createDirectory'] }); return r.canceled ? null : r.filePaths[0] })

// ── IPC: File system ──────────────────────────────────────────────────────────
ipcMain.handle('fs:copyFiles',   async (_ev, srcs, destDir) => { const res=[]; for(const src of srcs){try{fs.copyFileSync(src,path.join(destDir,path.basename(src)));res.push({src,ok:true})}catch(e){res.push({src,ok:false,error:String(e)})}}; return res })
ipcMain.handle('fs:getFileInfo', (_ev, p) => { try{const s=fs.statSync(p);return{size:s.size,mtime:s.mtimeMs,btime:s.birthtimeMs}}catch{return null} })
ipcMain.handle('fs:dirname',     (_ev, p) => { try{return path.dirname(String(p || ''))}catch{return''} })
ipcMain.handle('fs:duplicateFile', async (_ev, srcPath) => {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'File not found' }
    const parsed = path.parse(srcPath)
    let index = 1
    let destPath
    do {
      const suffix = index === 1 ? ' copy' : ` copy ${index}`
      destPath = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`)
      index += 1
    } while (fs.existsSync(destPath))
    await fs.promises.copyFile(srcPath, destPath)
    const stat = await fs.promises.stat(destPath)
    return { ok: true, filePath: destPath, name: path.basename(destPath, parsed.ext), size: stat.size, mtime: stat.mtimeMs, btime: stat.birthtimeMs }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
})
ipcMain.handle('fs:renameAssetFile', async (_ev, id, filePath, rawName, ext) => {
  let nextPath = ''
  let renamed = false
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
    const name = String(rawName || '').trim()
    if (!name || /[<>:"/\\|?*\u0000-\u001f]/.test(name)) return { ok: false, error: 'Filename contains invalid characters' }
    const suffix = ext ? `.${String(ext).replace(/^\./, '')}` : path.extname(filePath)
    nextPath = path.join(path.dirname(filePath), `${name}${suffix}`)
    if (path.resolve(nextPath) === path.resolve(filePath)) return { ok: true, filePath }
    if (fs.existsSync(nextPath)) return { ok: false, error: 'A file with that name already exists' }
    await fs.promises.rename(filePath, nextPath)
    renamed = true
    if (_db && id) {
      dbRun('UPDATE assets SET name=?, filePath=? WHERE id=?', [name, nextPath, id])
      invalidateAssetQueryCache()
      flushDB()
    }
    setImmediate(rebuildDirWatchers)
    return { ok: true, filePath: nextPath }
  } catch (error) {
    if (renamed && nextPath) {
      try { await fs.promises.rename(nextPath, filePath) } catch {}
    }
    return { ok: false, error: error?.message || String(error) }
  }
})
ipcMain.handle('fs:readText',    async (_ev, filePath, maxBytes=50000) => { try{const st=await fs.promises.stat(filePath);const buf=await fs.promises.readFile(filePath);return{text:buf.slice(0,maxBytes).toString('utf-8'),size:st.size,truncated:st.size>maxBytes}}catch(e){return{text:null,error:String(e)}} })
ipcMain.handle('fs:writeText',   async (_ev, id, filePath, text) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
    if (typeof text !== 'string') return { ok: false, error: 'Invalid text content' }
    await fs.promises.writeFile(filePath, text, 'utf8')
    const stat = await fs.promises.stat(filePath)
    if (_db && id) {
      dbRun('UPDATE assets SET size=?, mtime=? WHERE id=?', [stat.size, stat.mtimeMs, id])
      invalidateAssetQueryCache()
      flushDB()
    }
    return { ok: true, size: stat.size, mtime: stat.mtimeMs }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
})
ipcMain.handle('fs:readBinary',  async (_ev, filePath) => { try{const st=await fs.promises.stat(filePath);if(st.size>200*1024*1024)return null;return(await fs.promises.readFile(filePath)).toString('base64')}catch{return null} })
ipcMain.handle('fs:getFileUrl',  (_ev, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null
    return require('url').pathToFileURL(filePath).href
  } catch {
    return null
  }
})
ipcMain.handle('print:currentView', async (event) => {
  const contents = event.sender
  if (!contents || contents.isDestroyed()) return { ok: false, error: 'Preview window is unavailable' }
  return await new Promise(resolve => {
    contents.print({ silent: false, printBackground: true }, (success, failureReason) => {
      resolve(success ? { ok: true } : { ok: false, error: failureReason || 'Printing was cancelled' })
    })
  })
})
// ── IPC: Shell / drag ─────────────────────────────────────────────────────────
ipcMain.handle('shell:openPath',     (_ev, p) => shell.openPath(p))
ipcMain.handle('shell:getOpenWithApps', async (_ev, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
  if (process.platform !== 'darwin') return { ok: true, apps: [], useSystemChooser: true }
  try {
    const { execFile } = require('child_process')
    const script = `
      ObjC.import('AppKit');
      const fileURL = $.NSURL.fileURLWithPath(${JSON.stringify(filePath)});
      const urls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL(fileURL);
      const apps = [];
      for (let index = 0; index < urls.count; index += 1) {
        const appPath = ObjC.unwrap(urls.objectAtIndex(index).path);
        apps.push({ path: appPath, name: appPath.split('/').pop().replace(/\\.app$/, '') });
      }
      JSON.stringify(apps);
    `
    const output = await new Promise((resolve, reject) => {
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 10000 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
    const apps = JSON.parse(String(output || '[]'))
    const readApplicationIcon = async applicationPath => {
      try {
        const resourcesDir = path.join(applicationPath, 'Contents', 'Resources')
        const infoPath = path.join(applicationPath, 'Contents', 'Info.plist')
        const iconName = await new Promise(resolve => {
          execFile('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', infoPath], { timeout: 3000 }, (_error, stdout) => {
            resolve(String(stdout || '').trim())
          })
        })
        const candidates = []
        if (iconName) {
          candidates.push(path.join(resourcesDir, iconName))
          if (!iconName.toLowerCase().endsWith('.icns')) candidates.push(path.join(resourcesDir, `${iconName}.icns`))
        }
        try {
          for (const name of fs.readdirSync(resourcesDir)) {
            if (name.toLowerCase().endsWith('.icns')) candidates.push(path.join(resourcesDir, name))
          }
        } catch {}
        for (const candidate of [...new Set(candidates)]) {
          if (!fs.existsSync(candidate)) continue
          try {
            const { Icns } = require('@fiahfy/icns')
            const images = Icns.from(fs.readFileSync(candidate)).images
              .map(entry => nativeImage.createFromBuffer(entry.image))
              .filter(image => !image.isEmpty())
              .sort((left, right) => {
                const leftSize = left.getSize()
                const rightSize = right.getSize()
                return (rightSize.width * rightSize.height) - (leftSize.width * leftSize.height)
              })
            if (images[0]) {
              return images[0].resize({ width: 32, height: 32, quality: 'best' }).toDataURL()
            }
          } catch (error) {
            console.warn(`[Open With] Could not decode icon ${candidate}:`, error?.message || error)
          }
        }
        const fallback = await app.getFileIcon(applicationPath, { size: 'normal' })
        return fallback.isEmpty() ? '' : fallback.toDataURL()
      } catch {
        return ''
      }
    }
    const withIcons = await Promise.all(apps.map(async application => {
      return { ...application, icon: await readApplicationIcon(application.path) }
    }))
    return { ok: true, apps: withIcons }
  } catch (error) {
    return { ok: true, apps: [], useSystemChooser: true, error: error?.message || String(error) }
  }
})
ipcMain.handle('shell:openWith', async (_ev, filePath, application) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
  try {
    const { spawn } = require('child_process')
    if (process.platform === 'darwin' && application) {
      spawn('open', ['-a', application, filePath], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true }
    }
    if (process.platform === 'win32') {
      spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', filePath], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return { ok: true }
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open With',
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: process.platform === 'darwin'
        ? [{ name: 'Applications', extensions: ['app'] }]
        : [{ name: 'Applications', extensions: ['desktop', 'bin'] }],
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
    spawn(result.filePaths[0], [filePath], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
})
ipcMain.handle('shell:openExternalUrl', (_ev, rawUrl) => {
  const url = parseWebsiteUrl(rawUrl)
  if (!url) return false
  return shell.openExternal(url).then(() => true).catch(() => false)
})

async function openUrlInDefaultBrowser(rawUrl) {
  const url = String(rawUrl || '')
  if (!parseWebsiteUrl(url)) throw new Error('Invalid external URL')
  const { execFile } = require('child_process')

  if (process.platform === 'darwin') {
    console.log(`[External Browser] calling: /usr/bin/open ${url}`)
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/open', [url], { timeout: 10000 }, (error, stdout, stderr) => {
        if (stdout) console.log(`[External Browser] stdout: ${String(stdout).trim()}`)
        if (stderr) console.warn(`[External Browser] stderr: ${String(stderr).trim()}`)
        if (error) reject(error)
        else resolve()
      })
    })
    console.log('[External Browser] /usr/bin/open completed successfully')
    return
  }

  console.log(`[External Browser] calling: shell.openExternal ${url}`)
  await shell.openExternal(url)
  console.log('[External Browser] shell.openExternal completed successfully')
}

ipcMain.handle('shell:showInFolder', (_ev, p) => shell.showItemInFolder(p))
ipcMain.handle('shell:shareFiles', async (_ev, filePaths) => {
  const paths = Array.isArray(filePaths)
    ? filePaths.filter(p => typeof p === 'string' && p && fs.existsSync(p))
    : []
  if (!paths.length) return { ok: false, error: 'No files to share' }
  if (process.platform !== 'darwin' || !ShareMenu) {
    return { ok: false, unsupported: true }
  }
  try {
    const shareMenu = new ShareMenu({ filePaths: paths })
    shareMenu.popup({ window: mainWindow || undefined })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})
ipcMain.handle('shell:exportFile', async (_ev, srcPath) => {
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'File not found' }
  const name = path.basename(srcPath)
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Asset',
    defaultPath: path.join(app.getPath('downloads'), name),
    buttonLabel: 'Export',
  })
  if (canceled || !filePath) return { ok: false }
  try {
    fs.copyFileSync(srcPath, filePath)
    return { ok: true, dest: filePath }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})
ipcMain.handle('shell:exportImageAs', async (_ev, srcPath, options = {}) => {
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'File not found' }
  const format = ['png', 'jpeg', 'webp', 'tiff'].includes(String(options.format)) ? String(options.format) : 'png'
  const extension = format === 'jpeg' ? 'jpg' : format
  const parsed = path.parse(srcPath)
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Image',
    defaultPath: path.join(app.getPath('downloads'), `${parsed.name}.${extension}`),
    buttonLabel: 'Export',
    filters: [{ name: format.toUpperCase(), extensions: [extension] }],
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  if (!getSharp()) return { ok: false, error: 'Image conversion is unavailable' }
  try {
    let image = _sharp(srcPath, { animated: false, limitInputPixels: false })
    const width = Math.max(0, Number(options.width) || 0)
    const height = Math.max(0, Number(options.height) || 0)
    if (width || height) {
      const fit = options.fit === 'fill' && width && height ? 'fill' : 'inside'
      image = image.resize(width || null, height || null, { fit, withoutEnlargement: false })
    }
    if (format === 'jpeg') image = image.flatten({ background: '#ffffff' }).jpeg({ quality: 92 })
    else if (format === 'webp') image = image.webp({ quality: 92 })
    else if (format === 'tiff') image = image.tiff({ quality: 92 })
    else image = image.png()
    await image.toFile(filePath)
    return { ok: true, dest: filePath }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
})
async function writeImagePathToClipboard(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false
    let image = nativeImage.createFromPath(filePath)
    if (image.isEmpty() && getSharp()) {
      const png = await _sharp(filePath, { animated: false, limitInputPixels: false }).png().toBuffer()
      image = nativeImage.createFromBuffer(png)
    }
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  } catch {
    return false
  }
}
ipcMain.handle('clipboard:writeAsset', async (_ev, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return false
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (IMAGE_EXTS.has(ext) || ['tga', 'dds', 'heic', 'heif', 'avif'].includes(ext)) {
    return writeImagePathToClipboard(filePath)
  }
  clipboard.writeText(filePath)
  return true
})
ipcMain.handle('clipboard:writeThumbnail', async (_ev, id) => {
  return writeImagePathToClipboard(thumbFilePath(String(id || '')))
})
ipcMain.handle('shell:googleImageSearch', async (_ev, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' }
  let lensWindow = null
  let cleanupPath = null
  let keepLensWindow = false
  try {
    let uploadPath = filePath
    const sourceExt = path.extname(filePath).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(sourceExt) && getSharp()) {
      cleanupPath = path.join(app.getPath('temp'), `stag-lens-${Date.now()}.jpg`)
      await _sharp(filePath, { animated: false, limitInputPixels: false })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 94 })
        .toFile(cleanupPath)
      uploadPath = cleanupPath
    }
    lensWindow = new BrowserWindow({
      show: false,
      width: 1180,
      height: 820,
      parent: mainWindow || undefined,
      title: 'Google Lens',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    lensWindow.webContents.setWindowOpenHandler(({ url }) => {
      const safeUrl = parseWebsiteUrl(url)
      if (safeUrl) {
        console.log(`[Google Lens] opening link in default browser: ${safeUrl}`)
        openUrlInDefaultBrowser(safeUrl).catch(error => {
          console.error('[Google Lens] could not open result link:', error?.message || error)
        })
      }
      return { action: 'deny' }
    })
    const lensStartUrl = 'https://www.google.com/?olud'
    console.log(`[Google Lens] browser load: ${lensStartUrl}`)
    lensWindow.webContents.on('did-start-navigation', (_event, url, _sameDocument, isMainFrame) => {
      if (isMainFrame) console.log(`[Google Lens] browser navigation: ${url}`)
    })
    lensWindow.webContents.on('will-redirect', (_event, url, _sameDocument, isMainFrame) => {
      if (isMainFrame) console.log(`[Google Lens] browser redirect: ${url}`)
    })
    await lensWindow.loadURL(lensStartUrl)
    console.log(`[Google Lens] browser loaded: ${lensWindow.webContents.getURL()}`)

    const debug = lensWindow.webContents.debugger
    debug.attach('1.3')
    await debug.sendCommand('DOM.enable')
    await debug.sendCommand('Runtime.enable')

    const initialDocument = await debug.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
    const triggerNode = await debug.sendCommand('DOM.querySelector', {
      nodeId: initialDocument.root.nodeId,
      selector: '[aria-label="Search by image"][role="button"]',
    })
    if (!triggerNode.nodeId) {
      throw new Error('Google Lens search control was not available')
    }
    await debug.sendCommand('DOM.scrollIntoViewIfNeeded', { nodeId: triggerNode.nodeId })
    const triggerBox = await debug.sendCommand('DOM.getBoxModel', { nodeId: triggerNode.nodeId })
    const quad = triggerBox.model?.border || triggerBox.model?.content
    if (!quad?.length) throw new Error('Google Lens search control could not be activated')
    const triggerX = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
    const triggerY = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: triggerX, y: triggerY, button: 'left', clickCount: 1 })
    await debug.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: triggerX, y: triggerY, button: 'left', clickCount: 1 })
    await new Promise(resolve => setTimeout(resolve, 300))
    console.log('[Google Lens] opened Search by image panel')

    let inputNodeId = 0
    for (let attempt = 0; attempt < 40 && !inputNodeId; attempt += 1) {
      const { root } = await debug.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
      const found = await debug.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'input[type="file"][name="encoded_image"]',
      })
      inputNodeId = found.nodeId || 0
      if (!inputNodeId) await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!inputNodeId) throw new Error('Google Lens upload control was not available')

    // Google can navigate to its result URL immediately after the file input
    // changes, so observation must be active before the file is attached.
    const resultUrlPromise = new Promise((resolve, reject) => {
      let settled = false
      let lastObservedUrl = ''
      const finish = (error, url) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        clearInterval(poll)
        lensWindow?.webContents?.removeListener('did-navigate', onNavigate)
        lensWindow?.webContents?.removeListener('did-navigate-in-page', onNavigate)
        lensWindow?.webContents?.removeListener('will-redirect', onRedirect)
        if (error) reject(error)
        else resolve(url)
      }
      const inspectUrl = url => {
        if (url !== lastObservedUrl) {
          lastObservedUrl = url
          console.log(`[Google Lens] browser current URL: ${url}`)
        }
        if (!url || url.includes('?olud') || url.includes('/upload')) return
        if (!url.includes('lens.google.com') && !url.includes('google.com/search')) return
        finish(null, url)
      }
      const onNavigate = (_event, url) => inspectUrl(url)
      const onRedirect = (_event, url, _sameDocument, isMainFrame) => {
        if (isMainFrame) inspectUrl(url)
      }
      lensWindow.webContents.on('did-navigate', onNavigate)
      lensWindow.webContents.on('did-navigate-in-page', onNavigate)
      lensWindow.webContents.on('will-redirect', onRedirect)
      const poll = setInterval(() => {
        if (!lensWindow || lensWindow.isDestroyed()) {
          finish(new Error('Google Lens window was closed'))
          return
        }
        inspectUrl(lensWindow.webContents.getURL())
      }, 250)
      const timeout = setTimeout(() => {
        finish(new Error(`Google Lens upload timed out at ${lensWindow?.webContents?.getURL() || 'unknown URL'}`))
      }, 30000)
    })

    console.log(`[Google Lens] attaching image: ${uploadPath}`)
    await debug.sendCommand('DOM.setFileInputFiles', { files: [uploadPath], nodeId: inputNodeId })
    const dispatchResult = await debug.sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const input = document.querySelector('input[type="file"][name="encoded_image"]');
        if (!input || !input.files || input.files.length === 0) {
          return { dispatched: false, files: input?.files?.length || 0 };
        }
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return { dispatched: true, files: input.files.length };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    const dispatchState = dispatchResult?.result?.value
    if (!dispatchState?.dispatched) {
      throw new Error('Google Lens did not accept the selected image')
    }
    console.log(`[Google Lens] image selection dispatched (${dispatchState.files} file)`)

    const resultUrl = await resultUrlPromise
    console.log(`[Google Lens] showing session-bound result: ${resultUrl}`)
    keepLensWindow = true
    lensWindow.show()
    lensWindow.focus()
    return { ok: true, url: resultUrl, inApp: true }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  } finally {
    try {
      if (lensWindow?.webContents?.debugger?.isAttached()) lensWindow.webContents.debugger.detach()
    } catch {}
    if (cleanupPath) fs.promises.unlink(cleanupPath).catch(() => {})
    if (!keepLensWindow && lensWindow && !lensWindow.isDestroyed()) lensWindow.destroy()
  }
})
ipcMain.handle('shell:exportContactSheet', async (_ev, dataUrl, defaultName = 'Stag Contact Sheet.png') => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return { ok: false, error: 'Invalid contact sheet data' }
  }
  const safeName = String(defaultName || 'Stag Contact Sheet.png').replace(/[<>:"/\\|?*]+/g, '-')
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Contact Sheet',
    defaultPath: path.join(app.getPath('downloads'), safeName.endsWith('.png') ? safeName : `${safeName}.png`),
    buttonLabel: 'Export',
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  })
  if (canceled || !filePath) return { ok: false }
  try {
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'))
    return { ok: true, dest: filePath }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})
// ── Drag helpers ──────────────────────────────────────────────────────────────
// IMPORTANT: never load the actual asset file as the icon — for large files
// (100 MB video, raw image) nativeImage.createFromPath blocks the main thread
// during sendSync and causes a hang / silent failure. Only load thumbnail paths.
//
// Always returns a valid non-empty NativeImage. Electron requires a non-empty
// icon on all platforms; empty or missing icon = silent startDrag failure.
const _DRAG_FALLBACK_ICON = (() => {
  // 1×1 grey pixel — tiny, always loads, guaranteed non-empty
  try {
    const img = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg=='
    )
    if (!img.isEmpty()) return img
  } catch {}
  // nativeImage.createFromDataURL failed — shouldn't happen, but guard anyway
  return nativeImage.createEmpty()
})()

function buildDragIconFromThumb(thumbPath) {
  if (!thumbPath) return _DRAG_FALLBACK_ICON
  try {
    const img = nativeImage.createFromPath(thumbPath)
    if (!img.isEmpty()) {
      const { width, height } = img.getSize()
      if (width > 0 && height > 0) {
        const scale = Math.min(64 / width, 64 / height, 1)
        return img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
      }
    }
  } catch {}
  return _DRAG_FALLBACK_ICON
}

ipcMain.on('drag:start', (ev, p) => {
  try {
    if (p && fs.existsSync(p)) {
      // No thumb path — use fallback icon (do NOT load the asset file itself)
      ev.sender.startDrag({ file: p, files: [p], icon: _DRAG_FALLBACK_ICON })
    } else {
      console.warn('[drag] file not found:', p)
    }
  } catch (e) { console.error('[drag] startDrag error:', e) }
  ev.returnValue = null
})
ipcMain.on('drag:startMulti', (ev, arr) => {
  try {
    const valid = (arr || []).filter(p => p && fs.existsSync(p))
    if (valid.length >= 1) {
      ev.sender.startDrag({ file: valid[0], files: valid, icon: _DRAG_FALLBACK_ICON })
    } else {
      console.warn('[drag] no valid files in multi-drag:', arr)
    }
  } catch (e) { console.error('[drag] startDragMulti error:', e) }
  ev.returnValue = null
})
ipcMain.on('drag:startWithIcon', (ev, p, thumbPath) => {
  try {
    if (p && fs.existsSync(p)) {
      ev.sender.startDrag({ file: p, files: [p], icon: buildDragIconFromThumb(thumbPath) })
    } else {
      console.warn('[drag] file not found:', p)
    }
  } catch (e) { console.error('[drag] startDragWithIcon error:', e) }
  ev.returnValue = null
})
ipcMain.on('drag:startMultiWithIcon', (ev, arr, thumbPath) => {
  try {
    const valid = (arr || []).filter(p => p && fs.existsSync(p))
    if (valid.length >= 1) {
      ev.sender.startDrag({ file: valid[0], files: valid, icon: buildDragIconFromThumb(thumbPath) })
    } else {
      console.warn('[drag] no valid files:', arr)
    }
  } catch (e) { console.error('[drag] startDragMultiWithIcon error:', e) }
  ev.returnValue = null
})

// ── IPC: Thumbnails ───────────────────────────────────────────────────────────
ipcMain.handle('metadata:readBatch', async (_ev, items) => {
  const started = Date.now()
  const list = Array.isArray(items) ? items : []
  thumbLog('metadata:batch:start', { count: list.length })
  const results = await Promise.all(list.map(async ({ id, filePath, ext }) => {
    const itemStarted = Date.now()
    const name = path.basename(filePath || '')
    try {
      if (!getSharp() || !filePath || !IMAGE_EXTS.has((ext || '').toLowerCase())) return { id }
      const stat = await fs.promises.stat(filePath).catch(() => null)
      if (!stat || !stat.isFile()) return { id }
      const meta = await _sharp(filePath, { animated: false, limitInputPixels: false }).metadata()
      const width = meta.width || 0
      const height = meta.height || 0
      if (width > 0 && height > 0) {
        thumbLog('metadata:item:done', { id, name, ext, width, height, ms: Date.now() - itemStarted })
        return { id, width, height }
      }
      return { id }
    } catch (e) {
      thumbLog('metadata:item:failed', { id, name, ext, message: e?.message || String(e), ms: Date.now() - itemStarted })
      return { id }
    }
  }))
  thumbLog('metadata:batch:done', { count: list.length, withDimensions: results.filter(r => r?.width && r?.height).length, ms: Date.now() - started })
  return results
})

// ── IPC: SQLite ops ───────────────────────────────────────────────────────────

ipcMain.handle('db:load', async (_ev, options) => {
  await initDB()
  return dbLoadAll(options)
})

ipcMain.handle('db:queryAssets', async (_ev, options) => {
  await initDB()
  return dbQueryAssets(options)
})

ipcMain.handle('db:startupAssets', async () => {
  const cached = readStartupAssetCache()
  if (cached?.assets?.length) {
    if (!_db) {
      setTimeout(() => {
        initDB()
          .then(() => loadStartupAssetPage({ writeCache: true }))
          .catch(e => console.warn('[Startup] background cache refresh failed:', e?.message || e))
      }, 0)
    }
    return cached
  }
  await initDB()
  return _startupAssetPage || loadStartupAssetPage()
})

ipcMain.handle('db:counts', async (_ev, options) => {
  await initDB()
  return dbCountAssets(options)
})

ipcMain.handle('jobs:create', async (_ev, type, payload = {}, total = 0) => {
  await initDB()
  return createJob(type, payload, total)
})

ipcMain.handle('jobs:update', async (_ev, id, updates = {}) => {
  await initDB()
  return updateJob(id, updates)
})

ipcMain.handle('db:insertAsset', (_ev, asset) => {
  if (!_db) return false
  try {
    dbTransaction(() => {
      dbRun(`INSERT OR IGNORE INTO assets (id,name,ext,filePath,size,width,height,duration,mtime,btime,importTime,rating,notes,url,deleted,deletedAt,hasThumb)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [asset.id, asset.name, asset.ext, asset.filePath,
         asset.size||0, asset.width||null, asset.height||null, asset.duration||null,
         asset.mtime||0, asset.btime||0, asset.importTime||Date.now(),
         asset.rating||0, asset.notes||'', asset.url||'',
         asset.deleted?1:0, asset.deletedAt||null, asset.hasThumb?1:0])
      writeRelations(asset)
    })
    invalidateAssetQueryCache()
    flushDB()
    // Rebuild dir watchers to include any new directories
    setImmediate(rebuildDirWatchers)
    return true
  } catch (e) { console.error('[DB] insertAsset:', e); return false }
})

ipcMain.handle('db:batchInsertAssets', (_ev, assets) => {
  if (!_db) return false
  try {
    dbTransaction(() => {
      for (const asset of (assets || [])) {
        dbRun(`INSERT OR IGNORE INTO assets (id,name,ext,filePath,size,width,height,duration,mtime,btime,importTime,rating,notes,url,deleted,deletedAt,hasThumb)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [asset.id, asset.name, asset.ext, asset.filePath,
           asset.size||0, asset.width||null, asset.height||null, asset.duration||null,
           asset.mtime||0, asset.btime||0, asset.importTime||Date.now(),
           asset.rating||0, asset.notes||'', asset.url||'',
           asset.deleted?1:0, asset.deletedAt||null, asset.hasThumb?1:0])
        writeRelations(asset)
      }
    })
    invalidateAssetQueryCache()
    flushDB()
    // Trigger AI embedding for newly imported images (2s delay so import UI settles)
    const newImageCount = (assets || []).filter(a => AI_ORIGINAL_EXTS.has((a.ext||'').toLowerCase()) || a.hasThumb).length
    scheduleAiIndexingForNewAssets(newImageCount, 'newly imported assets')
    if ((assets || []).length > 0) scheduleDinoIndexing('newly imported assets')
    return true
  } catch (e) { console.error('[DB] batchInsertAssets:', e); return false }
})

ipcMain.handle('db:getThumbState', async (_ev, ids) => {
  if (!_db || !Array.isArray(ids) || ids.length === 0) return []
  try {
    const out = []
    for (const id of ids) {
      const row = dbGet('SELECT id, width, height, hasThumb FROM assets WHERE id=? AND deleted=0', [id])
      if (!row?.hasThumb) continue
      const tp = thumbFilePath(id)
      if (!fs.existsSync(tp)) continue
      out.push({
        id,
        thumbUrl: fileUrl(tp),
        thumbnailVariants: thumbVariantUrls(id),
        width: row.width ?? undefined,
        height: row.height ?? undefined,
      })
    }
    return out
  } catch (e) {
    console.error('[DB] getThumbState:', e)
    return []
  }
})

ipcMain.handle('db:saveThumbnail', async (_ev, id, dataUrl, options = {}) => {
  try {
    const base64 = dataUrl.startsWith('data:') ? dataUrl.split(',')[1] : dataUrl
    const saved = await saveThumbnailBuffer(id, Buffer.from(base64, 'base64'), options)
    if (_db) {
      dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
      invalidateAssetQueryCache()
      flushDB()
      scheduleAiIndexingForThumbnailAsset(id, 'saved thumbnail')
    }
    return saved
  } catch (e) { console.error('[DB] saveThumbnail:', e); return null }
})

function parseWebsiteUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

async function prepareWebsiteForCapture(webContents) {
  const settleScript = `
    (async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      const maxScroll = Math.min(pageHeight, window.innerHeight * 8);
      const step = Math.max(320, Math.floor(window.innerHeight * 0.75));
      for (let y = 0; y < maxScroll; y += step) {
        window.scrollTo(0, y);
        await sleep(220);
      }
      window.scrollTo(0, 0);
      await sleep(350);
      if (document.fonts?.ready) await Promise.race([document.fonts.ready, sleep(2500)]);
      const pending = Array.from(document.images || []).filter(image => !image.complete);
      await Promise.race([
        Promise.all(pending.map(image => new Promise(resolve => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        }))),
        sleep(4500)
      ]);
      await sleep(700);
      return {
        readyState: document.readyState,
        imageCount: document.images?.length || 0,
        pendingImages: Array.from(document.images || []).filter(image => !image.complete).length
      };
    })()
  `
  try {
    return await webContents.executeJavaScript(settleScript, true)
  } catch {
    await new Promise(resolve => setTimeout(resolve, 2500))
    return null
  }
}

ipcMain.handle('website:captureThumbnail', async (_ev, id, rawUrl) => {
  const url = parseWebsiteUrl(rawUrl)
  if (!id || !url) return { ok: false, error: 'Invalid website URL' }

  let captureWindow = null
  try {
    captureWindow = new BrowserWindow({
      show: false,
      width: 1365,
      height: 768,
      backgroundColor: '#ffffff',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    })
    captureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const loadResult = await Promise.race([
      captureWindow.loadURL(url).then(() => ({ loaded: true })).catch(error => ({ loaded: false, error })),
      new Promise(resolve => setTimeout(() => resolve({ loaded: false, timedOut: true }), 20000)),
    ])
    if (captureWindow.isDestroyed()) throw new Error('Website capture window closed')

    if (!loadResult.loaded && loadResult.error) throw loadResult.error
    if (!loadResult.loaded && loadResult.timedOut) {
      await Promise.race([
        new Promise(resolve => captureWindow.webContents.once('did-stop-loading', resolve)),
        new Promise(resolve => setTimeout(resolve, 7000)),
      ])
    }

    const loadState = await prepareWebsiteForCapture(captureWindow.webContents)
    mainLog.info({ url, loadState }, 'website ready for thumbnail capture')
    const image = await captureWindow.webContents.capturePage()
    if (!image || image.isEmpty()) throw loadError || new Error('Website returned an empty preview')

    const size = image.getSize()
    const saved = await saveThumbnailBuffer(id, image.toPNG(), { variantMode: 'async' })
    if (_db) {
      dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [size.width, size.height, id])
      invalidateAssetQueryCache()
      flushDB()
      scheduleAiIndexingForThumbnailAsset(id, 'website thumbnail')
    }
    return {
      ok: true,
      url,
      title: captureWindow.webContents.getTitle() || url,
      thumbUrl: saved.thumbUrl,
      thumbnailVariants: saved.thumbnailVariants,
      width: size.width,
      height: size.height,
    }
  } catch (error) {
    console.warn('[Website] thumbnail capture failed:', error?.message || error)
    return { ok: false, error: String(error?.message || error || 'Website capture failed') }
  } finally {
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy()
  }
})

ipcMain.handle('db:updateAsset', (_ev, id, updates) => {
  if (!_db) return false
  try {
    let updated = false
    dbTransaction(() => {
      const cur = dbGet('SELECT * FROM assets WHERE id=?', [id])
      if (!cur) return
      dbRun(`UPDATE assets SET name=?,filePath=?,rating=?,notes=?,url=?,width=?,height=?,duration=?,deleted=?,deletedAt=?,hasThumb=? WHERE id=?`,
        [updates.name??cur.name, updates.filePath??cur.filePath, updates.rating??cur.rating, updates.notes??cur.notes, updates.url??cur.url,
         updates.width??cur.width, updates.height??cur.height, updates.duration??cur.duration,
         (updates.deleted!==undefined?updates.deleted:cur.deleted===1)?1:0,
         updates.deletedAt??cur.deletedAt,
         (updates.hasThumb!==undefined?updates.hasThumb:cur.hasThumb===1)?1:0,
         id])
      if (updates.tags       !== undefined) { dbRun('DELETE FROM asset_tags    WHERE assetId=?',[id]); for(const t of updates.tags){dbRun('INSERT OR IGNORE INTO asset_tags(assetId,tag)VALUES(?,?)',[id,t]);dbRun('INSERT OR IGNORE INTO tags(tag)VALUES(?)',[t])} }
      if (updates.folders    !== undefined) { dbRun('DELETE FROM asset_folders WHERE assetId=?',[id]); for(const f of updates.folders)dbRun('INSERT OR IGNORE INTO asset_folders(assetId,folderId)VALUES(?,?)',[id,f]) }
      if (updates.colors     !== undefined) { dbRun('DELETE FROM asset_colors  WHERE assetId=?',[id]); for(let i=0;i<updates.colors.length;i++)dbRun('INSERT INTO asset_colors(assetId,hex,ratio,sortOrder)VALUES(?,?,?,?)',[id,updates.colors[i].hex,updates.colors[i].ratio,i]) }
      if (updates.annotation !== undefined) { dbRun('DELETE FROM asset_annotations WHERE assetId=?',[id]); for(const a of updates.annotation)dbRun('INSERT OR REPLACE INTO asset_annotations(id,assetId,x,y,label)VALUES(?,?,?,?,?)',[a.id,id,a.x,a.y,a.label]) }
      upsertAssetFts(id)
      updated = true
    })
    if (!updated) return false
    invalidateAssetQueryCache()
    flushDB()
    return true
  } catch (e) { console.error('[DB] updateAsset:', e); return false }
})

ipcMain.handle('db:batchUpdate', (_ev, ops) => {
  if (!_db) return false
  try {
    dbTransaction(() => {
      for (const { id, updates } of ops) {
        const cur = dbGet('SELECT * FROM assets WHERE id=?', [id]); if (!cur) continue
        dbRun(`UPDATE assets SET deleted=?,deletedAt=? WHERE id=?`,
          [(updates.deleted!==undefined?updates.deleted:cur.deleted===1)?1:0, updates.deletedAt??cur.deletedAt, id])
      }
    })
    invalidateAssetQueryCache()
    flushDB()
    return true
  } catch (e) { console.error('[DB] batchUpdate:', e); return false }
})

// Permanently delete source files and their library records after explicit confirmation.
ipcMain.handle('db:hardDeleteAssetsFromDisk', async (_ev, ids) => {
  if (!_db) return false
  try {
    _suppressWatcher = true
    const failed = []
    const CHUNK = 20
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      for (const id of chunk) {
        let row = null
        try { row = dbGet('SELECT filePath FROM assets WHERE id=?', [id]) } catch {}
        if (row?.filePath) {
          try {
            await fs.promises.unlink(row.filePath)
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              failed.push({ id, filePath: row.filePath, error: String(error) })
              continue
            }
          }
        }
        dbTransaction(() => {
          dbRun('DELETE FROM asset_tags        WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_folders     WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_colors      WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_annotations WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_fts         WHERE assetId=?', [id])
          dbRun('DELETE FROM assets            WHERE id=?',      [id])
        })
        deleteThumbnailFiles(id)
      }
      await new Promise(r => setImmediate(r))
    }
    invalidateAssetQueryCache()
    flushDB()
    return { ok: failed.length === 0, failed }
  } catch (e) { console.error('[DB] hardDeleteFromDisk:', e); return false }
  finally { setTimeout(() => { _suppressWatcher = false }, 500) }
})

// Show a delete confirmation dialog: returns true (delete from disk) or null (cancel).
ipcMain.handle('dialog:showDeleteOptions', async (_ev, { message }) => {
  if (!mainWindow) return null
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Delete Files',
    message: message || 'Delete these files?',
    buttons: ['Delete from Disk', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  if (response === 0) return true    // delete from disk
  return null                        // cancelled
})

ipcMain.handle('db:upsertFolder', (_ev, f) => {
  if (!_db) return false
  try {
    dbRun('INSERT OR REPLACE INTO folders (id,name,parentId,color,icon,sortOrder) VALUES (?,?,?,?,?,?)',
      [f.id, f.name, f.parentId??null, f.color, f.icon, f.sortOrder||0])
    dbRun('DELETE FROM folder_autotags WHERE folderId=?', [f.id])
    for (const t of (f.autoTags||[])) dbRun('INSERT OR IGNORE INTO folder_autotags(folderId,tag)VALUES(?,?)',[f.id,t])
    flushDB(); return true
  } catch (e) { console.error(e); return false }
})

ipcMain.handle('db:deleteFolder', (_ev, id) => {
  if (!_db) return false
  try {
    dbRun('DELETE FROM folder_autotags WHERE folderId=?', [id])
    dbRun('DELETE FROM asset_folders   WHERE folderId=?', [id])
    dbRun('DELETE FROM folders WHERE id=? OR parentId=?', [id, id])
    flushDB(); return true
  } catch (e) { console.error(e); return false }
})

ipcMain.handle('db:upsertSmartFolder', (_ev, sf) => {
  if (!_db) return false
  try { dbRun('INSERT OR REPLACE INTO smart_folders(id,name,logic,rules)VALUES(?,?,?,?)',[sf.id,sf.name,sf.logic,JSON.stringify(sf.rules)]); flushDB(); return true }
  catch (e) { console.error(e); return false }
})
ipcMain.handle('db:deleteSmartFolder', (_ev, id) => {
  if (!_db) return false
  try { dbRun('DELETE FROM smart_folders WHERE id=?',[id]); flushDB(); return true }
  catch (e) { console.error(e); return false }
})

ipcMain.handle('db:addTag',    (_ev, tag) => { if(!_db)return false; try{dbRun('INSERT OR IGNORE INTO tags(tag)VALUES(?)',[tag]);flushDB();return true}catch{return false} })
ipcMain.handle('db:deleteTag', (_ev, tag) => {
  if (!_db) return false
  try { dbRun('DELETE FROM asset_tags WHERE tag=?',[tag]); dbRun('DELETE FROM tags WHERE tag=?',[tag]); flushDB(); return true }
  catch (e) { console.error(e); return false }
})
ipcMain.handle('db:deleteAllTags', () => {
  if (!_db) return false
  try {
    dbRun('DELETE FROM asset_tags')
    dbRun('DELETE FROM tags')
    flushDB()
    return true
  } catch (e) {
    console.error('[DB] deleteAllTags:', e)
    return false
  }
})

function isNestedPath(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function listFilesRecursively(rootDir) {
  const files = []
  const pending = [rootDir]
  while (pending.length) {
    const dir = pending.pop()
    let entries = []
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) pending.push(fullPath)
      else if (entry.isFile()) files.push(fullPath)
    }
  }
  return files
}

function uniqueMigrationDestination(destination) {
  if (!fs.existsSync(destination)) return destination
  const extension = path.extname(destination)
  const stem = path.basename(destination, extension)
  const parent = path.dirname(destination)
  let index = 1
  let candidate = destination
  while (fs.existsSync(candidate)) candidate = path.join(parent, `${stem}_${index++}${extension}`)
  return candidate
}

async function moveManagedFile(source, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.promises.rename(source, destination)
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES'].includes(error?.code)) throw error
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
    await fs.promises.unlink(source)
  }
}

async function removeEmptyManagedDirectories(rootDir) {
  if (!fs.existsSync(rootDir)) return
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyManagedDirectories(path.join(rootDir, entry.name))
  }
  const remaining = await fs.promises.readdir(rootDir)
  if (remaining.length === 0) await fs.promises.rmdir(rootDir).catch(() => {})
}

let _managedFolderMigrationQueue = Promise.resolve()
function queueManagedFolderMigration(settingKey, requestedPath) {
  const next = _managedFolderMigrationQueue
    .catch(() => {})
    .then(() => migrateManagedFolder(settingKey, requestedPath))
  _managedFolderMigrationQueue = next.then(() => undefined, () => undefined)
  return next
}

async function migrateManagedFolder(settingKey, requestedPath) {
  const defaults = getDefaultManagedPaths()
  const defaultPath = settingKey === 'webGrabPath' ? defaults.webGrabDir : defaults.localGrabDir
  const settings = loadSettings()
  const source = path.resolve(settings[settingKey] || defaultPath)
  const destination = path.resolve(String(requestedPath || '').trim() || defaultPath)
  if (source === destination) return { ok: true, path: destination, migrated: 0 }
  if (isNestedPath(destination, source) || isNestedPath(source, destination)) {
    return { ok: false, error: 'Choose a folder outside the current managed folder.' }
  }

  await initDB()
  await fs.promises.mkdir(destination, { recursive: true })
  const sourceFiles = await listFilesRecursively(source)
  const moved = []
  let settingSaved = false
  let dbCommitted = false
  _suppressWatcher = true
  if (settingKey === 'webGrabPath' && _inboxWatcher) {
    try { _inboxWatcher.close() } catch {}
    _inboxWatcher = null
  }

  try {
    for (const sourceFile of sourceFiles) {
      const relative = path.relative(source, sourceFile)
      const destinationFile = uniqueMigrationDestination(path.join(destination, relative))
      await moveManagedFile(sourceFile, destinationFile)
      moved.push({ source: sourceFile, destination: destinationFile })
    }

    settings[settingKey] = destination
    delete settings.importCopyEnabled
    delete settings.libraryPath
    if (!saveSettings(settings)) throw new Error('Could not save the managed-folder location.')
    settingSaved = true
    dbTransaction(() => {
      for (const item of moved) {
        dbRun('UPDATE assets SET filePath=? WHERE filePath=?', [item.destination, item.source])
      }
    })
    dbCommitted = true
    await removeEmptyManagedDirectories(source).catch(error => {
      mainLog.warn({ error, source }, 'managed-folder migration left empty source directories behind')
    })
    invalidateAssetQueryCache()
    flushDB()
    rebuildDirWatchers()
    return { ok: true, path: destination, migrated: moved.length }
  } catch (error) {
    if (dbCommitted) {
      mainLog.warn({ error, source, destination }, 'managed-folder migration completed with a cleanup warning')
      return { ok: true, path: destination, migrated: moved.length, warning: String(error) }
    }
    if (settingSaved) {
      settings[settingKey] = source
      saveSettings(settings)
    }
    for (const item of moved.reverse()) {
      try { await moveManagedFile(item.destination, item.source) } catch {}
    }
    return { ok: false, error: String(error) }
  } finally {
    _suppressWatcher = false
    if (settingKey === 'webGrabPath') setImmediate(restartInboxWatcher)
  }
}

// ── IPC: Settings / misc ──────────────────────────────────────────────────────
ipcMain.handle('settings:load',           ()       => loadSettings())
ipcMain.handle('settings:save', (_ev, incoming) => {
  // Managed paths are changed only through migration handlers.
  let existing = {}
  try { existing = loadSettings() || {} } catch {}
  const webGrabPath = existing.webGrabPath
  const importCopyPath = existing.importCopyPath
  const managedAiSettings = {
    aiEmbeddingEnabled: existing.aiEmbeddingEnabled,
    dinoImageIndexEnabled: existing.dinoImageIndexEnabled,
    dinoImageIndexUserConfigured: existing.dinoImageIndexUserConfigured,
  }
  const toWrite = { ...existing, ...(incoming || {}), ...managedAiSettings }
  if (webGrabPath) toWrite.webGrabPath = webGrabPath
  else delete toWrite.webGrabPath
  if (importCopyPath) toWrite.importCopyPath = importCopyPath
  else delete toWrite.importCopyPath
  delete toWrite.importCopyEnabled
  delete toWrite.libraryPath
  saveSettings(toWrite)
  nativeTheme.themeSource = toWrite.theme === 'light' ? 'light' : 'dark'
  if (_db) broadcastAiFeatureStatus()
  return true
})
ipcMain.handle('runtime:getStatus', () => runtimeDependencies.getStatus())
ipcMain.handle('runtime:checkInternet', () => runtimeDependencies.checkInternet())
ipcMain.handle('ai:acquireTask', async (event, name) => {
  const release = await aiTaskCoordinator.acquire(`tagging:${String(name || 'queue')}`)
  if (event.sender.isDestroyed()) {
    release()
    return { ok: false, error: 'renderer-closed' }
  }
  const token = crypto.randomUUID()
  const releaseOnce = () => {
    const current = _rendererAiTaskReleases.get(token)
    if (!current) return
    _rendererAiTaskReleases.delete(token)
    current()
  }
  _rendererAiTaskReleases.set(token, release)
  event.sender.once('destroyed', releaseOnce)
  return { ok: true, token }
})
ipcMain.handle('ai:releaseTask', (_event, token) => {
  const release = _rendererAiTaskReleases.get(String(token || ''))
  if (!release) return false
  _rendererAiTaskReleases.delete(String(token))
  release()
  return true
})
ipcMain.handle('runtime:install', async () => {
  const result = await runtimeDependencies.ensureAi()
  if (result.ok) {
    refreshManagedToolPaths()
    _pythonBinPromise = null
    _dinoPythonBinPromise = null
    await initDB()
    reconcileMissingThumbnailFiles()
    setImmediate(() => runThumbWorker())
  }
  return result
})
ipcMain.handle('runtime:reinstall', async () => {
  const result = await runtimeDependencies.ensureAi({ force: true })
  if (result.ok) {
    refreshManagedToolPaths()
    _pythonBinPromise = null
    _dinoPythonBinPromise = null
    await initDB()
    reconcileMissingThumbnailFiles()
    setImmediate(() => runThumbWorker())
    if (_db) broadcastAiFeatureStatus()
  }
  return result
})
ipcMain.handle('app:getPlatform',         ()       => process.platform)
ipcMain.handle('app:getCpuCount',         ()       => require('os').cpus().length)
ipcMain.handle('bridge:getPort',          ()       => BRIDGE_PORT)
ipcMain.handle('watchers:rebuild',        ()       => { setImmediate(rebuildDirWatchers); return true })
ipcMain.handle('bridge:getWebGrabPath',   ()       => getInboxDir())

// Copy files to the configured import-copy folder.
// Uses fs.promises.copyFile (OS-native CopyFileEx on Windows) for speed,
// runs up to CONCURRENCY copies in parallel, polls dest file sizes for progress.
ipcMain.handle('importCopy:copyFiles', async (_ev, filePaths, jobId = null) => {
  const runCopySession = async () => {
  const s = loadSettings()
  const destDir = s.importCopyPath || getDefaultManagedPaths().localGrabDir
  if (!fs.existsSync(destDir)) {
    try { fs.mkdirSync(destDir, { recursive: true }) } catch (e) { return { ok: false, reason: String(e) } }
  }

  const CONCURRENCY = Math.min(Math.max(1, s.threads ?? 4), filePaths.length)
  const total = filePaths.length
  const emit = (data) => { try { mainWindow?.webContents.send('importCopy:progress', data) } catch {} }
  const copyJobId = jobId || createJob('copy', { destDir, fileCount: total }, total)
  if (copyJobId) updateJob(copyJobId, { status: 'running', total, message: 'Copying files' })

  // ── Build copy plan (resolve destination paths, handle name conflicts) ────────
  const plan = filePaths.map(src => {
    const base = path.basename(src)
    let destFile = path.join(destDir, base)
    if (fs.existsSync(destFile) && path.resolve(src) !== path.resolve(destFile)) {
      const ext2 = path.extname(base)
      const stem = path.basename(base, ext2)
      let idx = 1
      while (fs.existsSync(destFile)) { destFile = path.join(destDir, `${stem}_${idx++}${ext2}`) }
    }
    const needsCopy = path.resolve(src) !== path.resolve(destFile)
    let size = 0
    if (needsCopy) { try { size = fs.statSync(src).size } catch {} }
    return { src, destFile, needsCopy, size, done: false }
  })

  const totalBytes = plan.reduce((s, p) => s + p.size, 0)
  let completedFiles = 0

  // ── Poll destination file sizes for progress (no stream overhead) ─────────────
  const pollTimer = setInterval(() => {
    let bytesDone = 0
    let currentName = ''
    for (const item of plan) {
      if (!item.needsCopy || item.done) { bytesDone += item.size; continue }
      try { bytesDone += Math.min(fs.statSync(item.destFile).size, item.size) } catch {}
      if (!currentName) currentName = path.basename(item.src)
    }
    emit({ jobId: copyJobId || undefined, status: 'running', fileIndex: completedFiles, total, fileName: currentName, bytesDone, bytesTotal: totalBytes })
    if (copyJobId) updateJob(copyJobId, { status: 'running', current: completedFiles, total, message: currentName || 'Copying files' })
  }, 120)

  const results = []

  // ── Concurrent copy workers — each drains the shared plan queue ───────────────
  let qi = 0
  const worker = async () => {
    while (qi < plan.length) {
      const item = plan[qi++]   // safe: JS is single-threaded, qi++ is atomic
      try {
        if (item.needsCopy) await fs.promises.copyFile(item.src, item.destFile)
        item.done = true
        completedFiles++
        results.push({ src: item.src, dest: item.destFile, ok: true })
      } catch (e) {
        item.done = true
        completedFiles++
        results.push({ src: item.src, dest: null, ok: false, error: String(e) })
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  clearInterval(pollTimer)
  if (copyJobId) updateJob(copyJobId, { status: 'completed', current: completedFiles, total, message: 'Copy completed' })
  emit(null)
  return { ok: true, results, jobId: copyJobId }
  }
  const previous = _importCopyQueue.catch(() => {})
  const queued = previous.then(runCopySession)
  _importCopyQueue = queued.then(() => undefined, () => undefined)
  return queued
})
ipcMain.handle('bridge:setWebGrabPath', (_ev, folderPath) =>
  queueManagedFolderMigration('webGrabPath', folderPath))
ipcMain.handle('importCopy:setPath', (_ev, folderPath) =>
  queueManagedFolderMigration('importCopyPath', folderPath))

// ── IPC: Video duration via ffprobe ──────────────────────────────────────────
// Used by the renderer's mpegts.js player to enable full-length seeking on .ts files.
ipcMain.handle('video:getDuration', async (_ev, filePath) => {
  const ms = await _ffprobeGetDuration(filePath)
  return ms ? Math.round(ms * 1000) : null  // returns milliseconds or null
})

// ── IPC: Ollama AI tagging ─────────────────────────────────────────────────────
// Node.js 18+ resolves 'localhost' to ::1 (IPv6) by default, but Ollama binds
// to 127.0.0.1 (IPv4). Fix: always swap localhost → 127.0.0.1 in the URL.
function normalizeOllamaUrl(raw) {
  const base = (raw || 'http://localhost:11434').trim().replace(/\/$/, '')
  return base.replace(/\/\/localhost(:|$|\/)/i, '//127.0.0.1$1')
}
// All HTTP calls to Ollama happen in the main process (no CORS issues, logging available)
const _ollamaPullControllers = new Map()

ipcMain.handle('ollama:checkConnection', async (_ev, baseUrl) => {
  const url = normalizeOllamaUrl(baseUrl)
  if (isDev) console.log('[Ollama] Checking connection to:', url)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = await res.json()
    // Return models with size info so UI can show details
    const models = (data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      family: m.details?.family || '',
      paramSize: m.details?.parameter_size || '',
    })).filter(m => m.name)
    if (isDev) console.log('[Ollama] Connected. Found', models.length, 'models:', models.map(m => m.name).join(', ') || '(none)')
    return { ok: true, models: models.map(m => m.name), modelDetails: models }
  } catch (e) {
    const msg = String(e.message || e)
    if (isDev) console.log('[Ollama] Connection failed:', msg)
    const friendly = msg.includes('ECONNREFUSED') || msg.includes('fetch failed')
      ? `Cannot reach Ollama at ${url} — is it running? (ollama serve)`
      : msg
    return { ok: false, error: friendly }
  }
})

ipcMain.handle('ollama:getModels', async (_ev, baseUrl) => {
  const url = normalizeOllamaUrl(baseUrl)
  if (isDev) console.log('[Ollama] Fetching models from:', url)
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal })
    if (!res.ok) return []
    const data = await res.json()
    const names = (data.models || []).map((m) => m.name).filter(Boolean)
    if (isDev) console.log('[Ollama] Models:', names.join(', ') || '(none)')
    return names
  } catch (e) {
    if (isDev) console.log('[Ollama] getModels failed:', String(e.message || e))
    return []
  }
})

ipcMain.handle('ollama:pullModel', async (_ev, modelName, baseUrl) => {
  const name = String(modelName || '').trim()
  if (!name) return { ok: false, error: 'model-name-required' }
  if (_ollamaPullControllers.has(name)) return { ok: false, error: 'download-in-progress' }
  const url = normalizeOllamaUrl(baseUrl)
  const controller = new AbortController()
  _ollamaPullControllers.set(name, controller)
  try {
    const response = await fetch(`${url}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) return { ok: false, error: `HTTP ${response.status}` }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const progress = JSON.parse(line)
          mainWindow?.webContents.send('ollama:modelPullProgress', {
            model: name,
            status: progress.status,
            completed: Number(progress.completed || 0),
            total: Number(progress.total || 0),
          })
          if (progress.error) throw new Error(progress.error)
        } catch (error) {
          if (line.trim().startsWith('{')) throw error
        }
      }
    }
    mainWindow?.webContents.send('ollama:modelPullProgress', { model: name, status: 'done', done: true })
    return { ok: true, model: name }
  } catch (error) {
    const cancelled = error?.name === 'AbortError'
    mainWindow?.webContents.send('ollama:modelPullProgress', {
      model: name,
      status: cancelled ? 'cancelled' : 'error',
      error: cancelled ? 'cancelled' : String(error?.message || error),
    })
    return { ok: false, error: cancelled ? 'cancelled' : String(error?.message || error) }
  } finally {
    _ollamaPullControllers.delete(name)
  }
})

// Tag a single image — returns { ok: true, tags, description } or { ok: false, error, fatal }
// fatal=true means connection is down (stop entire session), false means skip this image
ipcMain.handle('ollama:tagImage', async (_ev, filePath, model, baseUrl) => {
  if (isDev) console.log(`[Ollama] Tagging: ${path.basename(filePath)} model=${model}`)
  try {
    const result = await runNodeWorker('aiTagWorker.js', {
      type: 'tag',
      filePath,
      model,
      baseUrl,
    }, { timeoutMs: 120000 })
    if (isDev && result?.ok) console.log(`[Ollama] ✓ ${path.basename(filePath)} → [${(result.tags || []).join(', ')}]`)
    return result
  } catch (e) {
    const msg = String(e.message || e)
    const fatal = msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('abort') || msg.includes('network')
    if (isDev) console.log(`[Ollama] ✗ ${path.basename(filePath)}: ${msg} (fatal=${fatal})`)
    return { ok: false, error: msg, fatal }
  }
})

// DB: mark asset as AI-tagged (stores description + merges tags)
ipcMain.handle('db:setAiTagged', async (_ev, id, description, newTags) => {
  try {
    if (!_db) await initDB()
    if (!dbGet('SELECT id FROM assets WHERE id=?', [id])) return false
    dbTransaction(() => {
      dbRun('UPDATE assets SET aiTagged=1, aiDescription=? WHERE id=?', [description || '', id])
      for (const tag of (newTags || [])) {
        dbRun('INSERT OR IGNORE INTO asset_tags (assetId,tag) VALUES (?,?)', [id, tag])
        dbRun('INSERT OR IGNORE INTO tags (tag) VALUES (?)', [tag])
      }
      upsertAssetFts(id)
    })
    invalidateAssetQueryCache()
    flushDB()
    return true
  } catch (e) { console.error('[DB] setAiTagged:', e); return false }
})

// Prepare a full-size preview PNG for formats Chromium cannot render directly.
// Converts at original resolution — no resize. Cached as {id}_preview.png.
// Returns { url: 'file://...' } or null on failure.
ipcMain.handle('preview:prepare', async (_ev, id, filePath, ext) => {
  try {
    const previewPath = path.join(getDataDir(), 'thumbs', id.slice(0, 2), id + '_preview.png')
    if (!fs.existsSync(path.join(getDataDir(), 'thumbs', id.slice(0, 2)))) {
      fs.mkdirSync(path.join(getDataDir(), 'thumbs', id.slice(0, 2)), { recursive: true })
    }

    // Return cached preview if already exists
    if (fs.existsSync(previewPath)) {
      return { url: 'file://' + previewPath.replace(/\\/g, '/') }
    }

    let pngBuf = null

    // TIFF/TIF — sharp handles natively
    if (ext === 'tiff' || ext === 'tif') {
      if (getSharp()) {
        pngBuf = await _sharp(filePath, { pages: 1, limitInputPixels: false }).png().toBuffer()
      }
    }

    // HEIC/HEIF/HIF — try sharp, then heic-convert
    if (!pngBuf && (ext === 'heic' || ext === 'heif' || ext === 'hif')) {
      if (getSharp()) {
        try { pngBuf = await _sharp(filePath, { limitInputPixels: false }).png().toBuffer() } catch {}
      }
      if (!pngBuf) {
        try {
          const convertHeic = require('heic-convert')
          const input = await fs.promises.readFile(filePath)
          const converted = await convertHeic({ buffer: input, format: 'PNG', quality: 1 })
          pngBuf = Buffer.from(converted)
        } catch {}
      }
    }

    // ICNS — extract largest embedded image
    if (!pngBuf && ext === 'icns') {
      try {
        const { Icns } = require('@fiahfy/icns')
        const input = await fs.promises.readFile(filePath)
        const icns = Icns.from(input)
        const images = icns.images
          .map(i => Buffer.from(i.image))
          .sort((a, b) => b.length - a.length)
        for (const imgBuf of images) {
          try {
            if (getSharp()) {
              pngBuf = await _sharp(imgBuf).png().toBuffer()
              if (pngBuf && pngBuf.length > 64) break
            }
            pngBuf = null
          } catch {}
        }
      } catch {}
    }

    // TGA/DDS/EPS — ImageMagick → ffmpeg fallback
    if (!pngBuf && (ext === 'tga' || ext === 'dds' || ext === 'eps')) {
      try {
        const { spawn: _sp } = require('child_process')
        const magickCommand = resolveToolCommand(_magickPath, 'magick')
        if (!magickCommand) throw new Error('Managed ImageMagick runtime is unavailable')
        pngBuf = await new Promise((resolve, reject) => {
          const child = _sp(magickCommand, [
            `${filePath}[0]`, '-auto-orient', '-background', 'white', '-flatten', 'png:-',
          ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: managedToolEnvironment(),
          })
          const chunks = []
          child.stdout.on('data', d => chunks.push(d))
          child.on('error', reject)
          child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`magick exit ${code}`)))
        })
      } catch {
        // ffmpeg fallback — outputs first frame as PNG
        if (_ffmpegPath) {
          try {
            const { spawn: _sp2 } = require('child_process')
            pngBuf = await new Promise((resolve, reject) => {
              const child = _sp2(_ffmpegPath, [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-i', filePath, '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', 'pipe:1',
              ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
              const chunks = []
              child.stdout.on('data', d => chunks.push(d))
              child.on('error', reject)
              child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exit ${code}`)))
            })
          } catch {}
        }
      }
    }

    // TGS — Telegram Lottie (gzipped JSON, no server-side renderer)
    if (ext === 'tgs') return null

    if (!pngBuf || pngBuf.length < 64) return null

    fs.writeFileSync(previewPath, pngBuf)
    return { url: 'file://' + previewPath.replace(/\\/g, '/') }
  } catch (e) {
    console.error('[Preview] prepare failed:', e.message)
    return null
  }
})
// Check if external tools (ImageMagick, FFmpeg) are available
ipcMain.handle('tools:checkAvailability', () => {
  const { spawn: _sp } = require('child_process')
  const check = (cmd, args) => new Promise(resolve => {
    if (!cmd) return resolve(false)
    const child = _sp(cmd, args, {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: managedToolEnvironment(),
    })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
  return Promise.all([
    check(resolveToolCommand(_magickPath, 'magick'), ['--version']),
    check(resolveToolCommand(_ffmpegPath, 'ffmpeg'), ['-version']),
    _ghostscriptPath
      ? check(_ghostscriptPath, ['--version'])
      : app.isPackaged
        ? Promise.resolve(false)
        : check('gswin64c', ['--version']).then(ok => ok || check('gs', ['--version'])),
  ]).then(([imageMagick, ffmpeg, ghostscript]) => ({ imageMagick, ffmpeg, ghostscript }))
})

// DB: get all assets that can be AI-tagged and have not been tagged yet.
// Native image formats use the original file; video/3D use the saved max thumbnail.
ipcMain.handle('db:getUntaggedImages', async () => {
  try {
    if (!_db) await initDB()
    const nativeImageExts = ['jpg','jpeg','jpe','jfif','png','gif','webp','bmp','tiff','tif','avif','heic','heif','hif']
    const nativePlaceholders = nativeImageExts.map(() => '?').join(',')
    return dbAll(
      `SELECT id, name, ext, filePath, hasThumb, aiTagged, aiDescription FROM assets
       WHERE deleted=0
         AND (aiTagged IS NULL OR aiTagged=0)
         AND (
           lower(ext) IN (${nativePlaceholders})
           OR hasThumb=1
         )
       ORDER BY importTime DESC`,
      nativeImageExts
    ).map(asset => {
      if (asset.hasThumb === 1 && fs.existsSync(thumbFilePath(asset.id))) {
        asset.thumbnailData = fileUrl(thumbFilePath(asset.id))
        asset.thumbnailVariants = thumbVariantUrls(asset.id)
      }
      return asset
    })
  } catch (e) { console.error('[DB] getUntaggedImages:', e); return [] }
})

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE — Eagle browser-extension API emulator (ports 41593 + 41595)
//
// The Eagle browser extension probes 127.0.0.1:41595 (modern JSON API) and
// 127.0.0.1:41593 (legacy form API). This server answers those probes so the
// extension believes Eagle is running, then downloads/decodes every media
// payload into the user's chosen web-grab folder.  The existing inbox watcher
// picks up the saved files and imports them into the library automatically.
// ══════════════════════════════════════════════════════════════════════════════

const _WG_PORTS   = [41593, 41595]
const _WG_VERSION = '4.0.0'
const _WG_BUILD   = '20241106'   // keeps extension in browser-download mode
const _webGrabServers = []

// Dedup cache: url → timestamp. Prevents the same media URL being downloaded
// twice when both ports receive the same payload within a short window.
const _wgSeenUrls = new Map()
const _WG_DEDUP_MS = 10000
function _wgUrlSeen(url) {
  if (!url) return false
  const now = Date.now()
  // Evict stale entries
  for (const [k, t] of _wgSeenUrls) { if (now - t > _WG_DEDUP_MS) _wgSeenUrls.delete(k) }
  if (_wgSeenUrls.has(url)) return true
  _wgSeenUrls.set(url, now)
  return false
}

// ── MIME → extension map ──────────────────────────────────────────────────────
const _WG_MIME_EXT = {
  'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif',
  'image/svg+xml':'svg','image/avif':'avif','image/bmp':'bmp','image/apng':'png',
  'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov',
  'video/x-msvideo':'avi','video/mp2t':'ts',
  'audio/mpeg':'mp3','audio/wav':'wav','audio/mp4':'m4a','audio/ogg':'ogg',
}
function _wgMimeToExt(mime) {
  return _WG_MIME_EXT[(mime || '').split(';')[0].trim().toLowerCase()] || 'bin'
}
function _wgExtFromUrl(rawUrl) {
  try { const e = path.extname(new URL(rawUrl).pathname); if (e && e.length <= 8) return e.slice(1).toLowerCase() } catch {}
  return ''
}
function _wgStamp() {
  const d = new Date(), p = n => String(n).padStart(2,'0')
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_${String(d.getMilliseconds()).padStart(3,'0')}`
}
function _wgSafeName(v) {
  return String(v || 'grab').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)
}

// ── Smart media URL detection (ported from server/index.js) ──────────────────
function _wgIsRemote(v) { return typeof v === 'string' && /^https?:\/\//i.test(v) }
function _wgIsData(v)   { return typeof v === 'string' && v.startsWith('data:') }
function _wgIsLikelyMediaUrl(v) {
  if (!_wgIsRemote(v)) return false
  try {
    const u = new URL(v)
    const p = u.pathname.toLowerCase()
    return (
      /\.(png|jpe?g|webp|gif|svg|avif|bmp|apng|mp4|m4v|webm|mov|mp3|m4a|wav)(\.|$)/i.test(p) ||
      /[?&](format|mime_type|fm|ext)=(jpe?g|png|webp|gif|avif|mp4|webm|video_mp4)/i.test(u.search) ||
      /\/(image|images|img|media|video|videos|photo|photos|originals|source)\//i.test(p)
    )
  } catch { return false }
}

// ── Priority-ordered media candidates (ported from server/index.js) ───────────
// src(0) > base64-field-url(1) > url-if-media(2) > thumbnailURL(3) > thumbnail(4) > poster(5)
function _wgGetCandidates(payload) {
  if (!payload || typeof payload !== 'object') return []
  const out = [], seen = new Set()
  const add = (field, value, pri) => {
    if (!_wgIsRemote(value) || seen.has(value)) return
    seen.add(value); out.push({ field, value, pri })
  }
  add('src',          payload.src,         0)
  add('base64',       payload.base64,      1)  // sometimes a URL, not base64
  if (_wgIsLikelyMediaUrl(payload.url)) add('url', payload.url, 2)
  add('thumbnailURL', payload.thumbnailURL,3)
  add('thumbnail',    payload.thumbnail,   4)
  add('poster',       payload.poster,      5)
  return out.sort((a,b) => a.pri - b.pri)
}

// ── Strip Eagle org fields we don't use ──────────────────────────────────────
const _WG_BLOCKED = new Set(['folderID','folderId','folderIDs','folders','tags','extendTags','autoTags'])
function _wgStrip(v) {
  if (Array.isArray(v)) return v.map(_wgStrip)
  if (!v || typeof v !== 'object') return v
  const o = {}
  for (const [k,val] of Object.entries(v)) { if (!_WG_BLOCKED.has(k)) o[k] = _wgStrip(val) }
  return o
}
function _wgSanitize(body) {
  const c = _wgStrip(body)
  if (c && typeof c === 'object' && typeof c.images === 'string') {
    try { c.images = JSON.stringify(_wgStrip(JSON.parse(c.images))) } catch {}
  }
  return c
}

// ── Read raw request body ─────────────────────────────────────────────────────
function _wgBody(req) {
  return new Promise((res, rej) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end',  () => res(Buffer.concat(chunks)))
    req.on('error', rej)
  })
}

// ── Send JSON response ────────────────────────────────────────────────────────
function _wgSend(res, status, data) {
  const json = JSON.stringify(data, null, 2)
  res.writeHead(status, {
    'Content-Type':  'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

// ── Download a remote URL → save to inbox dir ─────────────────────────────────
async function _wgDownload(field, url, meta, reqHeaders, dir) {
  if (_wgUrlSeen(url)) return { field, url, error: 'dedup-skip' }
  const base = _wgSafeName(meta.title || meta.name || field || 'grab')
  try {
    const hdrs = {
      'user-agent': String(reqHeaders['user-agent'] || 'stag-webgrab/1.0'),
      'accept': '*/*',
    }
    if (meta.url && _wgIsRemote(meta.url)) hdrs['referer'] = meta.url
    const resp = await fetch(url, { method:'GET', headers: hdrs, redirect:'follow', signal: AbortSignal.timeout(30000) })
    if (!resp.ok) return { field, url, error: `http-${resp.status}` }
    const mime = resp.headers.get('content-type') || ''
    const ext  = _wgExtFromUrl(url) || _wgMimeToExt(mime)
    const fileName = `${_wgStamp()}_${base}.${ext}`
    const filePath = path.join(dir, fileName)
    const bytes = Buffer.from(await resp.arrayBuffer())
    fs.writeFileSync(filePath, bytes)
    return { field, url, filePath, size: bytes.length }
  } catch (e) { return { field, url, error: String(e?.message || e) } }
}

// ── Decode a data: URL → save to inbox dir ───────────────────────────────────
function _wgDecodeDataUrl(field, value, meta, dir) {
  if (!_wgIsData(value)) return null
  const ci = value.indexOf(','); if (ci === -1) return null
  const header  = value.slice(0, ci)
  const payload = value.slice(ci + 1)
  const isB64   = /;base64/i.test(header)
  const mime    = (/^data:([^;,]+)/.exec(value) || [])[1] || ''
  const ext     = _wgMimeToExt(mime) || 'bin'
  const base    = _wgSafeName(meta.title || meta.name || field || 'grab')
  const filePath = path.join(dir, `${_wgStamp()}_${base}.${ext}`)
  try {
    const bytes = isB64 ? Buffer.from(payload,'base64') : Buffer.from(decodeURIComponent(payload),'utf8')
    fs.writeFileSync(filePath, bytes)
    return { field, url: '', filePath, size: bytes.length }
  } catch (e) { return { field, url: '', error: String(e?.message || e) } }
}

// ── Try candidates in priority order, stop at first success ──────────────────
async function _wgBestCandidate(payload, reqHeaders, dir) {
  for (const c of _wgGetCandidates(payload)) {
    const r = await _wgDownload(c.field, c.value, payload, reqHeaders, dir)
    if (!r.error && r.size > 0) return r
  }
  return null
}

// ── Collect all data: URLs from payload (inc. nested images[]) ───────────────
function _wgCollectDataUrls(payload, dir) {
  const results = []
  if (!payload || typeof payload !== 'object') return results
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v !== 'string') continue
    const r = _wgDecodeDataUrl(k, v, payload, dir)
    if (r) results.push(r)
    if (k === 'images') {
      try {
        const imgs = JSON.parse(v)
        if (Array.isArray(imgs)) {
          imgs.forEach((img, i) => {
            if (!img || typeof img !== 'object') return
            const src = img.base64 || img.url || img.src
            if (!src) return
            const r2 = _wgDecodeDataUrl(`img_${i}`, src, img, dir)
            if (r2) results.push(r2)
          })
        }
      } catch {}
    }
  }
  return results
}

// ── Download best remote candidate for payload + each images[] item ───────────
async function _wgDownloadStructured(payload, reqHeaders, dir) {
  const downloaded = [], failed = []
  // Intra-request dedup: skip URLs already queued in this call
  const localSeen = new Set()
  function localSkip(candidates) {
    return candidates.filter(c => { if (localSeen.has(c.value)) return false; localSeen.add(c.value); return true })
  }

  // Top-level single item
  const topCandidates = localSkip(_wgGetCandidates(payload))
  if (topCandidates.length > 0) {
    // Try candidates in order (same logic as _wgBestCandidate but with filtered list)
    let got = null
    for (const c of topCandidates) {
      const r = await _wgDownload(c.field, c.value, payload, reqHeaders, dir)
      if (!r.error && r.size > 0) { got = r; break }
    }
    if (got) downloaded.push(got)
    else if (topCandidates.length > 0) failed.push({ label: 'main' })
  }

  // Batch images[] array
  let imgs = []
  if (typeof payload?.images === 'string') { try { imgs = JSON.parse(payload.images) } catch {} }
  else if (Array.isArray(payload?.images)) imgs = payload.images
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i]; if (!img || typeof img !== 'object') continue
    const imgCandidates = localSkip(_wgGetCandidates(img))
    if (!imgCandidates.length) continue
    let got = null
    for (const c of imgCandidates) {
      const r = await _wgDownload(c.field, c.value, img, reqHeaders, dir)
      if (!r.error && r.size > 0) { got = r; break }
    }
    if (got) downloaded.push(got); else failed.push({ label: `img_${i}` })
  }
  return { downloaded, failed }
}

// ── Main request handler ──────────────────────────────────────────────────────
async function _wgHandle(port, req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    return res.end()
  }

  const pathname = new URL(req.url || '/', `http://127.0.0.1:${port}`).pathname

  // ── GET health / capability probes ────────────────────────────────────────
  if (req.method === 'GET') {
    if (pathname === '/') {
      if (port === 41595) {
        return _wgSend(res, 200, {
          status: 'success',
          data: {
            version: _WG_VERSION, buildVersion: _WG_BUILD, platform: process.platform,
            preferences: { notification: { notification: { when: { extension: 'true' } } } },
          },
        })
      }
      return _wgSend(res, 200, { showCollectModal: false, showNotification: true })
    }
    if (pathname === '/api/folder/list' || pathname === '/api/folder/listRecent')
      return _wgSend(res, 200, { status: 'success', data: [] })
    if (pathname === '/api/tag/all')
      return _wgSend(res, 200, { status: 'success', data: { tags: [], groups: [], recent: [] } })
    if (pathname === '/api/tag/list' || pathname === '/api/tag/listRecent')
      return _wgSend(res, 200, { status: 'success', data: [] })
    if (pathname === '/api/library/history')
      return _wgSend(res, 200, { status: 'success', data: [] })
    if (pathname === '/api/library/info')
      return _wgSend(res, 200, { status: 'success', data: { library: { path: getInboxDir() } } })
  }

  // ── POST stubs ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/folder/create')
    return _wgSend(res, 200, { status: 'success', data: null, disabled: true })

  // ── Parse body ────────────────────────────────────────────────────────────
  const buf = await _wgBody(req)
  const ct  = String(req.headers['content-type'] || '').toLowerCase()
  let rawBody = null
  if (ct.includes('application/json')) {
    try { rawBody = JSON.parse(buf.toString('utf8')) } catch {}
  } else if (ct.includes('application/x-www-form-urlencoded')) {
    rawBody = Object.fromEntries(new URLSearchParams(buf.toString('utf8')))
  } else if (buf.length > 0) {
    try { rawBody = JSON.parse(buf.toString('utf8')) } catch {}
  }

  if (!rawBody) return _wgSend(res, 200, { status: 'ok' })

  const body    = _wgSanitize(rawBody)
  const grabDir = getInboxDir()

  // ── Media import routes ───────────────────────────────────────────────────
  const isImport =
    (port === 41595 && (pathname === '/api/item/addFromURL' || pathname === '/api/item/addFromURLs')) ||
    (port === 41593 && pathname === '/')

  if (isImport) {
    // 1. Decode any data: URLs in the payload
    const decoded = _wgCollectDataUrls(body, grabDir)

    // 2. Download remote candidates
    const { downloaded, failed } = await _wgDownloadStructured(body, req.headers, grabDir)

    // Files saved to grabDir are picked up by the inbox watcher automatically.
    // Do NOT call processInboxFile here — the watcher is the sole importer,
    // preventing the double-import race that occurs when both this handler and
    // the watcher call processInboxFile concurrently on the same file.
    const saved = [...decoded, ...downloaded].filter(r => r.filePath && !r.error)

    console.log(`[webgrab:${port}] ${pathname} → decoded=${decoded.length} downloaded=${downloaded.length} failed=${failed.length}`)

    const hasFailed = failed.length > 0
    const hasOk     = saved.length > 0
    const status    = hasFailed ? (hasOk ? 'partial_success' : 'error') : 'success'
    return _wgSend(res, status === 'error' ? 502 : 200, {
      status, intercepted: true,
      saved: saved.length, decoded: decoded.length, downloaded: downloaded.length,
      failed: hasFailed ? failed : undefined,
    })
  }

  return _wgSend(res, 200, { status: 'ok', intercepted: true, path: pathname })
}

function startWebGrabServers() {
  for (const port of _WG_PORTS) {
    const server = http.createServer((req, res) => {
      _wgHandle(port, req, res).catch(e => {
        console.error(`[webgrab:${port}]`, e)
        _wgSend(res, 500, { status: 'error', message: String(e?.message || e) })
      })
    })
    server.listen(port, '127.0.0.1', () => console.log(`[webgrab] listening on http://127.0.0.1:${port}`))
    server.on('error', e => {
      if (e.code === 'EADDRINUSE') console.warn(`[webgrab] port ${port} already in use — skipped (is Eagle running?)`)
      else console.error(`[webgrab:${port}] error`, e)
    })
    _webGrabServers.push(server)
  }
}
