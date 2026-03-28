const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, nativeImage } = require('electron')
const path   = require('path')
const fs     = require('fs')
const crypto = require('crypto')
const http   = require('http')

let mainWindow = null
let tray       = null
let forceQuit  = false   // set true when user picks "Quit" from tray menu
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// ── Settings — tiny JSON, rarely changes ─────────────────────────────────────
function getSettingsPath() { return path.join(app.getPath('userData'), 'stag-settings.json') }
function loadSettings() {
  try { const p = getSettingsPath(); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch {}
  return { libraryPath: null, threads: 8, accentColor: '#4a9eff', bgColor: '#0a0c10', glassOpacity: 0.07, blurStrength: 18 }
}
function saveSettings(s) { try { fs.writeFileSync(getSettingsPath(), JSON.stringify(s, null, 2)) } catch (e) { console.error(e) } }

// ── Data directory ────────────────────────────────────────────────────────────
let _dataDir = null
function getDataDir() {
  if (_dataDir) { if (!fs.existsSync(_dataDir)) fs.mkdirSync(_dataDir, { recursive: true }); return _dataDir }
  try { const s = loadSettings(); if (s.libraryPath && fs.existsSync(s.libraryPath)) { _dataDir = s.libraryPath; return _dataDir } } catch {}
  const dir = path.join(app.getPath('userData'), 'stag-library')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  _dataDir = dir; return dir
}

// ── Thumbnail files — never stored in DB, always on disk ─────────────────────
// <dataDir>/thumbs/<first2charsOfId>/<id>.jpg
function thumbFilePath(id) {
  const bucket = path.join(getDataDir(), 'thumbs', id.slice(0, 2))
  if (!fs.existsSync(bucket)) fs.mkdirSync(bucket, { recursive: true })
  return path.join(bucket, id + '.jpg')
}

// ── sql.js database ───────────────────────────────────────────────────────────
// sql.js is pure JavaScript SQLite — zero native compilation required.
// The entire DB is held in memory as a Uint8Array and flushed to disk on writes.
// For metadata-only (no thumbnails), 10k assets ≈ 3-5 MB in memory — totally fine.
let _db     = null
let _SQL    = null
let _dbPath = null
let _flushTimer = null

function getDbPath() { return path.join(getDataDir(), 'library.db') }

async function initDB() {
  if (_db) return _db
  // Load sql.js (pure JS, no native build)
  const initSqlJs = require('sql.js')
  _SQL = await initSqlJs()
  _dbPath = getDbPath()

  if (fs.existsSync(_dbPath)) {
    const buf = fs.readFileSync(_dbPath)
    _db = new _SQL.Database(buf)
  } else {
    _db = new _SQL.Database()
  }

  createSchema()
  return _db
}

// Flush DB to disk — called after every write, debounced to avoid hammering disk
function flushDB() {
  if (!_db) return
  if (_flushTimer) clearTimeout(_flushTimer)
  _flushTimer = setTimeout(() => {
    try {
      const data = _db.export()
      const buf  = Buffer.from(data)
      const tmp  = _dbPath + '.tmp'
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, _dbPath)
    } catch (e) { console.error('[DB] flush error:', e) }
  }, 200) // debounce: coalesce rapid writes into one disk write
}

function createSchema() {
  // Add new columns to existing DBs (safe — IF NOT EXISTS equivalent for columns)
  try { _db.run('ALTER TABLE assets ADD COLUMN aiTagged INTEGER NOT NULL DEFAULT 0') } catch {}
  try { _db.run("ALTER TABLE assets ADD COLUMN aiDescription TEXT NOT NULL DEFAULT ''") } catch {}

  _db.run(`
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
      hasThumb    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_assets_filePath   ON assets(filePath);
    CREATE INDEX IF NOT EXISTS idx_assets_importTime ON assets(importTime);
    CREATE INDEX IF NOT EXISTS idx_assets_ext        ON assets(ext);
    CREATE INDEX IF NOT EXISTS idx_assets_deleted    ON assets(deleted);

    CREATE TABLE IF NOT EXISTS asset_tags (
      assetId TEXT NOT NULL,
      tag     TEXT NOT NULL,
      PRIMARY KEY (assetId, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag);

    CREATE TABLE IF NOT EXISTS asset_folders (
      assetId  TEXT NOT NULL,
      folderId TEXT NOT NULL,
      PRIMARY KEY (assetId, folderId)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_folders_folder ON asset_folders(folderId);

    CREATE TABLE IF NOT EXISTS asset_colors (
      assetId   TEXT NOT NULL,
      hex       TEXT NOT NULL,
      ratio     REAL NOT NULL DEFAULT 0,
      sortOrder INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_asset_colors_asset ON asset_colors(assetId);

    CREATE TABLE IF NOT EXISTS asset_annotations (
      id      TEXT PRIMARY KEY,
      assetId TEXT NOT NULL,
      x       REAL NOT NULL,
      y       REAL NOT NULL,
      label   TEXT NOT NULL DEFAULT ''
    );

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
  `)
}

// ── sql.js query helpers ──────────────────────────────────────────────────────
// sql.js has a different API than better-sqlite3:
//   run(sql, params)   — no return
//   exec(sql)          — multi-statement, no params
//   prepare(sql)       — returns Statement
//   stmt.get(params)   — returns first row as {columns,values} or undefined
//   stmt.all(params)   — returns array of {columns,values}
// We wrap this to return plain objects like better-sqlite3 does.

function dbRun(sql, params = []) {
  _db.run(sql, params)
}

function dbAll(sql, params = []) {
  const stmt = _db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    const obj = {}
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i]
    rows.push(obj)
  }
  stmt.free()
  return rows
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params)
  return rows[0] || null
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
}

