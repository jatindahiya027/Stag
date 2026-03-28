import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'

let mainWindow: BrowserWindow | null = null
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// ── JSON persistence (zero native deps) ──────────────────────────────────────
function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'eagle-clone')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function loadDB(): Record<string, any> {
  try {
    const f = path.join(getDataDir(), 'library.json')
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'))
  } catch {}
  return { assets: [], folders: [], tags: [], smartFolders: [] }
}

function saveDB(data: Record<string, any>) {
  try {
    fs.writeFileSync(path.join(getDataDir(), 'library.json'), JSON.stringify(data, null, 2))
  } catch (e) { console.error('saveDB', e) }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark'
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: false,
    backgroundColor: '#111214',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
mainWindow.webContents.openDevTools()

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (!mainWindow) createWindow() })

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize())
ipcMain.handle('window:close',    () => mainWindow?.close())

ipcMain.handle('dialog:openFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'All Supported', extensions: [
      'jpg','jpeg','png','gif','webp','svg','bmp','tiff','ico','avif',
      'mp4','webm','mov','avi','mkv','mp3','wav','flac','aac','m4a',
      'pdf','psd','ai','sketch','xd','fig','ttf','otf','woff','woff2',
    ]}],
  })
  return res.filePaths
})

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
  return res.filePaths[0] || null
})

ipcMain.handle('fs:getFileInfo', (_ev, filePath: string) => {
  try {
    const s = fs.statSync(filePath)
    return { size: s.size, mtime: s.mtimeMs, btime: s.birthtimeMs }
  } catch { return null }
})

ipcMain.handle('fs:readDir', (_ev, dirPath: string) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).map(f => ({
      name: f.name, isDirectory: f.isDirectory(), path: path.join(dirPath, f.name),
    }))
  } catch { return [] }
})

ipcMain.handle('fs:exists', (_ev, p: string) => fs.existsSync(p))

ipcMain.handle('shell:openPath',     (_ev, p: string) => shell.openPath(p))
ipcMain.handle('shell:showInFolder', (_ev, p: string) => shell.showItemInFolder(p))

ipcMain.handle('hash:file', (_ev, filePath: string) => {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex')
  } catch { return null }
})

// Read image as data URL for thumbnails (no sharp needed)
ipcMain.handle('thumb:create', (_ev, filePath: string) => {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const imgExts = ['jpg','jpeg','png','gif','webp','bmp','svg','ico','avif']
  if (!imgExts.includes(ext)) return null
  try {
    const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
  } catch { return null }
})

ipcMain.handle('db:load', () => loadDB())
ipcMain.handle('db:save', (_ev, data: Record<string, any>) => { saveDB(data); return true })

ipcMain.handle('app:getVersion',  () => app.getVersion())
ipcMain.handle('app:getPlatform', () => process.platform)
