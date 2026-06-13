const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const tar = require('tar')
const { TARGETS } = require('./native-runtime-config')

const root = path.resolve(__dirname, '..')
const lock = require(path.join(root, 'package-lock.json'))
const target = process.argv[2]
const config = TARGETS[target]

if (!config) {
  console.error(`Unknown native dependency target: ${target}`)
  process.exit(1)
}

function packageDir(packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'))
}

function packageLockEntry(packageName) {
  const entry = lock.packages?.[`node_modules/${packageName}`]
  if (!entry?.resolved || !entry?.integrity) {
    throw new Error(`Lockfile metadata missing for ${packageName}`)
  }
  return entry
}

function packageReady(packageName) {
  const dir = packageDir(packageName)
  if (!fs.existsSync(path.join(dir, 'package.json'))) return false
  if (packageName.includes('sharp-libvips')) {
    return fs.readdirSync(path.join(dir, 'lib')).some(name => name.startsWith('libvips-cpp'))
  }
  return fs.existsSync(path.join(dir, 'lib')) &&
    fs.readdirSync(path.join(dir, 'lib')).some(name => name.endsWith('.node'))
}

async function installLockedPackage(packageName) {
  if (packageReady(packageName)) return
  const entry = packageLockEntry(packageName)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stag-native-'))
  const archive = path.join(tempDir, 'package.tgz')
  const destination = packageDir(packageName)
  try {
    console.log(`Downloading ${packageName} for ${target}`)
    const response = await fetch(entry.resolved)
    if (!response.ok) throw new Error(`${packageName} download failed: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const [algorithm, expected] = entry.integrity.split('-', 2)
    const actual = crypto.createHash(algorithm).update(bytes).digest('base64')
    if (actual !== expected) throw new Error(`${packageName} integrity check failed`)
    fs.writeFileSync(archive, bytes)
    fs.rmSync(destination, { recursive: true, force: true })
    fs.mkdirSync(destination, { recursive: true })
    await tar.x({ file: archive, cwd: destination, strip: 1 })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function main() {
  // electron-rebuild can mistake a same-CPU addon from another OS as reusable
  // (notably macOS ARM64 -> Windows ARM64). Force a fresh target-native addon.
  fs.rmSync(path.join(root, 'node_modules', 'better-sqlite3', 'build'), {
    recursive: true,
    force: true,
  })
  const imgRoot = path.join(root, 'node_modules', '@img')
  if (fs.existsSync(imgRoot)) {
    for (const name of fs.readdirSync(imgRoot)) {
      if (
        (name.startsWith('sharp-') || name.startsWith('sharp-libvips-')) &&
        !config.sharpPackages.includes(`@img/${name}`)
      ) {
        fs.rmSync(path.join(imgRoot, name), { recursive: true, force: true })
      }
    }
  }
  for (const packageName of config.sharpPackages) {
    await installLockedPackage(packageName)
  }
  console.log(`Native dependencies prepared: ${target} (${config.sharpPackages.join(', ')})`)
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