// ── Load everything for startup ───────────────────────────────────────────────
function dbLoadAll() {
  if (!_db) return { assets: [], folders: [], tags: [], smartFolders: [] }
  try {
    const assetRows = dbAll('SELECT * FROM assets WHERE deleted=0 ORDER BY importTime DESC')
    const allTags   = dbAll('SELECT assetId, tag FROM asset_tags')
    const allFolds  = dbAll('SELECT assetId, folderId FROM asset_folders')
    const allColors = dbAll('SELECT assetId, hex, ratio FROM asset_colors ORDER BY assetId, sortOrder')
    const allAnnots = dbAll('SELECT * FROM asset_annotations')

    const tagsMap = {}, foldMap = {}, colorMap = {}, annotMap = {}
    for (const r of allTags)   { (tagsMap[r.assetId]  = tagsMap[r.assetId]  || []).push(r.tag) }
    for (const r of allFolds)  { (foldMap[r.assetId]  = foldMap[r.assetId]  || []).push(r.folderId) }
    for (const r of allColors) { (colorMap[r.assetId] = colorMap[r.assetId] || []).push({ hex: r.hex, ratio: r.ratio }) }
    for (const r of allAnnots) { (annotMap[r.assetId] = annotMap[r.assetId] || []).push({ id: r.id, x: r.x, y: r.y, label: r.label }) }

    const assets = assetRows.map(row => {
      let thumbnailData
      if (row.hasThumb) {
        const tp = thumbFilePath(row.id)
        if (fs.existsSync(tp)) thumbnailData = 'file://' + tp.replace(/\\/g, '/')
      }
      return {
        id: row.id, name: row.name, ext: row.ext, filePath: row.filePath,
        thumbnailData,
        size: row.size, width: row.width ?? undefined, height: row.height ?? undefined,
        duration: row.duration ?? undefined, mtime: row.mtime, btime: row.btime,
        importTime: row.importTime, rating: row.rating, notes: row.notes, url: row.url,
        deleted: row.deleted === 1, deletedAt: row.deletedAt ?? undefined,
        aiTagged: row.aiTagged === 1, aiDescription: row.aiDescription || undefined,
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

    return { assets, folders, tags, smartFolders }
  } catch (e) { console.error('[DB] dbLoadAll:', e); return { assets: [], folders: [], tags: [], smartFolders: [] } }
}

// ── One-time migration from old library.json ──────────────────────────────────
function migrateFromJSON() {
  const jsonPath = path.join(getDataDir(), 'library.json')
  const doneFlag = path.join(getDataDir(), '.migrated_v2')
  if (!fs.existsSync(jsonPath) || fs.existsSync(doneFlag)) return
  console.log('[DB] Migrating library.json → sql.js …')
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
    const result = _db.run(
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
    _db.run(
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

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark'
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: false, backgroundColor: '#0a0c10',
    icon: process.platform === 'win32'
      ? path.join(__dirname, '../build/icon.ico')
      : path.join(__dirname, '../public/icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(__dirname, 'preload.js') },
  })
  if (isDev) mainWindow.loadURL('http://localhost:3000')
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
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

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','avif','heic','heif','svg'])

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
  // AVIF/HEIC: ftyp box — bytes 4-7 are 'ftyp'
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    // brand at bytes 8-11
    const brand = buf.slice(8, 12).toString('ascii')
    if (/avif|avis/i.test(brand)) return 'avif'
    if (/heic|heix|hevc|mif1|msf1/i.test(brand)) return 'heic'
    return 'heic' // unknown ftyp — likely heic/avif
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

// ── Process a single inbox file — import it into the DB ──────────────────────
async function processInboxFile(filePath) {
  if (!fs.existsSync(filePath)) return
  if (!_db) return

  // Read first bytes to detect the real format — the filename extension may be wrong
  // (e.g. Chrome saving a WebP as .jpeg, or the bridge server correcting .webp→.jpg)
  let realExt
  try {
    const head = Buffer.alloc(12)
    const fd = await fs.promises.open(filePath, 'r')
    await fd.read(head, 0, 12, 0)
    await fd.close()
    realExt = detectImageExt(head)
  } catch {}

  const filenameExt = path.extname(filePath).slice(1).toLowerCase()
  const ext  = realExt || filenameExt || 'jpg'
  const name = path.basename(filePath, path.extname(filePath))
    .replace(/^\d+_/, '')          // strip timestamp prefix
    .replace(/[_-]+/g, ' ')        // underscores → spaces for readability
    .trim()

  // Check if already imported (by filePath)
  try {
    const existing = dbGet(`SELECT id FROM assets WHERE filePath=?`, [filePath])
    if (existing) return  // already in library
  } catch {}

  let stat
  try { stat = await fs.promises.stat(filePath) } catch { return }

  const id = crypto.randomUUID().replace(/-/g, '').substring(0, 20)

  // ── Generate compressed thumbnail + read real image dimensions ──────────────
  // nativeImage: createFromPath → getSize (real dims) → resize → toJPEG (compressed)
  let hasThumb = 0
  let thumbnailData = undefined
  let imgWidth  = null
  let imgHeight = null

  if (IMAGE_EXTS.has(ext)) {
    try {
      if (ext === 'svg') {
        // SVG: copy file bytes directly as the thumbnail
        const svgBuf = await fs.promises.readFile(filePath)
        const tp = thumbFilePath(id)
        fs.writeFileSync(tp, svgBuf)
        hasThumb = 1
        thumbnailData = 'file://' + tp.replace(/\\/g, '/')
      } else if (stat.size < 60 * 1024 * 1024) {
        // Use the shared generateThumbForFile which handles all formats correctly
        const result = await generateThumbForFile(filePath, ext, id)
        if (result) {
          imgWidth  = result.imgW
          imgHeight = result.imgH
          hasThumb = 1
          thumbnailData = 'file://' + result.tp.replace(/\\/g, '/')
          console.log('[Bridge] Thumb: ' + imgWidth + 'x' + imgHeight + ', file=' + result.tp)
        }
      }
    } catch (e) { console.warn('[Bridge] Thumb generation failed:', e.message) }
  }

  const importTime = Date.now()
  const asset = {
    id, name, ext, filePath,
    size: stat.size,
    width: imgWidth, height: imgHeight, duration: null,
    mtime: stat.mtimeMs, btime: stat.birthtimeMs,
    importTime,
    tags: IMAGE_EXTS.has(ext) ? ['web-grab'] : [],
    folders: [], rating: 0,
    notes: '', url: '', colors: [],
    deleted: 0, deletedAt: null, hasThumb,
    aiTagged: 0, aiDescription: '',
    thumbnailData,
  }

  try {
    dbRun(
      `INSERT OR IGNORE INTO assets (id,name,ext,filePath,size,width,height,duration,mtime,btime,importTime,rating,notes,url,deleted,deletedAt,hasThumb,aiTagged,aiDescription)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, name, ext, filePath, stat.size, imgWidth, imgHeight, null,
       stat.mtimeMs, stat.birthtimeMs, importTime,
       0, '', '', 0, null, hasThumb, 0, '']
    )
    // Add auto tag "web-grab"
    dbRun(`INSERT OR IGNORE INTO tags(tag) VALUES(?)`, ['web-grab'])
    dbRun(`INSERT OR IGNORE INTO asset_tags(assetId,tag) VALUES(?,?)`, [id, 'web-grab'])
    flushDB()
    console.log('[Bridge] Imported from inbox:', filePath, hasThumb ? '(thumb saved)' : '(no thumb)')

    // Notify renderer if it's open
    if (mainWindow?.webContents) {
      mainWindow.webContents.send('assets:added', [asset])
    }
    // Rebuild watchers so the inbox dir is watched for future deletions
    setImmediate(rebuildDirWatchers)
  } catch (e) { console.error('[Bridge] Import error:', e) }
}

// ── On startup: sweep inbox for any files saved while app was closed ──────────
async function scanInboxOnStartup() {
  const inboxDir = getInboxDir()
  let files = []
  try { files = fs.readdirSync(inboxDir) } catch { return }

  for (const file of files) {
    const full = path.join(inboxDir, file)
    try {
      const st = fs.statSync(full)
      if (!st.isFile()) continue

      // Skip files that are soft-deleted in DB (user moved to trash but file
      // wasn't removed from disk — don't re-import on restart)
      let existingRow = null
      try { existingRow = dbGet('SELECT id, deleted FROM assets WHERE filePath=?', [full]) } catch {}
      if (existingRow && existingRow.deleted === 1) continue

      await processInboxFile(full)
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
    { label: 'Show Stag', click: () => {
        if (!mainWindow) createWindow()
        else { mainWindow.show(); mainWindow.focus() }
    }},
    { type: 'separator' },
    { label: 'Quit Stag', click: () => { forceQuit = true; app.quit() } },
  ]))

  // Single-click → show window
  tray.on('click', () => {
    if (!mainWindow) { createWindow(); return }
    if (mainWindow.isVisible()) { mainWindow.show(); mainWindow.focus() }
    else { mainWindow.show(); mainWindow.focus() }
  })
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark'
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: false, backgroundColor: '#0a0c10',
    icon: path.join(__dirname, '../public/icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(__dirname, 'preload.js') },
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

// ── Background thumbnail worker ───────────────────────────────────────────────
// Runs entirely in the main process so it survives renderer close/reload.
// Picks up any hasThumb=0 assets (including ones from a previous interrupted session).
// Supported: jpg/jpeg/png/gif/webp/bmp/ico/avif/tiff/tif/heic + raw formats via buffer
const THUMB_EXTS = new Set([
  'jpg','jpeg','png','gif','webp','bmp','ico','avif',
  'tiff','tif','heic','heif','raw','cr2','nef','arw','dng','orf','rw2','svg',
  'pdf','epub',
])

// ── Jimp-supported formats (pure JS, no native binary needed) ─────────────────
// jimp 1.x bundles: jpeg, png, gif, tiff, bmp
const JIMP_EXTS = new Set(['jpg','jpeg','png','gif','tiff','tif','bmp','ico'])

// ── Browser-decoded formats (Chromium inside Electron handles these) ───────────
// webp, avif, heic, heif, svg — decoded via hidden offscreen BrowserWindow
const BROWSER_EXTS = new Set(['webp','avif','heic','heif','svg'])

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

// Decode any Chromium-supported image (webp/avif/heic/svg) to JPEG via canvas.
// Returns a Buffer of JPEG bytes, or null on failure.
async function decodeViaChromium(filePath, ext) {
  return new Promise((resolve) => {
    try {
      const win = getOffscreenWin()
      if (!win || win.isDestroyed()) { resolve(null); return }

      const fileUrl = 'file://' + filePath.replace(/\\/g, '/')
      const maxDim  = 600
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
                const dataUrl = c.toDataURL('image/jpeg', 0.88)
                ok({ dataUrl, w: img.naturalWidth, h: img.naturalHeight })
              } catch(e) { fail(e.message) }
            }
            img.onerror = () => fail('img load error')
            img.src = ${JSON.stringify(fileUrl)}
          })
        })()
      `).then(result => {
        clearTimeout(timeout)
        if (!result || !result.dataUrl || !result.dataUrl.startsWith('data:image/jpeg;base64,')) {
          resolve(null); return
        }
        const b64  = result.dataUrl.split(',')[1]
        const jpegBuf = Buffer.from(b64, 'base64')
        resolve({ jpegBuf, imgW: result.w, imgH: result.h })
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

// ── PDF thumbnail via pdf-poppler ────────────────────────────────────────────
// Uses pdf-poppler (^0.2.3) which bundles its own Poppler binaries — no system
// install required. Renders page 1 to a temp PNG, reads it with jimp, saves JPEG.
async function renderPdfThumb(filePath) {
  const os   = require('os')
  const pdf  = require('pdf-poppler')

  // Create a unique temp dir so concurrent conversions don't collide
  let tmpDir = null
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stag-pdf-'))

    const opts = {
      format:     'png',
      out_dir:    tmpDir,
      out_prefix: 'p',
      page:       1,          // first page only
      scale:      768,        // render at 768px wide — gives crisp thumb
    }

    await pdf.convert(filePath, opts)

    // pdf-poppler names output files: <prefix>-<N>.png where N is zero-padded
    // to the width of the total page count.  For single-page requests it is
    // always "p-1.png" but some builds emit "p-01.png".  Glob for any .png.
    const pngFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort()                  // lexical sort puts p-1 before p-2

    if (!pngFiles.length) {
      console.warn('[Thumb] pdf-poppler: no png output in', tmpDir)
      return null
    }

    const pngPath = path.join(tmpDir, pngFiles[0])
    const pngBuf  = fs.readFileSync(pngPath)

    const { Jimp, JimpMime } = require('jimp')
    const img  = await Jimp.read(pngBuf)
    const imgW = img.width
    const imgH = img.height
    if (!imgW || !imgH) return null

    const scale = Math.min(600 / imgW, 600 / imgH, 1)
    img.resize({ w: Math.max(1, Math.round(imgW * scale)), h: Math.max(1, Math.round(imgH * scale)) })
    const jpegBuf = await img.getBuffer(JimpMime.jpeg)
    if (!jpegBuf || jpegBuf.length < 64) return null

    console.log(`[Thumb] pdf-poppler: ${imgW}x${imgH}, ${jpegBuf.length}B`)
    return { jpegBuf, imgW, imgH }

  } catch (e) {
    console.warn('[Thumb] pdf-poppler error:', e.message)
    return null
  } finally {
    // Always clean up temp dir
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  }
}
// ── EPUB thumbnail via epub2 — cover image extraction ────────────────────────
// Parses the EPUB zip, extracts cover image buffer (declared cover or first
// image in manifest), decodes via Chromium canvas so any format works.
async function renderEpubThumb(filePath) {
  return new Promise((resolve) => {
    try {
      const { EPub } = require('epub2')
      const epub = new EPub(filePath)

      epub.on('error', () => resolve(null))
      epub.on('end', async () => {
        try {
          // Strategy 1: declared cover ID in metadata
          let coverId = epub.metadata.cover

          // Strategy 2: scan manifest for cover item by id/type/href
          if (!coverId) {
            const manifest = epub.manifest || {}
            for (const [id, item] of Object.entries(manifest)) {
              const i = item
              if (
                (typeof i.id === 'string' && i.id.toLowerCase().includes('cover')) ||
                (typeof i.href === 'string' && i.href.toLowerCase().includes('cover')) ||
                (typeof i.properties === 'string' && i.properties.includes('cover-image'))
              ) {
                if (i['media-type'] && i['media-type'].startsWith('image/')) {
                  coverId = id; break
                }
              }
            }
          }

          // Strategy 3: first image in manifest
          if (!coverId) {
            const manifest = epub.manifest || {}
            for (const [id, item] of Object.entries(manifest)) {
              if (item['media-type'] && item['media-type'].startsWith('image/')) {
                coverId = id; break
              }
            }
          }

          if (!coverId) { resolve(null); return }

          epub.getImage(coverId, async (err, data, mimeType) => {
            if (err || !data) { resolve(null); return }
            try {
              // Decode the image buffer via Chromium canvas (handles jpg/png/webp/gif)
              const win = getOffscreenWin()
              if (!win || win.isDestroyed()) { resolve(null); return }

              const b64src = `data:${mimeType || 'image/jpeg'};base64,${Buffer.from(data).toString('base64')}`
              const timeout = setTimeout(() => resolve(null), 10000)

              win.webContents.executeJavaScript(`
                (function() {
                  return new Promise((ok, fail) => {
                    const img = new Image()
                    img.onload = () => {
                      try {
                        const maxD = 600
                        const scale = Math.min(maxD / img.naturalWidth, maxD / img.naturalHeight, 1)
                        const w = Math.max(1, Math.round(img.naturalWidth  * scale))
                        const h = Math.max(1, Math.round(img.naturalHeight * scale))
                        const c = document.createElement('canvas')
                        c.width = w; c.height = h
                        c.getContext('2d').drawImage(img, 0, 0, w, h)
                        ok({ dataUrl: c.toDataURL('image/jpeg', 0.88), w: img.naturalWidth, h: img.naturalHeight })
                      } catch(e) { fail(e.message) }
                    }
                    img.onerror = () => fail('load error')
                    img.src = ${JSON.stringify(b64src)}
                  })
                })()
              `).then(result => {
                clearTimeout(timeout)
                if (!result?.dataUrl) { resolve(null); return }
                const b64 = result.dataUrl.split(',')[1]
                if (!b64) { resolve(null); return }
                resolve({ jpegBuf: Buffer.from(b64, 'base64'), imgW: result.w, imgH: result.h })
              }).catch(e => { clearTimeout(timeout); resolve(null) })
            } catch(e) { resolve(null) }
          })
        } catch(e) { resolve(null) }
      })
      epub.parse()
    } catch(e) {
      console.warn('[Thumb] renderEpubThumb setup error:', e.message)
      resolve(null)
    }
  })
}

// ── Main thumbnail generator ──────────────────────────────────────────────────
// Track 1: jimp (pure JS) — jpg/png/gif/tiff/bmp.  Works on all platforms,
//          handles small dimensions (like 450×788) perfectly.
// Track 2: Chromium canvas — webp/avif/heic/heif/svg.  Uses the hidden
//          offscreen BrowserWindow to let Chromium decode the image, then
//          captures it via canvas.
// Track 3: nativeImage fallback — last resort for anything else.
async function generateThumbForFile(filePath, ext, id) {
  try {
    // Only read the full file buffer for image tracks (1/2/3).
    // pdf and epub handle their own file I/O inside renderPdfThumb/renderEpubThumb.
    const needsBuf = JIMP_EXTS.has(ext) || BROWSER_EXTS.has(ext)
    const buf = needsBuf ? await fs.promises.readFile(filePath).catch(() => null) : Buffer.alloc(0)
    if (needsBuf && (!buf || buf.length < 8)) return null

    let jpegBuf = null
    let imgW = 0, imgH = 0

    // ── Track 1: jimp (jpg/png/gif/tiff/bmp) ─────────────────────────────────
    if (JIMP_EXTS.has(ext)) {
      try {
        const { Jimp, JimpMime } = require('jimp')
        const img = await Jimp.read(buf)
        imgW = img.width
        imgH = img.height
        if (!imgW || !imgH) throw new Error('zero dimensions')

        // Scale so longest side ≤ 600px; never upscale
        const scale = Math.min(600 / imgW, 600 / imgH, 1)
        const outW  = Math.max(1, Math.round(imgW * scale))
        const outH  = Math.max(1, Math.round(imgH * scale))
        img.resize({ w: outW, h: outH })
        jpegBuf = await img.getBuffer(JimpMime.jpeg)
        console.log(`[Thumb] jimp: ${ext} ${imgW}x${imgH} -> ${outW}x${outH}, ${jpegBuf.length}B`)
      } catch (e) {
        console.warn(`[Thumb] jimp failed for ${ext}:`, e.message)
        jpegBuf = null
      }
    }

    // ── Track 2: Chromium canvas (webp/avif/heic/svg) ────────────────────────
    if (!jpegBuf && (BROWSER_EXTS.has(ext))) {
      try {
        const result = await decodeViaChromium(filePath, ext)
        if (result) {
          jpegBuf = result.jpegBuf
          imgW    = result.imgW
          imgH    = result.imgH
          console.log(`[Thumb] chromium: ${ext} ${imgW}x${imgH}, ${jpegBuf.length}B`)
        }
      } catch (e) {
        console.warn(`[Thumb] chromium failed for ${ext}:`, e.message)
      }
    }

    // ── Track 3: nativeImage fallback ─────────────────────────────────────────
    // Last resort — works well for jpg/png on all platforms. May fail for
    // gif/tiff/webp on Windows but we already tried jimp/chromium above.
    // Skip for pdf/epub — nativeImage cannot decode them.
    if (!jpegBuf && ext !== 'pdf' && ext !== 'epub') {
      try {
        const img = nativeImage.createFromPath(filePath)
        if (!img.isEmpty()) {
          const sz = img.getSize()
          imgW = sz.width; imgH = sz.height
          if (imgW > 0 && imgH > 0) {
            const scale = Math.min(600 / imgW, 600 / imgH, 1)
            const outW  = Math.max(1, Math.round(imgW * scale))
            const outH  = Math.max(1, Math.round(imgH * scale))
            const resized = img.resize({ width: outW, height: outH, quality: 'good' })
            jpegBuf = resized.toJPEG(88)
            if (jpegBuf && jpegBuf.length > 64) {
              console.log(`[Thumb] nativeImage fallback: ${ext} ${imgW}x${imgH}, ${jpegBuf.length}B`)
            } else {
              jpegBuf = null
            }
          }
        }
      } catch (e) {
        console.warn(`[Thumb] nativeImage fallback failed for ${ext}:`, e.message)
      }
    }

    // ── Track 4: PDF — first page via pdf-poppler ────────────────────────────
    if (!jpegBuf && ext === 'pdf') {
      try {
        const result = await renderPdfThumb(filePath)
        if (result) {
          jpegBuf = result.jpegBuf
          imgW    = result.imgW
          imgH    = result.imgH
          console.log(`[Thumb] pdf.js: ${imgW}x${imgH}, ${jpegBuf.length}B`)
        }
      } catch (e) {
        console.warn('[Thumb] pdf.js failed:', e.message)
        jpegBuf = null
      }
    }

    // ── Track 5: EPUB — cover image via epub2 ────────────────────────────────
    // Parses the EPUB zip, finds declared cover or first image in manifest.
    if (!jpegBuf && ext === 'epub') {
      try {
        const result = await renderEpubThumb(filePath)
        if (result) {
          jpegBuf = result.jpegBuf
          imgW    = result.imgW
          imgH    = result.imgH
          console.log(`[Thumb] epub2: cover ${imgW}x${imgH}, ${jpegBuf.length}B`)
        }
      } catch (e) {
        console.warn('[Thumb] epub2 failed:', e.message)
        jpegBuf = null
      }
    }

    if (!jpegBuf || jpegBuf.length < 64) return null

    const tp = thumbFilePath(id)
    fs.writeFileSync(tp, jpegBuf)
    return { tp, imgW, imgH }
  } catch (e) {
    console.warn('[Thumb] generateThumbForFile error:', e.message)
    return null
  }
}

async function runThumbWorker() {
  if (_thumbWorkerRunning || !_db) return
  _thumbWorkerRunning = true
  console.log('[Thumb] Worker started')

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

      for (const row of rows) {
        if (!_db) break
        const { id, filePath, ext } = row

        try {
          // Skip unsupported types
          if (!THUMB_EXTS.has(ext)) {
            dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
            continue
          }

          const stat = await fs.promises.stat(filePath).catch(() => null)
          if (!stat) {
            dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
            continue
          }
          if (stat.size > 60 * 1024 * 1024) {  // raised to 60MB to handle RAW files
            dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
            continue
          }

          const result = await generateThumbForFile(filePath, ext, id)
          if (!result) {
            dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id])
            continue
          }

          const { tp, imgW, imgH } = result
          dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [imgW, imgH, id])
          flushDB()

          const thumbUrl = 'file://' + tp.replace(/\\/g, '/')
          if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('thumb:done', { id, thumbUrl, width: imgW, height: imgH })
          }
        } catch (e) {
          console.warn('[Thumb] Failed for', filePath, e.message)
          try { dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id]) } catch {}
        }

        await new Promise(r => setImmediate(r))
      }

      await new Promise(r => setTimeout(r, 60))
    }
  } finally {
    _thumbWorkerRunning = false
    console.log('[Thumb] Worker finished')
  }
}

