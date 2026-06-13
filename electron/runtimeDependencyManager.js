const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const CORE_RUNTIME_VERSION = 2
const AI_RUNTIME_VERSION = 1
const IMAGEMAGICK_BINARY_INDEX = 'https://imagemagick.org/archive/binaries/'
const INTERNET_PROBES = [
  'https://github.com/',
  'https://conda.anaconda.org/',
  'https://huggingface.co/',
]
const AI_PACKAGES = [
  'faiss-cpu>=1.8,<2',
  'huggingface_hub>=0.34,<2',
  'numpy>=1.24,<3',
  'pillow>=10,<13',
  'pytorch>=2.2,<3',
  'safetensors>=0.4,<1',
  'sentencepiece>=0.2,<1',
  'torchvision>=0.17,<1',
  'tqdm>=4.66,<5',
  'transformers>=4.56,<5',
]
const WINDOWS_AI_PIP_PACKAGES = [
  'faiss-cpu>=1.8,<2',
  'huggingface_hub>=0.34,<2',
  'numpy>=1.24,<3',
  'pillow>=10,<13',
  'safetensors>=0.4,<1',
  'sentencepiece>=0.2,<1',
  'tqdm>=4.66,<5',
  'transformers>=4.56,<5',
]

function hasReadyCoreRuntime(root, windows) {
  const pythonDir = path.join(root, 'python')
  const python = windows ? path.join(pythonDir, 'python.exe') : path.join(pythonDir, 'bin', 'python3')
  const ffmpeg = windows ? path.join(pythonDir, 'Library', 'bin', 'ffmpeg.exe') : path.join(pythonDir, 'bin', 'ffmpeg')
  const ffprobe = windows ? path.join(pythonDir, 'Library', 'bin', 'ffprobe.exe') : path.join(pythonDir, 'bin', 'ffprobe')
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'stag-core-runtime.json'), 'utf8'))
    return fs.existsSync(python) && fs.existsSync(ffmpeg) && fs.existsSync(ffprobe) && marker?.ready === true
  } catch {
    return false
  }
}

function firstExisting(candidates) {
  return candidates.find(candidate => fs.existsSync(candidate)) || null
}

function runtimeToolEnvironment(paths, baseEnv = process.env, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const ghostscript = paths.ghostscript || firstExisting(paths.ghostscriptCandidates || [])
  const binaryDirs = [paths.magick, ghostscript, paths.ffmpeg, paths.ffprobe]
    .filter(Boolean)
    .map(executable => pathApi.dirname(executable))
  const env = {
    ...baseEnv,
    PATH: [...new Set(binaryDirs), baseEnv.PATH || ''].filter(Boolean).join(pathApi.delimiter),
    MAGICK_ERRORMODE: '1',
  }
  if (paths.magick) env.MAGICK_HOME = pathApi.dirname(paths.magick)
  if (platform === 'win32' && paths.pythonDir) {
    const ghostscriptRoot = pathApi.join(paths.pythonDir, 'Library')
    env.GS_LIB = [
      pathApi.join(ghostscriptRoot, 'Init'),
      pathApi.join(ghostscriptRoot, 'Font'),
      pathApi.join(ghostscriptRoot, 'CMap'),
      baseEnv.GS_LIB,
    ].filter(Boolean).join(pathApi.delimiter)
  }
  return env
}

