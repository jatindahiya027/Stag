const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const {
  CONDA_PACKAGES,
  REQUIRED_CONDA_PACKAGES,
  TARGETS,
  runtimeDir,
  runtimeExecutable,
} = require('./python-runtime-config')

const root = path.resolve(__dirname, '..')
const requested = process.argv.slice(2)
const targets = requested.length ? requested : Object.keys(TARGETS)
const conda = process.env.CONDA_EXE || 'conda'

function packageInventory(destination) {
  const metadataDir = path.join(destination, 'conda-meta')
  if (!fs.existsSync(metadataDir)) return []
  return fs.readdirSync(metadataDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(metadataDir, name), 'utf8'))
        return { name: data.name, version: data.version, build: data.build, subdir: data.subdir }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function validateInventory(target, inventory) {
  const names = new Set(inventory.map(item => item.name))
  const missing = REQUIRED_CONDA_PACKAGES.filter(name => !names.has(name))
  if (missing.length) throw new Error(`${target} Python runtime missing Conda packages: ${missing.join(', ')}`)
}

function writeManifest(target, inventory) {
  const config = TARGETS[target]
  const destination = runtimeDir(root, target)
  const manifest = {
    schemaVersion: 1,
    target,
    platform: config.electronPlatform,
    arch: config.arch,
    binaryArch: config.binaryArch || config.arch,
    compatibilityMode: config.compatibilityMode || 'native',
    condaPlatform: config.condaPlatform,
    preparedAt: new Date().toISOString(),
    packages: inventory,
  }
  fs.writeFileSync(path.join(destination, 'stag-python-runtime.json'), JSON.stringify(manifest, null, 2))
}

for (const target of targets) {
  const config = TARGETS[target]
  if (!config) {
    console.error(`Unknown Python runtime target: ${target}`)
    process.exit(1)
  }
  const destination = runtimeDir(root, target)
  const executable = runtimeExecutable(root, target)
  let inventory = packageInventory(destination)

  if (!fs.existsSync(executable) || !inventory.length) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const source = config.sourceTarget && runtimeDir(root, config.sourceTarget)
    const sourceExecutable = config.sourceTarget && runtimeExecutable(root, config.sourceTarget)
    if (source && fs.existsSync(sourceExecutable)) {
      console.log(`Cloning bundled Python runtime: ${config.sourceTarget} -> ${target}`)
      fs.cpSync(source, destination, { recursive: true })
    } else {
      console.log(`Preparing bundled Python runtime: ${target} (${config.condaPlatform})`)
      const result = spawnSync(conda, [
        'create',
        '-y',
        '-p', destination,
        '--platform', config.condaPlatform,
        '--override-channels',
        '-c', 'conda-forge',
        ...CONDA_PACKAGES,
      ], { stdio: 'inherit' })
      if (result.status !== 0) {
        console.error(
          `Could not prepare ${target}. This target may not publish required PyTorch/FAISS packages. ` +
          `Prepare resources/python/${target} on a native ${target} machine and rerun validation.`,
        )
        process.exit(result.status || 1)
      }
    }
    inventory = packageInventory(destination)
  } else {
    console.log(`Bundled Python runtime already present: ${target}`)
  }

  validateInventory(target, inventory)
  writeManifest(target, inventory)

  if (process.platform === config.electronPlatform && process.arch === config.arch) {
    const probe = spawnSync(executable, [
      '-c',
      'import faiss, numpy, torch, torchvision, transformers, PIL, tqdm; print("runtime-ok")',
    ], { encoding: 'utf8', timeout: 120000 })
    if (probe.status !== 0 || !String(probe.stdout).includes('runtime-ok')) {
      console.error(probe.stderr || `${target} Python dependency probe failed`)
      process.exit(probe.status || 1)
    }
  }
}