// IPC: renderer asks main to (re)start the thumb worker after an import
ipcMain.handle('thumb:startWorker', () => { setImmediate(runThumbWorker); return true })

// IPC: generate thumbnails for a specific batch of assets synchronously (used during import).
ipcMain.handle('thumb:generateBatch', async (_ev, items) => {
  const results = []
  for (const { id, filePath, ext } of (items || [])) {
    try {
      if (!THUMB_EXTS.has(ext)) { results.push({ id, thumbUrl: null }); continue }
      const stat = await fs.promises.stat(filePath).catch(() => null)
      if (!stat || stat.size > 60 * 1024 * 1024) { results.push({ id, thumbUrl: null }); continue }

      const result = await generateThumbForFile(filePath, ext, id)
      if (!result) { results.push({ id, thumbUrl: null }); continue }

      const { tp, imgW, imgH } = result
      dbRun('UPDATE assets SET hasThumb=1, width=?, height=? WHERE id=?', [imgW, imgH, id])
      const thumbUrl = 'file://' + tp.replace(/\\/g, '/')
      results.push({ id, thumbUrl, width: imgW, height: imgH })
    } catch (e) {
      console.warn('[Thumb] generateBatch failed for', filePath, e.message)
      results.push({ id, thumbUrl: null })
    }
    await new Promise(r => setImmediate(r))
  }
  try { flushDB() } catch {}
  return results
})

