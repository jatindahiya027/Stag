const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { TARGETS, runtimeDir, runtimeExecutable } = require('./ffmpeg-runtime-config')

const root = path.resolve(__dirname, '..')

function validateTarget(target, { execute = false } = {}) {
  const config = TARGETS[target]
  if (!config) throw new Error(`Unknown FFmpeg runtime target: ${target}`)
  const executable = runtimeExecutable(root, target)
  const manifestPath = path.join(runtimeDir(root, target), 'stag-ffmpeg-runtime.json')
  if (!fs.existsSync(executable)) throw new Error(`Missing FFmpeg executable: ${executable}`)
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing FFmpeg manifest: ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (
    manifest.target !== target ||
    manifest.platform !== config.platform ||
    manifest.arch !== config.arch ||
    manifest.binaryArch !== config.binaryArch ||
    manifest.compatibilityMode !== (config.compatibilityMode || 'native')
  ) throw new Error(`FFmpeg runtime manifest mismatch for ${target}`)
  const header = fs.readFileSync(executable).subarray(0, 4)
  if (config.platform === 'win32' && header.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${target} FFmpeg is not a Windows executable`)
  }
  if (config.platform === 'darwin' && !header.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))) {
    throw new Error(`${target} FFmpeg is not a 64-bit Mach-O executable`)
  }
  if (execute) {
    const result = spawnSync(executable, ['-version'], { encoding: 'utf8', timeout: 30000 })
    if (result.status !== 0 || !String(result.stdout).startsWith('ffmpeg version')) {
      throw new Error(`${target} FFmpeg execution probe failed`)
    }
  }
  return manifest
}

if (require.main === module) {
  const targets = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(TARGETS)
  try {
    for (const target of targets) {
      const config = TARGETS[target]
      const execute = process.platform === config.platform && process.arch === config.binaryArch
      validateTarget(target, { execute })
      console.log(`FFmpeg runtime valid: ${target}${execute ? ' (executed)' : ''}`)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

module.exports = { validateTarget }
