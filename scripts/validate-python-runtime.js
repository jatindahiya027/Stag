const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  REQUIRED_CONDA_PACKAGES,
  TARGETS,
  runtimeDir,
  runtimeExecutable,
} = require('./python-runtime-config')

const root = path.resolve(__dirname, '..')

function validateTarget(target, { execute = false } = {}) {
  const config = TARGETS[target]
  if (!config) throw new Error(`Unknown Python runtime target: ${target}`)
  const destination = runtimeDir(root, target)
  const executable = runtimeExecutable(root, target)
  const manifestPath = path.join(destination, 'stag-python-runtime.json')
  if (!fs.existsSync(executable)) throw new Error(`Missing bundled Python executable: ${executable}`)
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing Python runtime manifest: ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.target !== target || manifest.platform !== config.electronPlatform || manifest.arch !== config.arch) {
    throw new Error(`Python runtime manifest target mismatch for ${target}`)
  }
  if (manifest.binaryArch !== (config.binaryArch || config.arch)) {
    throw new Error(`Python runtime binary architecture mismatch for ${target}`)
  }
  if (manifest.compatibilityMode !== (config.compatibilityMode || 'native')) {
    throw new Error(`Python runtime compatibility mode mismatch for ${target}`)
  }
  const names = new Set((manifest.packages || []).map(item => item.name))
  const missing = REQUIRED_CONDA_PACKAGES.filter(name => !names.has(name))
  if (missing.length) throw new Error(`${target} runtime manifest missing: ${missing.join(', ')}`)
  if (execute) {
    const probe = spawnSync(executable, [
      '-c',
      'import faiss, numpy, torch, torchvision, transformers, PIL, tqdm; print("runtime-ok")',
    ], { encoding: 'utf8', timeout: 120000 })
    if (probe.status !== 0 || !String(probe.stdout).includes('runtime-ok')) {
      throw new Error(String(probe.stderr || `${target} runtime execution probe failed`).trim())
    }
  }
  return manifest
}

if (require.main === module) {
  const requested = process.argv.slice(2)
  const targets = requested.length ? requested : Object.keys(TARGETS)
  try {
    for (const target of targets) {
      const config = TARGETS[target]
      const execute = process.platform === config.electronPlatform && process.arch === config.arch
      const manifest = validateTarget(target, { execute })
      console.log(`Python runtime valid: ${target} (${manifest.packages.length} packages${execute ? ', executed' : ''})`)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}

module.exports = { validateTarget }