app.whenReady().then(async () => {
  await initDB()
  migrateFromJSON()
  migrateThumbRetry()   // reset hasThumb for formats the old code failed on
  migrateThumbRetryV4() // reset hasThumb for pdf/epub now that thumbnails are supported
  createTray()
  createWindow()

  setImmediate(async () => {
    startBridgeServer()
    startInboxWatcher()
    await scanInboxOnStartup()
    rebuildDirWatchers()
    // Resume thumbnail generation for any assets that didn't get thumbs last session
    runThumbWorker()
  })
})

app.on('before-quit', () => { forceQuit = true })

app.on('window-all-closed', () => {
  // Only actually quit if forceQuit — otherwise keep running as tray app
  if (forceQuit) {
    if (_db && _dbPath) {
      try { const data = _db.export(); fs.writeFileSync(_dbPath, Buffer.from(data)) } catch {}
    }
    if (process.platform !== 'darwin') app.quit()
  }
})

app.on('activate', () => {
  if (!mainWindow) createWindow()
  else { mainWindow.show(); mainWindow.focus() }
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
      'jpg','jpeg','png','gif','webp','svg','bmp','tiff','ico','avif','heic',
      'mp4','webm','mov','avi','mkv','m4v','ts','mts','m2ts','mpg','mpeg','flv','wmv','rmvb','3gp',
      'mp3','wav','flac','aac','m4a','ogg','opus','wma',
      'pdf','psd','ai','sketch','xd','fig','eps','ttf','otf','woff','woff2',
      'glb','gltf','obj','fbx','stl','dae','blend','3ds','ply',
      'txt','md','json','csv','xml','html','css','js','ts','py','sh',
      'doc','docx','xls','xlsx','ppt','pptx','epub','zip','rar','7z',
    ]}],
  })
  return res.canceled ? [] : res.filePaths
})
ipcMain.handle('dialog:openFolder',      async () => { if (!mainWindow) return null; const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0] })
ipcMain.handle('dialog:selectDirectory', async () => { if (!mainWindow) return null; const r = await dialog.showOpenDialog(mainWindow, { title: 'Select Library Location', properties: ['openDirectory','createDirectory'] }); return r.canceled ? null : r.filePaths[0] })
ipcMain.handle('dialog:selectDestFolder',async () => { if (!mainWindow) return null; const r = await dialog.showOpenDialog(mainWindow, { title: 'Send Files To…', properties: ['openDirectory','createDirectory'] }); return r.canceled ? null : r.filePaths[0] })