function runtimePaths(app) {
  const windows = process.platform === 'win32'
  const legacyRoot = path.join(app.getPath('userData'), 'runtime')
  const homeRuntime = path.join(app.getPath('home'), '.stag', 'runtime')
  const preferredRoot = process.platform === 'darwin'
    ? (homeRuntime.includes(' ')
        ? path.join('/Users/Shared', `StagRuntime-${process.getuid?.() ?? 'user'}`)
        : homeRuntime)
    : legacyRoot
  const root = hasReadyCoreRuntime(legacyRoot, windows) ? legacyRoot : preferredRoot
  const pythonDir = path.join(root, 'python')
  const imageMagickDir = path.join(root, 'imagemagick')
  return {
    root,
    pythonDir,
    python: windows ? path.join(pythonDir, 'python.exe') : path.join(pythonDir, 'bin', 'python3'),
    ffmpeg: windows ? path.join(pythonDir, 'Library', 'bin', 'ffmpeg.exe') : path.join(pythonDir, 'bin', 'ffmpeg'),
    ffprobe: windows ? path.join(pythonDir, 'Library', 'bin', 'ffprobe.exe') : path.join(pythonDir, 'bin', 'ffprobe'),
    imageMagickDir,
    magick: windows ? path.join(imageMagickDir, 'magick.exe') : path.join(pythonDir, 'bin', 'magick'),
    ghostscriptCandidates: windows
      ? [
          path.join(pythonDir, 'Library', 'bin', 'gswin64c.exe'),
          path.join(pythonDir, 'Library', 'bin', 'gs.exe'),
          path.join(pythonDir, 'Scripts', 'gswin64c.exe'),
        ]
      : [path.join(pythonDir, 'bin', 'gs')],
    coreMarker: path.join(root, 'stag-core-runtime.json'),
    aiMarker: path.join(root, 'stag-ai-runtime.json'),
    state: path.join(root, 'install-state.json'),
    log: path.join(root, 'install.log'),
    installer: path.join(root, windows ? 'Miniforge3-installer.exe' : 'Miniforge3-installer.sh'),
    imageMagickInstaller: path.join(root, 'ImageMagick-installer.exe'),
  }
}

function installerUrl() {
  if (process.platform === 'darwin') {
    return `https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-MacOSX-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.sh`
  }
  if (process.platform === 'win32') {
    // Native PyTorch and FAISS packages are not published for Windows ARM64.
    // Windows 11 ARM runs this x64 runtime using built-in x64 emulation.
    return 'https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Windows-x86_64.exe'
  }
  throw new Error(`Unsupported runtime platform: ${process.platform}-${process.arch}`)
}

function runtimeCondaSubdir(platform = process.platform, arch = process.arch) {
  return platform === 'win32' && arch === 'arm64' ? 'win-64' : null
}

function aiInstallerKind(platform = process.platform) {
  return platform === 'win32' ? 'pip' : 'conda'
}

function imageMagickInstallerArch(platform = process.platform, arch = process.arch) {
  if (platform !== 'win32') return null
  return arch === 'arm64' ? 'arm64' : 'x64'
}

function selectImageMagickInstaller(html, arch) {
  const escapedArch = String(arch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`ImageMagick-(\\d+)\\.(\\d+)\\.(\\d+)-(\\d+)-Q8-${escapedArch}-static\\.exe`, 'g')
  const matches = [...String(html).matchAll(pattern)]
  if (!matches.length) return null
  matches.sort((left, right) => {
    const a = left.slice(1, 5).map(Number)
    const b = right.slice(1, 5).map(Number)
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i]
    }
    return 0
  })
  return `${IMAGEMAGICK_BINARY_INDEX}${matches.at(-1)[0]}`
}

