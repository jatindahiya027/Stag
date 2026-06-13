const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const TARGETS = {
  'darwin-arm64': 'osx-arm64',
  'darwin-x64': 'osx-64',
  'win32-x64': 'win-64',
  // Conda does not publish this dependency set for win-arm64. Windows 11 on
  // Arm runs the x64 Poppler tools through its built-in compatibility layer.
  'win32-arm64': 'win-64',
}
const SOURCE_TARGETS = {
  'win32-arm64': 'win32-x64',
}

const requested = process.argv.slice(2)
const targets = requested.length ? requested : Object.keys(TARGETS)
const conda = process.env.CONDA_EXE || 'conda'
const root = path.resolve(__dirname, '..')

for (const target of targets) {
  const condaPlatform = TARGETS[target]
  if (!condaPlatform) {
    console.error(`Unknown Poppler target: ${target}`)
    process.exit(1)
  }

  const destination = path.join(root, 'resources', 'poppler', target)
  const executable = target.startsWith('win32')
    ? path.join(destination, 'Library', 'bin', 'pdftocairo.exe')
    : path.join(destination, 'bin', 'pdftocairo')
  if (fs.existsSync(executable)) {
    console.log(`Poppler runtime already prepared: ${target}`)
    continue
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const sourceTarget = SOURCE_TARGETS[target]
  const source = sourceTarget && path.join(root, 'resources', 'poppler', sourceTarget)
  const sourceExecutable = source && path.join(source, 'Library', 'bin', 'pdftocairo.exe')
  if (source && fs.existsSync(sourceExecutable)) {
    console.log(`Cloning Poppler runtime: ${sourceTarget} -> ${target}`)
    fs.cpSync(source, destination, { recursive: true })
    continue
  }
  const result = spawnSync(conda, [
    'create',
    '-y',
    '-p', destination,
    '--platform', condaPlatform,
    '--override-channels',
    '-c', 'conda-forge',
    'poppler=26.05.0',
  ], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