// ── IPC: File system ──────────────────────────────────────────────────────────
ipcMain.handle('fs:copyFiles',   async (_ev, srcs, destDir) => { const res=[]; for(const src of srcs){try{fs.copyFileSync(src,path.join(destDir,path.basename(src)));res.push({src,ok:true})}catch(e){res.push({src,ok:false,error:String(e)})}}; return res })
ipcMain.handle('fs:getFileInfo', (_ev, p) => { try{const s=fs.statSync(p);return{size:s.size,mtime:s.mtimeMs,btime:s.birthtimeMs}}catch{return null} })
ipcMain.handle('fs:readDir',     (_ev, p) => { try{return fs.readdirSync(p,{withFileTypes:true}).map(f=>({name:f.name,isDirectory:f.isDirectory(),path:path.join(p,f.name)}))}catch{return[]} })
ipcMain.handle('fs:exists',      (_ev, p) => fs.existsSync(p))
ipcMain.handle('fs:copyFile',    (_ev, s, d) => { try{fs.cpSync(s,d,{recursive:true});return true}catch{return false} })
ipcMain.handle('fs:deleteFile',  (_ev, p) => { try{fs.rmSync(p,{recursive:true,force:true});return true}catch{return false} })
ipcMain.handle('fs:readText',    async (_ev, filePath, maxBytes=50000) => { try{const st=await fs.promises.stat(filePath);const buf=await fs.promises.readFile(filePath);return{text:buf.slice(0,maxBytes).toString('utf-8'),size:st.size,truncated:st.size>maxBytes}}catch(e){return{text:null,error:String(e)}} })

// ── IPC: Shell / drag ─────────────────────────────────────────────────────────
ipcMain.handle('shell:openPath',     (_ev, p) => shell.openPath(p))
ipcMain.handle('shell:showInFolder', (_ev, p) => shell.showItemInFolder(p))
// ── Drag helpers ──────────────────────────────────────────────────────────────
// Build a drag icon: prefer the thumbnail file, fall back to a 32x32 blank icon.
// Icon is REQUIRED by Electron startDrag on all platforms — omitting it causes
// silent failure (file explorer and other apps receive nothing).
function buildDragIcon(iconHint) {
  if (iconHint) {
    try {
      // iconHint is a file path (thumbnail or original image)
      const img = nativeImage.createFromPath(iconHint)
      if (!img.isEmpty()) {
        const sz = img.getSize()
        // Resize to 64x64 for drag icon — not too large, renders crisply
        const scale = Math.min(64 / sz.width, 64 / sz.height, 1)
        const w = Math.max(1, Math.round(sz.width * scale))
        const h = Math.max(1, Math.round(sz.height * scale))
        return img.resize({ width: w, height: h, quality: 'good' })
      }
    } catch {}
  }
  // Fallback: a small grey square so the drag still works
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAHklEQVRYw+3BMQEAAADCoPVP7WsIoAAAAAAAAAAAeAMBxAACzAAFBwAAAABJRU5ErkJggg=='
  )
}

