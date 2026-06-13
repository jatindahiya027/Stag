const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { TARGETS, runtimeDir, runtimeExecutable } = require('./ffmpeg-runtime-config')

const root = path.resolve(__dirname, '..')
const targets = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(TARGETS)
const installer = path.join(root, 'node_modules', 'ffmpeg-static', 'install.js')

for (const target of targets) {
  const config = TARGETS[target]
  if (!config) {
    console.error(`Unknown FFmpeg runtime target: ${target}`)
    process.exit(1)
  }
  const destination = runtimeDir(root, target)
  const executable = runtimeExecutable(root, target)
  const sourceExecutable = config.sourceTarget && runtimeExecutable(root, config.sourceTarget)
  const installedExecutable = path.join(root, 'node_modules', 'ffmpeg-static', config.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  fs.mkdirSync(destination, { recursive: true })

  if (
    !fs.existsSync(executable) &&
    process.platform === config.platform &&
    process.arch === config.binaryArch &&
    fs.existsSync(installedExecutable)
  ) {
    fs.copyFileSync(installedExecutable, executable)
  }

  if (!fs.existsSync(executable) && sourceExecutable && fs.existsSync(sourceExecutable)) {
    fs.copyFileSync(sourceExecutable, executable)
    for (const suffix of ['.LICENSE', '.README']) {
      if (fs.existsSync(sourceExecutable + suffix)) fs.copyFileSync(sourceExecutable + suffix, executable + suffix)
    }
  }

  if (!fs.existsSync(executable)) {
    console.log(`Preparing FFmpeg runtime: ${target} (${config.platform}-${config.binaryArch})`)
    const result = spawnSync(process.execPath, [installer], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        FFMPEG_BIN: executable,
        npm_config_platform: config.platform,
        npm_config_arch: config.binaryArch,
      },
    })
    if (result.status !== 0) process.exit(result.status || 1)
  } else {
    console.log(`FFmpeg runtime already prepared: ${target}`)
  }

  if (config.platform !== 'win32') fs.chmodSync(executable, 0o755)
  fs.writeFileSync(path.join(destination, 'stag-ffmpeg-runtime.json'), JSON.stringify({
    schemaVersion: 1,
    target,
    platform: config.platform,
    arch: config.arch,
    binaryArch: config.binaryArch,
    compatibilityMode: config.compatibilityMode || 'native',
  }, null, 2))
}
