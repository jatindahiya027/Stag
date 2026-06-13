const fs = require('fs')
const os = require('os')
const path = require('path')
const { Writable } = require('stream')
const pino = require('pino')

const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_LOG_FILES = 5

function readPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function getLogDir(app) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    const dir = path.join(os.tmpdir(), 'stag-logs')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
}

function safeError(err) {
  if (!err) return err
  return {
    name: err.name,
    message: err.message || String(err),
    stack: err.stack,
    code: err.code,
  }
}

function summarizeValue(value, depth = 0) {
  if (value == null) return value
  if (depth > 2) return '[depth-limit]'
  if (value instanceof Error) return safeError(value)
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`
  if (Array.isArray(value)) {
    const shown = value.slice(0, 20).map(v => summarizeValue(v, depth + 1))
    if (value.length > shown.length) shown.push(`... ${value.length - shown.length} more`)
    return shown
  }
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return `[data-url ${value.length} chars]`
    if (value.length > 500) return value.slice(0, 500) + `... [${value.length} chars]`
    return value
  }
  if (typeof value !== 'object') return value

  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (/thumbnailData|dataUrl|base64|image|buffer/i.test(k)) {
      out[k] = typeof v === 'string' ? `[${k} ${v.length} chars]` : summarizeValue(v, depth + 1)
      continue
    }
    out[k] = summarizeValue(v, depth + 1)
  }
  return out
}

function readableChannel(channel) {
  if (!channel) return 'unknown action'
  return String(channel)
    .replace(/^db:/, 'database ')
    .replace(/^ai:/, 'AI ')
    .replace(/^app:/, 'app ')
    .replace(/^thumb:/, 'thumbnail ')
    .replace(/[._:-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

function rotatedLogPath(logFile, index) {
  const ext = path.extname(logFile)
  const base = path.basename(logFile, ext)
  return path.join(path.dirname(logFile), `${base}-${index}${ext}`)
}

class RotatingFileStream extends Writable {
  constructor(logFile, options = {}) {
    super({ decodeStrings: false })
    this.logFile = logFile
    this.maxBytes = options.maxBytes || DEFAULT_MAX_LOG_BYTES
    this.maxFiles = options.maxFiles || DEFAULT_MAX_LOG_FILES
    this.currentSize = 0
    this.rotating = false
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    this.currentSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0
    if (this.currentSize >= this.maxBytes) this.rotateSync()
    this.stream = fs.createWriteStream(logFile, { flags: 'a' })
  }

  rotateSync() {
    for (let i = this.maxFiles; i >= 1; i--) {
      const src = rotatedLogPath(this.logFile, i)
      if (!fs.existsSync(src)) continue
      if (i === this.maxFiles) {
        fs.unlinkSync(src)
      } else {
        fs.renameSync(src, rotatedLogPath(this.logFile, i + 1))
      }
    }
    if (fs.existsSync(this.logFile)) fs.renameSync(this.logFile, rotatedLogPath(this.logFile, 1))
    this.currentSize = 0
  }

  rotate(callback) {
    if (this.rotating) {
      setTimeout(() => this.rotate(callback), 10)
      return
    }
    this.rotating = true
    this.stream.end(() => {
      try {
        this.rotateSync()
        this.stream = fs.createWriteStream(this.logFile, { flags: 'a' })
        this.rotating = false
        callback()
      } catch (err) {
        this.rotating = false
        this.stream = fs.createWriteStream(this.logFile, { flags: 'a' })
        callback(err)
      }
    })
  }

  _write(chunk, encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding)
    const writeChunk = () => {
      this.currentSize += buffer.length
      this.stream.write(buffer, callback)
    }

    if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
      this.rotate(err => {
        if (err) callback(err)
        else writeChunk()
      })
      return
    }
    writeChunk()
  }

  _final(callback) {
    this.stream.end(callback)
  }
}

function createLogger(app) {
  const logDir = getLogDir(app)
  const logFile = path.join(logDir, 'stag.log')
  const level = process.env.STAG_LOG_LEVEL || (app.isPackaged ? 'info' : 'debug')
  const maxBytes = readPositiveInt(process.env.STAG_LOG_MAX_BYTES, DEFAULT_MAX_LOG_BYTES)
  const maxFiles = readPositiveInt(process.env.STAG_LOG_MAX_FILES, DEFAULT_MAX_LOG_FILES)
  const stream = new RotatingFileStream(logFile, { maxBytes, maxFiles })
  const logger = pino({
    name: 'stag',
    level,
    base: {
      pid: process.pid,
      platform: process.platform,
      version: app.getVersion?.(),
      packaged: app.isPackaged,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }, stream)

  logger.logFile = logFile
  logger.logDir = logDir
  logger.rotation = { maxBytes, maxFiles }
  logger.summarize = summarizeValue
  logger.safeError = safeError
  logger.childFor = (name, bindings = {}) => logger.child({ module: name, ...bindings })
  return logger
}

function installConsoleBridge(logger) {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }
  const bridge = (level, originalFn) => (...args) => {
    try {
      logger[level]({ source: 'console', args: summarizeValue(args) }, args.map(a => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return a.message
        try { return JSON.stringify(summarizeValue(a)) } catch { return String(a) }
      }).join(' '))
    } catch {}
    originalFn(...args)
  }
  console.log = bridge('info', original.log)
  console.info = bridge('info', original.info)
  console.warn = bridge('warn', original.warn)
  console.error = bridge('error', original.error)
  console.debug = bridge('debug', original.debug)
}

function installIpcLogging(ipcMain, logger) {
  const ipcLog = logger.childFor('ipc')
  const originalHandle = ipcMain.handle.bind(ipcMain)
  const originalOn = ipcMain.on.bind(ipcMain)

  ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, ...args) => {
    const started = Date.now()
    const meta = { channel, args: summarizeValue(args) }
    const action = readableChannel(channel)
    if (channel !== 'log:renderer') ipcLog.debug(meta, `${action} started`)
    try {
      const result = await handler(event, ...args)
      if (channel !== 'log:renderer') {
        ipcLog.info({
          channel,
          durationMs: Date.now() - started,
          result: summarizeValue(result),
        }, `${action} completed in ${Date.now() - started}ms`)
      }
      return result
    } catch (err) {
      ipcLog.error({
        channel,
        durationMs: Date.now() - started,
        err: safeError(err),
      }, `${action} failed after ${Date.now() - started}ms`)
      throw err
    }
  })

  ipcMain.on = (channel, listener) => originalOn(channel, (event, ...args) => {
    const started = Date.now()
    const action = readableChannel(channel)
    ipcLog.debug({ channel, args: summarizeValue(args) }, `${action} event started`)
    try {
      const result = listener(event, ...args)
      ipcLog.info({ channel, durationMs: Date.now() - started }, `${action} event completed in ${Date.now() - started}ms`)
      return result
    } catch (err) {
      ipcLog.error({ channel, durationMs: Date.now() - started, err: safeError(err) }, `${action} event failed after ${Date.now() - started}ms`)
      throw err
    }
  })
}

module.exports = {
  createLogger,
  installConsoleBridge,
  installIpcLogging,
  safeError,
}