ipcMain.on('drag:start', (ev, p) => {
  try { if (fs.existsSync(p)) ev.sender.startDrag({ file: p, icon: buildDragIcon(p) }) } catch {}
  ev.returnValue = null
})
ipcMain.on('drag:startMulti', (ev, arr) => {
  try {
    const existing = (arr || []).filter(p => fs.existsSync(p))
    if (existing.length >= 1) ev.sender.startDrag({ file: existing[0], files: existing, icon: buildDragIcon(existing[0]) })
  } catch {}
  ev.returnValue = null
})
ipcMain.on('drag:startWithIcon', (ev, p, iconHint) => {
  try { if (fs.existsSync(p)) ev.sender.startDrag({ file: p, icon: buildDragIcon(iconHint || p) }) } catch {}
  ev.returnValue = null
})
ipcMain.on('drag:startMultiWithIcon', (ev, arr, iconHint) => {
  try {
    const existing = (arr || []).filter(p => fs.existsSync(p))
    if (existing.length >= 1) ev.sender.startDrag({ file: existing[0], files: existing, icon: buildDragIcon(iconHint || existing[0]) })
  } catch {}
  ev.returnValue = null
})

// ── IPC: Thumbnails ───────────────────────────────────────────────────────────
ipcMain.handle('thumb:create', async (_ev, filePath) => {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!['jpg','jpeg','png','gif','webp','bmp','ico','avif','svg','tiff','tif','heic'].includes(ext)) return null
  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > 30*1024*1024 && ext !== 'svg') return null
    const buf  = await fs.promises.readFile(filePath)
    const mime = ext==='svg' ? 'image/svg+xml' : (ext==='jpg'||ext==='jpeg') ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch { return null }
})
ipcMain.handle('thumb:readBase64', async (_ev, filePath) => {
  try { const s=await fs.promises.stat(filePath); if(s.size>5*1024*1024)return null; return(await fs.promises.readFile(filePath)).toString('base64') } catch { return null }
})

// ── IPC: SQLite ops ───────────────────────────────────────────────────────────

ipcMain.handle('db:load', () => dbLoadAll())

