const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const REQUIRED_IMPORTS = {
  tipsv2: ['torch', 'torchvision', 'transformers', 'PIL', 'tqdm'],
  dinov3: ['faiss', 'numpy', 'torch', 'torchvision', 'transformers', 'PIL'],
}

function runtimeTarget(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

function pythonProbeTimeout(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'arm64') return 120000
  if (platform === 'win32') return 60000
  return 20000
}

function pythonExecutable(runtimeDir, platform = process.platform) {
  return platform === 'win32'
    ? path.join(runtimeDir, 'python.exe')
    : path.join(runtimeDir, 'bin', 'python3')
}

function pythonEnvironment(executable, baseEnv = process.env) {
  if (!path.isAbsolute(executable)) {
    return { ...baseEnv, PYTHONNOUSERSITE: '1' }
  }
  const runtimeDir = process.platform === 'win32'
    ? path.dirname(executable)
    : path.dirname(path.dirname(executable))
  const pathEntries = process.platform === 'win32'
    ? [runtimeDir, path.join(runtimeDir, 'Library', 'bin'), path.join(runtimeDir, 'Scripts')]
    : [path.join(runtimeDir, 'bin')]
  return {
    ...baseEnv,
    PATH: [...pathEntries, baseEnv.PATH || ''].filter(Boolean).join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    ...(process.platform === 'darwin'
      ? { DYLD_FALLBACK_LIBRARY_PATH: [path.join(runtimeDir, 'lib'), baseEnv.DYLD_FALLBACK_LIBRARY_PATH || ''].filter(Boolean).join(path.delimiter) }
      : {}),
  }
}

function bundledRuntimeCandidates({ app, resourcesPath = process.resourcesPath } = {}) {
  const target = runtimeTarget()
  const candidates = [
    app?.getPath ? path.join(app.getPath('userData'), 'runtime', 'python') : '',
    path.join(app?.getAppPath?.() || '', 'resources', 'python', target),
    path.join(__dirname, '..', 'resources', 'python', target),
  ]
  return [...new Set(candidates.filter(Boolean))]
}

function findBundledPython(options = {}) {
  for (const runtimeDir of bundledRuntimeCandidates(options)) {
    const executable = pythonExecutable(runtimeDir)
    if (fs.existsSync(executable)) return { executable, runtimeDir, target: runtimeTarget() }
  }
  return null
}

function probePython(executable, feature, timeout = pythonProbeTimeout()) {
  const imports = REQUIRED_IMPORTS[feature]
  if (!imports) return Promise.resolve({ ok: false, error: `unknown-python-feature:${feature}` })
  const script = [
    'import json, platform, sys',
    ...imports.map(name => `import ${name}`),
    `print(json.dumps({"executable": sys.executable, "version": platform.python_version(), "platform": sys.platform, "machine": platform.machine()}))`,
  ].join('; ')
  return new Promise(resolve => {
    execFile(executable, ['-c', script], {
      env: pythonEnvironment(executable),
      windowsHide: true,
      timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = error.killed === true || error.signal === 'SIGTERM'
        resolve({
          ok: false,
          error: timedOut
            ? `python-probe-timeout-after-${timeout}ms`
            : String(stderr || error.message || error).trim(),
        })
        return
      }
      try {
        resolve({ ok: true, ...JSON.parse(String(stdout || '').trim().split(/\r?\n/).pop()) })
      } catch {
        resolve({ ok: false, error: 'python-probe-invalid-output' })
      }
    })
  })
}

module.exports = {
  findBundledPython,
  probePython,
  pythonProbeTimeout,
  pythonEnvironment,
}
