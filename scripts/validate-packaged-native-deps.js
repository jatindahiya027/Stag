const fs = require('fs')
const path = require('path')
const { TARGETS } = require('./native-runtime-config')

function binaryInfo(file) {
  const bytes = fs.readFileSync(file)
  if (bytes.subarray(0, 2).toString('ascii') === 'MZ') {
    const pe = bytes.readUInt32LE(0x3c)
    const machine = bytes.readUInt16LE(pe + 4)
    if (machine === 0xaa64) return { format: 'pe', arch: 'arm64' }
    if (machine === 0x8664) return { format: 'pe', arch: 'x64' }
    return { format: 'pe', arch: `unknown-${machine.toString(16)}` }
  }
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4)
    if (cpu === 0x0100000c) return { format: 'macho', arch: 'arm64' }
    if (cpu === 0x01000007) return { format: 'macho', arch: 'x64' }
    return { format: 'macho', arch: `unknown-${cpu.toString(16)}` }
  }
  return { format: 'unknown', arch: 'unknown' }
}

function binaryArch(file) {
  return binaryInfo(file).arch
}

function findFile(root, predicate) {
  if (!fs.existsSync(root)) return null
  const pending = [root]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(fullPath)
      else if (predicate(fullPath)) return fullPath
    }
  }
  return null
}

function assertBinary(file, expectedFormat, expectedArch, label) {
  if (!file || !fs.existsSync(file)) throw new Error(`Missing packaged ${label}: ${file || 'not found'}`)
  const actual = binaryInfo(file)
  if (actual.format !== expectedFormat || actual.arch !== expectedArch) {
    throw new Error(
      `${label} binary mismatch: expected ${expectedFormat}-${expectedArch}, ` +
      `found ${actual.format}-${actual.arch} at ${file}`
    )
  }
}

function validatePackagedTarget(target, appOutDir, productName = 'Stag') {
  const config = TARGETS[target]
  if (!config) throw new Error(`Unknown packaged native target: ${target}`)
  const resources = config.platform === 'darwin'
    ? path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources')
  const executable = config.platform === 'darwin'
    ? path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName)
    : path.join(appOutDir, `${productName}.exe`)
  const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules')
  const sqlite = path.join(unpacked, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  const sharpPackage = config.sharpPackages.find(name => !name.includes('libvips'))
  const sharp = findFile(path.join(unpacked, ...sharpPackage.split('/')), file => file.endsWith('.node'))
  const poppler = config.platform === 'darwin'
    ? path.join(resources, 'poppler', 'bin', 'pdftocairo')
    : path.join(resources, 'poppler', 'Library', 'bin', 'pdftocairo.exe')

  const nativeFormat = config.platform === 'win32' ? 'pe' : 'macho'
  assertBinary(executable, nativeFormat, config.nativeArch, 'Electron executable')
  assertBinary(sqlite, nativeFormat, config.nativeArch, 'better-sqlite3')
  assertBinary(sharp, nativeFormat, config.nativeArch, 'Sharp')
  assertBinary(poppler, nativeFormat, config.compatibilityArch || config.nativeArch, 'Poppler')

  const foreignCanvas = findFile(unpacked, file =>
    file.endsWith('.node') &&
    file.includes(`${path.sep}@napi-rs${path.sep}canvas-`) &&
    (
      binaryInfo(file).format !== nativeFormat ||
      binaryInfo(file).arch !== config.nativeArch
    )
  )
  if (foreignCanvas) throw new Error(`Foreign Canvas native binary packaged: ${foreignCanvas}`)

  console.log(`Packaged native dependency audit passed: ${target}`)
}

if (require.main === module) {
  validatePackagedTarget(process.argv[2], path.resolve(process.argv[3]), process.argv[4] || 'Stag')
}

module.exports = { binaryArch, binaryInfo, validatePackagedTarget }