ipcMain.handle('db:insertAsset', (_ev, asset) => {
  if (!_db) return false
  try {
    dbRun(`INSERT OR IGNORE INTO assets (id,name,ext,filePath,size,width,height,duration,mtime,btime,importTime,rating,notes,url,deleted,deletedAt,hasThumb)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [asset.id, asset.name, asset.ext, asset.filePath,
       asset.size||0, asset.width||null, asset.height||null, asset.duration||null,
       asset.mtime||0, asset.btime||0, asset.importTime||Date.now(),
       asset.rating||0, asset.notes||'', asset.url||'',
       asset.deleted?1:0, asset.deletedAt||null, asset.hasThumb?1:0])
    writeRelations(asset)
    flushDB()
    // Rebuild dir watchers to include any new directories
    setImmediate(rebuildDirWatchers)
    return true
  } catch (e) { console.error('[DB] insertAsset:', e); return false }
})

ipcMain.handle('db:saveThumbnail', (_ev, id, dataUrl) => {
  try {
    const tp = thumbFilePath(id)
    const base64 = dataUrl.startsWith('data:') ? dataUrl.split(',')[1] : dataUrl
    fs.writeFileSync(tp, Buffer.from(base64, 'base64'))
    if (_db) { dbRun('UPDATE assets SET hasThumb=1 WHERE id=?', [id]); flushDB() }
    return 'file://' + tp.replace(/\\/g, '/')
  } catch (e) { console.error('[DB] saveThumbnail:', e); return null }
})

ipcMain.handle('db:updateAsset', (_ev, id, updates) => {
  if (!_db) return false
  try {
    const cur = dbGet('SELECT * FROM assets WHERE id=?', [id])
    if (!cur) return false
    dbRun(`UPDATE assets SET name=?,rating=?,notes=?,url=?,width=?,height=?,duration=?,deleted=?,deletedAt=?,hasThumb=? WHERE id=?`,
      [updates.name??cur.name, updates.rating??cur.rating, updates.notes??cur.notes, updates.url??cur.url,
       updates.width??cur.width, updates.height??cur.height, updates.duration??cur.duration,
       (updates.deleted!==undefined?updates.deleted:cur.deleted===1)?1:0,
       updates.deletedAt??cur.deletedAt,
       (updates.hasThumb!==undefined?updates.hasThumb:cur.hasThumb===1)?1:0,
       id])
    if (updates.tags       !== undefined) { dbRun('DELETE FROM asset_tags    WHERE assetId=?',[id]); for(const t of updates.tags){dbRun('INSERT OR IGNORE INTO asset_tags(assetId,tag)VALUES(?,?)',[id,t]);dbRun('INSERT OR IGNORE INTO tags(tag)VALUES(?)',[t])} }
    if (updates.folders    !== undefined) { dbRun('DELETE FROM asset_folders WHERE assetId=?',[id]); for(const f of updates.folders)dbRun('INSERT OR IGNORE INTO asset_folders(assetId,folderId)VALUES(?,?)',[id,f]) }
    if (updates.colors     !== undefined) { dbRun('DELETE FROM asset_colors  WHERE assetId=?',[id]); for(let i=0;i<updates.colors.length;i++)dbRun('INSERT INTO asset_colors(assetId,hex,ratio,sortOrder)VALUES(?,?,?,?)',[id,updates.colors[i].hex,updates.colors[i].ratio,i]) }
    if (updates.annotation !== undefined) { dbRun('DELETE FROM asset_annotations WHERE assetId=?',[id]); for(const a of updates.annotation)dbRun('INSERT OR REPLACE INTO asset_annotations(id,assetId,x,y,label)VALUES(?,?,?,?,?)',[a.id,id,a.x,a.y,a.label]) }
    flushDB()
    return true
  } catch (e) { console.error('[DB] updateAsset:', e); return false }
})

ipcMain.handle('db:batchUpdate', (_ev, ops) => {
  if (!_db) return false
  try {
    for (const { id, updates } of ops) {
      const cur = dbGet('SELECT * FROM assets WHERE id=?', [id]); if (!cur) continue
      dbRun(`UPDATE assets SET deleted=?,deletedAt=? WHERE id=?`,
        [(updates.deleted!==undefined?updates.deleted:cur.deleted===1)?1:0, updates.deletedAt??cur.deletedAt, id])
    }
    flushDB()
    return true
  } catch (e) { console.error('[DB] batchUpdate:', e); return false }
})

// Helper: check if a filePath lives inside a managed folder (inbox OR importCopyPath)
// Returns true if we should delete the file from disk when the asset is permanently deleted.
function isManagedFile(filePath) {
  try {
    const normalFp = path.resolve(filePath)
    // Check inbox folder
    const inboxDir = path.resolve(getInboxDir())
    if (normalFp.startsWith(inboxDir + path.sep) || normalFp.startsWith(inboxDir + '/')) return true
    // Check importCopyPath folder
    const s = loadSettings()
    if (s.importCopyPath) {
      const copyDir = path.resolve(s.importCopyPath)
      if (normalFp.startsWith(copyDir + path.sep) || normalFp.startsWith(copyDir + '/')) return true
    }
    return false
  } catch { return false }
}

// hardDeleteAssets: removes DB records + thumbnail + deletes the file from disk
// ONLY if the file is inside a managed folder (inbox or importCopyPath).
// Files from the user's original locations are NEVER deleted from disk here.
ipcMain.handle('db:hardDeleteAssets', async (_ev, ids) => {
  if (!_db) return false
  try {
    _suppressWatcher = true

    const CHUNK = 20
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)

      for (const id of chunk) {
        let row = null
        try { row = dbGet('SELECT filePath FROM assets WHERE id=?', [id]) } catch {}

        try {
          dbRun('DELETE FROM asset_tags        WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_folders     WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_colors      WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_annotations WHERE assetId=?', [id])
          dbRun('DELETE FROM assets            WHERE id=?',      [id])
        } catch {}

        // Always delete the thumbnail
        const tp = thumbFilePath(id)
        fs.promises.unlink(tp).catch(() => {})

        // Delete the source file ONLY if it lives in a managed folder
        if (row?.filePath && isManagedFile(row.filePath)) {
          fs.promises.unlink(row.filePath).catch(() => {})
        }
      }

      await new Promise(r => setImmediate(r))
    }

    flushDB()
    return true
  } catch (e) {
    console.error('[DB] hardDelete:', e)
    return false
  } finally {
    setTimeout(() => { _suppressWatcher = false }, 500)
  }
})

// hardDeleteAssetsFromDisk: like hardDeleteAssets but ALWAYS deletes the source file,
// regardless of which folder it is in. Used when user explicitly chooses "Delete from Disk".
ipcMain.handle('db:hardDeleteAssetsFromDisk', async (_ev, ids) => {
  if (!_db) return false
  try {
    _suppressWatcher = true

    const CHUNK = 20
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      for (const id of chunk) {
        let row = null
        try { row = dbGet('SELECT filePath FROM assets WHERE id=?', [id]) } catch {}
        try {
          dbRun('DELETE FROM asset_tags        WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_folders     WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_colors      WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_annotations WHERE assetId=?', [id])
          dbRun('DELETE FROM assets            WHERE id=?',      [id])
        } catch {}
        const tp = thumbFilePath(id)
        fs.promises.unlink(tp).catch(() => {})
        // Force-delete the source file from disk
        if (row?.filePath) fs.promises.unlink(row.filePath).catch(() => {})
      }
      await new Promise(r => setImmediate(r))
    }
    flushDB()
    return true
  } catch (e) { console.error('[DB] hardDeleteFromDisk:', e); return false }
  finally { setTimeout(() => { _suppressWatcher = false }, 500) }
})

// Show a delete confirmation dialog: returns true (delete from disk), false (remove from DB only), null (cancel)
ipcMain.handle('dialog:showDeleteOptions', async (_ev, { message }) => {
  if (!mainWindow) return null
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Delete Files',
    message: message || 'Delete these files?',
    buttons: ['Delete from Disk', 'Remove from Stag Only', 'Cancel'],
    defaultId: 1,
    cancelId: 2,
  })
  if (response === 0) return true    // delete from disk
  if (response === 1) return false   // DB only
  return null                        // cancelled
})

// Hard delete DB records and thumbnails ONLY — does NOT delete source files from disk
ipcMain.handle('db:hardDeleteAssetsDbOnly', async (_ev, ids) => {
  if (!_db) return false
  try {
    _suppressWatcher = true
    const CHUNK = 20
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      for (const id of chunk) {
        try {
          dbRun('DELETE FROM asset_tags        WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_folders     WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_colors      WHERE assetId=?', [id])
          dbRun('DELETE FROM asset_annotations WHERE assetId=?', [id])
          dbRun('DELETE FROM assets            WHERE id=?',      [id])
        } catch {}
        // Delete thumbnail only (NOT the source file)
        const tp = thumbFilePath(id)
        fs.promises.unlink(tp).catch(() => {})
      }
      await new Promise(r => setImmediate(r))
    }
    flushDB()
    return true
  } catch (e) {
    console.error('[DB] hardDeleteDbOnly:', e)
    return false
  } finally {
    setTimeout(() => { _suppressWatcher = false }, 500)
  }
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

ipcMain.handle('settings:moveLibrary', async (_ev, newPath) => {
  try {
    // Final flush before moving
    if (_db && _dbPath) { try { fs.writeFileSync(_dbPath, Buffer.from(_db.export())) } catch {} }
    _db = null; _SQL = null
    const oldDir = getDataDir()
    const newDir = path.join(newPath, 'stag-library')
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true })
    fs.cpSync(oldDir, newDir, { recursive: true })
    const s = loadSettings(); s.libraryPath = newDir; saveSettings(s); _dataDir = newDir
    await initDB()
    return { success: true, newPath: newDir }
  } catch (e) { console.error(e); return { success: false, error: String(e) } }
})

// ── IPC: Settings / misc ──────────────────────────────────────────────────────
ipcMain.handle('settings:load',           ()       => loadSettings())
ipcMain.handle('settings:save', (_ev, incoming) => {
  // Always read webGrabPath from disk first and preserve it — it is managed
  // exclusively by bridge:setWebGrabPath and must never be overwritten here.
  let webGrabPath
  try { webGrabPath = loadSettings().webGrabPath } catch {}
  const toWrite = { ...incoming }
  if (webGrabPath) toWrite.webGrabPath = webGrabPath
  else delete toWrite.webGrabPath
  saveSettings(toWrite)
  return true
})
ipcMain.handle('settings:getLibraryPath', ()       => getDataDir())
ipcMain.handle('app:getVersion',          ()       => app.getVersion())
ipcMain.handle('app:getPlatform',         ()       => process.platform)
ipcMain.handle('hash:file', (_ev, p) => { try{return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')}catch{return null} })
ipcMain.handle('bridge:getPort',          ()       => BRIDGE_PORT)
ipcMain.handle('watchers:rebuild',        ()       => { setImmediate(rebuildDirWatchers); return true })
ipcMain.handle('bridge:getWebGrabPath',   ()       => getInboxDir())

// ── Import copy path — get / set ──────────────────────────────────────────────
ipcMain.handle('importCopy:getPath', () => {
  try { return loadSettings().importCopyPath || '' } catch { return '' }
})
ipcMain.handle('importCopy:setPath', (_ev, p) => {
  try {
    const s = loadSettings()
    if (!p || !p.trim()) { delete s.importCopyPath; delete s.importCopyEnabled }
    else { s.importCopyPath = p.trim(); if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) }
    saveSettings(s)
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e) } }
})
ipcMain.handle('importCopy:setEnabled', (_ev, enabled) => {
  try { const s = loadSettings(); s.importCopyEnabled = !!enabled; saveSettings(s); return true } catch { return false }
})
// Copy files to the configured import-copy folder and return new paths
ipcMain.handle('importCopy:copyFiles', async (_ev, filePaths) => {
  const s = loadSettings()
  if (!s.importCopyEnabled || !s.importCopyPath) return { ok: false, reason: 'disabled' }
  const dest = s.importCopyPath
  if (!fs.existsSync(dest)) { try { fs.mkdirSync(dest, { recursive: true }) } catch (e) { return { ok: false, reason: String(e) } } }
  const results = []
  for (const src of filePaths) {
    try {
      const base = path.basename(src)
      let destFile = path.join(dest, base)
      // Avoid overwriting — append counter if file already exists
      if (fs.existsSync(destFile) && path.resolve(src) !== path.resolve(destFile)) {
        const ext2 = path.extname(base)
        const stem = path.basename(base, ext2)
        let i = 1
        while (fs.existsSync(destFile)) { destFile = path.join(dest, `${stem}_${i++}${ext2}`) }
      }
      if (path.resolve(src) !== path.resolve(destFile)) {
        fs.copyFileSync(src, destFile)
      }
      results.push({ src, dest: destFile, ok: true })
    } catch (e) { results.push({ src, dest: null, ok: false, error: String(e) }) }
  }
  return { ok: true, results }
})
// Check if a file path is inside the import-copy folder
// isCopiedFile: returns true if the file lives in a managed folder (importCopyPath OR inbox).
// Used by the renderer to decide whether to auto-delete or prompt the user.
ipcMain.handle('importCopy:isCopiedFile', (_ev, filePath) => {
  return isManagedFile(filePath)
})
ipcMain.handle('bridge:setWebGrabPath',   (_ev, p) => {
  try {
    const s = loadSettings()
    if (!p || !p.trim()) {
      // Reset to default
      delete s.webGrabPath; saveSettings(s)
    } else {
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
      s.webGrabPath = p; saveSettings(s)
    }
    setImmediate(restartInboxWatcher)
    return { ok: true, path: p || '' }
  } catch (e) { return { ok: false, error: String(e) } }
})

// ── IPC: Ollama AI tagging ─────────────────────────────────────────────────────
// Node.js 18+ resolves 'localhost' to ::1 (IPv6) by default, but Ollama binds
// to 127.0.0.1 (IPv4). Fix: always swap localhost → 127.0.0.1 in the URL.
function normalizeOllamaUrl(raw) {
  const base = (raw || 'http://localhost:11434').trim().replace(/\/$/, '')
  return base.replace(/\/\/localhost(:|$|\/)/i, '//127.0.0.1$1')
}
// All HTTP calls to Ollama happen in the main process (no CORS issues, logging available)

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

// Tag a single image — returns { ok: true, tags, description } or { ok: false, error, fatal }
// fatal=true means connection is down (stop entire session), false means skip this image
ipcMain.handle('ollama:tagImage', async (_ev, filePath, model, baseUrl) => {
  const url = normalizeOllamaUrl(baseUrl)
  if (isDev) console.log(`[Ollama] Tagging: ${path.basename(filePath)} model=${model}`)

  let imageBase64
  try {
    const buf = await fs.promises.readFile(filePath)
    imageBase64 = buf.toString('base64')
  } catch (e) {
    return { ok: false, error: `Cannot read file: ${e.message}`, fatal: false }
  }

  const prompt = `Analyze this image carefully. Reply with ONLY valid JSON — no markdown, no explanation, nothing else.

Format:
{"description":"one clear sentence describing what is in the image","tags":["tag1","tag2","tag3"]}

Tag rules (include ALL that apply, 6-15 tags):
- MEDIUM/SOURCE: "video game", "3d render", "digital art", "illustration", "photography", "anime", "painting", "sketch", "screenshot", "ui design", "pixel art", "real life" etc.
- SUBJECT: people, animals, vehicles (car, bike, motorcycle, truck), objects, food, nature, architecture, characters, etc.
- GENRE/CONTEXT: fantasy, sci-fi, horror, action, sports, nature, urban, cyberpunk, medieval, futuristic etc.
- MOOD/TONE: dark, vibrant, moody, peaceful, dramatic, cinematic, minimalist, chaotic etc.
- COLORS: dominant colors if distinctive (e.g. "dark palette", "neon colors", "monochrome", "warm tones")
- STYLE: realistic, stylized, cartoon, hyper-realistic, low-poly, retro etc.
- SPECIFIC DETAILS: brand names, recognizable characters/games/shows if clearly identifiable

Use lowercase. Be specific — "sports car" not just "car", "mountain landscape" not just "landscape".`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 90000)
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, images: [imageBase64], stream: false, think: false, options: { temperature: 0.1, num_predict: 400 } }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0,100)}`, fatal: res.status >= 500 }
    }
    const data = await res.json()
    const raw = (data.response || '').trim()
    if (isDev) console.log(`[Ollama] Response for ${path.basename(filePath)}: ${raw.slice(0, 300)}`)

    // Strip markdown fences if model wrapped the JSON
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    // Try to extract JSON object even if there's preamble text
    const jsonMatch = cleaned.match(/\{[\s\S]*"tags"[\s\S]*\}/) || cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      if (isDev) console.log(`[Ollama] Could not find JSON in: ${raw.slice(0,200)}`)
      return { ok: false, error: 'No JSON in response', fatal: false }
    }
    let parsed
    try { parsed = JSON.parse(jsonMatch[0]) }
    catch (pe) { return { ok: false, error: `JSON parse failed: ${pe.message}`, fatal: false } }

    const tags = (parsed.tags || []).map((t) => String(t).trim().toLowerCase()).filter(t => t.length > 0 && t.length < 40).slice(0, 15)
    const description = String(parsed.description || '').trim().slice(0, 500)
    if (isDev) console.log(`[Ollama] ✓ ${path.basename(filePath)} → [${tags.join(', ')}]`)
    return { ok: true, tags, description }
  } catch (e) {
    const msg = String(e.message || e)
    const fatal = msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('abort') || msg.includes('network')
    if (isDev) console.log(`[Ollama] ✗ ${path.basename(filePath)}: ${msg} (fatal=${fatal})`)
    return { ok: false, error: msg, fatal }
  }
})