function sanitizeTerminalOutput(value) {
  let text = String(value || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\[[0-9;?]*[A-HJKSTfmsu]/g, '')

  let previous
  do {
    previous = text
    text = text.replace(/[^\r\n]\u0008/g, '')
  } while (text !== previous)

  const lines = text
    .replace(/\u0008/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return lines.at(-1) || ''
}

function parseProgressPercent(value) {
  const text = String(value || '')
  const percentMatches = [...text.matchAll(/(?:^|[^\d])(\d{1,3}(?:\.\d+)?)\s*%/g)]
  if (percentMatches.length) {
    return Math.max(0, Math.min(100, Math.round(Number(percentMatches.at(-1)[1]))))
  }

  const sizeMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/i,
  )
  if (!sizeMatch) return null
  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }
  const done = Number(sizeMatch[1]) * units[sizeMatch[2].toUpperCase()]
  const total = Number(sizeMatch[3]) * units[sizeMatch[4].toUpperCase()]
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

function createRuntimeDependencyManager({ app, sendProgress, logger }) {
  const paths = runtimePaths(app)
  let corePromise = null
  let aiPromise = null
  let status = readJson(paths.state) || { type: isCoreReady() ? 'core_ready' : 'pending' }

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }

  function isCoreReady() {
    const marker = readJson(paths.coreMarker)
    return fs.existsSync(paths.python) &&
      fs.existsSync(paths.ffmpeg) &&
      fs.existsSync(paths.ffprobe) &&
      fs.existsSync(paths.magick) &&
      !!firstExisting(paths.ghostscriptCandidates) &&
      marker?.ready === true &&
      marker?.version === CORE_RUNTIME_VERSION
  }

  function isAiReady() {
    const marker = readJson(paths.aiMarker)
    return isCoreReady() && marker?.ready === true && marker?.version === AI_RUNTIME_VERSION
  }

  function emit(next) {
    status = { ...next, updatedAt: new Date().toISOString(), logPath: paths.log }
    fs.mkdirSync(paths.root, { recursive: true })
    fs.writeFileSync(paths.state, JSON.stringify(status, null, 2))
    sendProgress?.(status)
    logger?.info?.({ runtime: status }, 'runtime dependency status')
  }

  async function checkInternet() {
    const attempts = await Promise.allSettled(INTERNET_PROBES.map(async url => {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      })
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`)
      return url
    }))
    const online = attempts.some(result => result.status === 'fulfilled')
    logger?.info?.({ online }, 'runtime internet check')
    return { online }
  }

  async function download(url, destination, phase = { type: 'downloading_python', label: 'Downloading Python' }) {
    emit({ ...phase, bytesDone: 0, bytesTotal: 0 })
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`${phase.label} failed: HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') || 0)
    const partial = `${destination}.part`
    const stream = fs.createWriteStream(partial)
    const reader = response.body.getReader()
    let done = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        const bytes = Buffer.from(chunk.value)
        if (!stream.write(bytes)) await new Promise(resolve => stream.once('drain', resolve))
        done += bytes.length
        emit({
          ...phase,
          bytesDone: done,
          bytesTotal: total,
          progressPercent: total > 0 ? Math.round((done / total) * 100) : undefined,
        })
      }
    } finally {
      await new Promise(resolve => stream.end(resolve))
    }
    fs.renameSync(partial, destination)
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o755)
  }

  function run(command, args, phase, { env = {} } = {}) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(paths.root, { recursive: true })
      const logStream = fs.createWriteStream(paths.log, { flags: 'a' })
      logStream.write(`\n[${new Date().toISOString()}] ${command} ${args.join(' ')}\n`)
      const child = spawn(command, args, {
        windowsHide: true,
        env: {
          ...process.env,
          ...env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONNOUSERSITE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let lastLine = ''
      let terminalOutput = ''
      const onData = chunk => {
        const text = String(chunk)
        logStream.write(text)
        terminalOutput = `${terminalOutput}${text}`.slice(-16384)
        const cleanLine = sanitizeTerminalOutput(terminalOutput)
        if (cleanLine) lastLine = cleanLine
        const progressPercent = parseProgressPercent(lastLine)
        emit({
          type: phase.type,
          label: phase.label,
          detail: lastLine || undefined,
          progressPercent: progressPercent ?? undefined,
        })
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', error => {
        logStream.end()
        reject(error)
      })
      child.on('close', code => {
        logStream.end()
        code === 0 ? resolve() : reject(new Error(`${phase.label} failed with exit code ${code}${lastLine ? `: ${lastLine}` : ''}`))
      })
    })
  }

  async function installPython() {
    if (fs.existsSync(paths.python)) return
    fs.mkdirSync(paths.root, { recursive: true })
    if (!fs.existsSync(paths.installer)) {
      await download(installerUrl(), paths.installer, {
        type: 'downloading_python',
        label: 'Downloading Python',
      })
    }
    emit({ type: 'installing_python', label: 'Installing Python' })
    if (process.platform === 'win32') {
      await run(paths.installer, [
        '/InstallationType=JustMe',
        '/RegisterPython=0',
        '/AddToPath=0',
        '/S',
        `/D=${paths.pythonDir}`,
      ], { type: 'installing_python', label: 'Installing Python' })
    } else {
      await run('/bin/bash', [paths.installer, '-b', '-p', paths.pythonDir], {
        type: 'installing_python',
        label: 'Installing Python',
      })
    }
  }

  async function condaInstall(packages, phase) {
    const subdir = runtimeCondaSubdir()
    const args = [
      '-m', 'conda', 'install', '-y', '-p', paths.pythonDir,
      '--override-channels', '-c', 'conda-forge',
    ]
    args.push(...packages)
    await run(paths.python, args, phase, {
      env: subdir ? { CONDA_SUBDIR: subdir } : {},
    })
  }

  async function installImageMagick() {
    if (fs.existsSync(paths.magick)) return
    if (process.platform !== 'win32') {
      await condaInstall(['imagemagick>=7,<8'], {
        type: 'installing_imagemagick',
        label: 'Downloading and installing ImageMagick',
      })
      return
    }

    const arch = imageMagickInstallerArch()
    emit({ type: 'downloading_imagemagick', label: 'Finding ImageMagick download' })
    const response = await fetch(IMAGEMAGICK_BINARY_INDEX, { redirect: 'follow' })
    if (!response.ok) throw new Error(`ImageMagick download lookup failed: HTTP ${response.status}`)
    const url = selectImageMagickInstaller(await response.text(), arch)
    if (!url) throw new Error(`No official ImageMagick installer found for Windows ${arch}`)
    await download(url, paths.imageMagickInstaller, {
      type: 'downloading_imagemagick',
      label: 'Downloading ImageMagick',
    })
    fs.mkdirSync(paths.imageMagickDir, { recursive: true })
    await run(paths.imageMagickInstaller, [
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      `/DIR=${paths.imageMagickDir}`,
      '/TASKS=',
    ], {
      type: 'installing_imagemagick',
      label: 'Installing ImageMagick',
    })
    if (!fs.existsSync(paths.magick)) throw new Error(`ImageMagick executable missing after install: ${paths.magick}`)
    try { fs.unlinkSync(paths.imageMagickInstaller) } catch {}
  }

  async function installGhostscript() {
    if (firstExisting(paths.ghostscriptCandidates)) return
    await condaInstall(['ghostscript>=10,<11'], {
      type: 'installing_ghostscript',
      label: 'Downloading and installing Ghostscript',
    })
    if (!firstExisting(paths.ghostscriptCandidates)) {
      throw new Error(`Ghostscript executable missing after install in ${paths.pythonDir}`)
    }
  }

  async function pipInstall(packages, phase, extraArgs = []) {
    await run(paths.python, [
      '-m', 'pip', 'install',
      '--disable-pip-version-check',
      '--no-input',
      '--prefer-binary',
      '--only-binary=:all:',
      ...extraArgs,
      ...packages,
    ], phase)
  }

  async function installAiPackages() {
    if (aiInstallerKind() !== 'pip') {
      await condaInstall(AI_PACKAGES, {
        type: 'optimizing',
        label: 'Optimizing for your hardware',
      })
      return
    }
    await pipInstall(
      ['torch>=2.4,<3', 'torchvision>=0.19,<1'],
      {
        type: 'optimizing',
        label: 'Installing AI engine',
      },
      ['--index-url', 'https://download.pytorch.org/whl/cpu'],
    )
    await pipInstall(WINDOWS_AI_PIP_PACKAGES, {
      type: 'optimizing',
      label: 'Installing AI libraries',
    })
  }

  async function ensureCore({ force = false } = {}) {
    if (!force && isCoreReady()) {
      emit({ type: 'core_ready', label: 'Media tools ready' })
      return { ok: true, ...getPaths() }
    }
    if (corePromise) return corePromise
    corePromise = (async () => {
      try {
        await installPython()
        if (force || !fs.existsSync(paths.ffmpeg) || !fs.existsSync(paths.ffprobe)) {
          await condaInstall(['ffmpeg>=6,<9'], {
            type: 'installing_ffmpeg',
            label: 'Downloading and installing FFmpeg',
          })
        }
        if (force && process.platform === 'win32') {
          try { fs.rmSync(paths.imageMagickDir, { recursive: true, force: true }) } catch {}
        }
        if (force || !fs.existsSync(paths.magick)) await installImageMagick()
        if (force || !firstExisting(paths.ghostscriptCandidates)) await installGhostscript()
        const installedPaths = getPaths()
        const toolEnv = runtimeToolEnvironment(installedPaths)
        await run(installedPaths.magick, ['-version'], {
          type: 'verifying_media_tools',
          label: 'Verifying ImageMagick',
        }, { env: toolEnv })
        await run(installedPaths.ghostscript, ['--version'], {
          type: 'verifying_media_tools',
          label: 'Verifying Ghostscript',
        }, { env: toolEnv })
        fs.writeFileSync(paths.coreMarker, JSON.stringify({
          ready: true,
          version: CORE_RUNTIME_VERSION,
          target: `${process.platform}-${process.arch}`,
          installedAt: new Date().toISOString(),
        }, null, 2))
        try { fs.unlinkSync(paths.installer) } catch {}
        emit({ type: 'core_ready', label: 'Media tools ready' })
        return { ok: true, ...getPaths() }
      } catch (error) {
        const message = String(error?.message || error)
        emit({ type: 'error', label: 'Dependency installation failed', error: message })
        return { ok: false, error: message, logPath: paths.log }
      } finally {
        corePromise = null
      }
    })()
    return corePromise
  }

  async function ensureAi({ force = false } = {}) {
    if (!force && isAiReady()) {
      emit({ type: 'done', label: 'AI runtime ready' })
      return { ok: true, ...getPaths() }
    }
    if (aiPromise) return aiPromise
    aiPromise = (async () => {
      try {
        const core = await ensureCore({ force })
        if (!core.ok) return core
        if (!force && isAiReady()) {
          emit({ type: 'done', label: 'AI runtime ready' })
          return { ok: true, ...getPaths() }
        }
        emit({ type: 'optimizing', label: 'Optimizing for your hardware' })
        await installAiPackages()
        await run(paths.python, ['-c', [
          'import faiss',
          'import numpy',
          'import PIL',
          'import torch',
          'import torchvision',
          'import transformers',
          'import tqdm',
          'print("AI runtime imports verified")',
        ].join('; ')], {
          type: 'verifying_ai',
          label: 'Verifying AI dependencies',
        })
        fs.writeFileSync(paths.aiMarker, JSON.stringify({
          ready: true,
          version: AI_RUNTIME_VERSION,
          target: `${process.platform}-${process.arch}`,
          binaryArch: process.platform === 'win32' && process.arch === 'arm64' ? 'x64' : process.arch,
          installedAt: new Date().toISOString(),
        }, null, 2))
        emit({ type: 'done', label: 'AI runtime ready' })
        return { ok: true, ...paths }
      } catch (error) {
        const message = String(error?.message || error)
        emit({ type: 'error', label: 'Runtime installation failed', error: message })
        return { ok: false, error: message, logPath: paths.log }
      } finally {
        aiPromise = null
      }
    })()
    return aiPromise
  }

  function getPaths() {
    return {
      ...paths,
      ghostscript: firstExisting(paths.ghostscriptCandidates),
    }
  }

  return {
    checkInternet,
    ensureCore,
    ensureAi,
    getPaths,
    getStatus: () => ({ ...status, coreReady: isCoreReady(), aiReady: isAiReady() }),
    isCoreReady,
    isAiReady,
  }
}

module.exports = {
  aiInstallerKind,
  createRuntimeDependencyManager,
  imageMagickInstallerArch,
  runtimeCondaSubdir,
  runtimePaths,
  runtimeToolEnvironment,
  parseProgressPercent,
  sanitizeTerminalOutput,
  selectImageMagickInstaller,
}
