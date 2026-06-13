const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { TARGETS } = require('./native-runtime-config')
const { binaryArch, binaryInfo } = require('./validate-packaged-native-deps')

const root = path.resolve(__dirname, '..')
const packageJson = require(path.join(root, 'package.json'))
const requiredTargets = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']
const electronMajor = Number(packageJson.devDependencies.electron.match(/\d+/)?.[0])

assert.deepStrictEqual(Object.keys(TARGETS).sort(), requiredTargets.sort())
for (const target of requiredTargets) {
  assert(packageJson.scripts[`dist:${target.replace('darwin-', 'mac:').replace('win32-', 'win:')}`]?.includes(`prepare-native-deps.js ${target}`))
}
assert.strictEqual(TARGETS['win32-arm64'].nativeArch, 'arm64')
assert.strictEqual(TARGETS['win32-arm64'].compatibilityArch, 'x64')
assert.strictEqual(
  packageJson.devDependencies.electron,
  '41.7.2',
  'Electron must remain exact-pinned because native addons depend on its ABI.',
)
assert.strictEqual(
  packageJson.dependencies['better-sqlite3'],
  '12.10.0',
  'better-sqlite3 must remain exact-pinned with the verified Electron ABI.',
)
assert(
  electronMajor <= 41,
  'better-sqlite3 12.10.0 does not publish Electron 42 prebuilds.',
)
assert(
  packageJson.devDependencies['@electron/rebuild'],
  '@electron/rebuild is required for local native addon alignment.',
)
assert(
  packageJson.scripts['electron:rebuild']?.includes('-w better-sqlite3'),
  'The local rebuild command must target better-sqlite3.',
)
assert.strictEqual(
  packageJson.scripts.postinstall,
  'electron-builder install-app-deps',
  'Fresh installs must align native addons with the pinned Electron ABI.',
)
assert.strictEqual(
  packageJson.build.npmRebuild,
  true,
  'electron-builder must rebuild native dependencies for each package target.',
)
assert(packageJson.build.afterPack, 'Native artifact validation must run after every package build.')
assert(
  packageJson.build.nsis?.artifactName?.includes('${arch}'),
  'Windows installer filenames must include architecture so x64 and ARM64 cannot overwrite each other.',
)
assert(packageJson.build.files.includes('!node_modules/@napi-rs/canvas-*/**/*'))
assert(packageJson.build.asarUnpack.includes('node_modules/@img/**/*'))
const nativePrep = fs.readFileSync(path.join(root, 'scripts/prepare-native-deps.js'), 'utf8')
assert(
  nativePrep.includes("'better-sqlite3', 'build'") &&
    nativePrep.includes('recursive: true') &&
    nativePrep.includes('force: true'),
  'Every target build must discard the previous better-sqlite3 output before electron-rebuild.',
)

const fixtures = [
  ['resources/poppler/darwin-arm64/bin/pdftocairo', 'arm64'],
  ['resources/poppler/darwin-x64/bin/pdftocairo', 'x64'],
  ['resources/poppler/win32-arm64/Library/bin/pdftocairo.exe', 'x64'],
  ['resources/poppler/win32-x64/Library/bin/pdftocairo.exe', 'x64'],
]
for (const [relativePath, expected] of fixtures) {
  const file = path.join(root, relativePath)
  assert(fs.existsSync(file), `Missing runtime fixture: ${relativePath}`)
  assert.strictEqual(binaryArch(file), expected, `${relativePath} architecture`)
  assert.strictEqual(
    binaryInfo(file).format,
    relativePath.includes('win32') ? 'pe' : 'macho',
    `${relativePath} binary format`,
  )
}

console.log('Native dependency contract audit passed for all four desktop targets.')