// DB: mark asset as AI-tagged (stores description + merges tags)
ipcMain.handle('db:setAiTagged', (_ev, id, description, newTags) => {
  try {
    dbRun('UPDATE assets SET aiTagged=1, aiDescription=? WHERE id=?', [description || '', id])
    // Merge new tags without removing existing ones
    for (const tag of (newTags || [])) {
      dbRun('INSERT OR IGNORE INTO asset_tags (assetId,tag) VALUES (?,?)', [id, tag])
      dbRun('INSERT OR IGNORE INTO tags (tag) VALUES (?)', [tag])
    }
    flushDB()
    return true
  } catch (e) { console.error('[DB] setAiTagged:', e); return false }
})

// DB: get all image assets that haven't been AI-tagged yet
ipcMain.handle('db:getUntaggedImages', () => {
  try {
    const imageExts = ['jpg','jpeg','png','gif','webp','bmp','tiff','tif','avif','heic','heif']
    const placeholders = imageExts.map(() => '?').join(',')
    return dbAll(
      `SELECT id, name, ext, filePath FROM assets WHERE deleted=0 AND (aiTagged IS NULL OR aiTagged=0) AND ext IN (${placeholders}) ORDER BY importTime DESC`,
      imageExts
    )
  } catch (e) { console.error('[DB] getUntaggedImages:', e); return [] }
})
