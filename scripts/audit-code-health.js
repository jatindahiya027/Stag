const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
const main = read('electron/main.js')
const preload = read('electron/preload.js')
const packageJson = require(path.join(root, 'package.json'))

const rendererSource = fs.readdirSync(path.join(root, 'src/renderer'), { recursive: true })
  .filter(file => /\.(ts|tsx)$/.test(file))
  .map(file => read(path.join('src/renderer', file)))
  .join('\n')

const preloadKeys = [...preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map(match => match[1])
const unusedPreloadKeys = preloadKeys.filter(key => {
  const escaped = key.replace(/[$]/g, '\\$&')
  return !new RegExp(`(?:\\.|\\?\\.)${escaped}\\b|["']${escaped}["']`).test(rendererSource)
})
assert.deepStrictEqual(unusedPreloadKeys, [], `Unused preload APIs: ${unusedPreloadKeys.join(', ')}`)

const invokeChannels = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]))
const handleChannels = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(match => match[1]))
const missingHandlers = [...invokeChannels].filter(channel => !handleChannels.has(channel))
const orphanHandlers = [...handleChannels].filter(channel => !invokeChannels.has(channel))
assert.deepStrictEqual(missingHandlers, [], `Preload channels without handlers: ${missingHandlers.join(', ')}`)
assert.deepStrictEqual(orphanHandlers, [], `Handlers absent from preload: ${orphanHandlers.join(', ')}`)

assert.strictEqual(
  (main.match(/function createWindow\s*\(/g) || []).length,
  1,
  'electron/main.js must contain one createWindow implementation.',
)
assert(
  !fs.existsSync(path.join(root, 'AI-index/tipsv2_search3.py')),
  'The retired TIPSv2 prototype must not return to the production pipeline.',
)

for (const dependency of ['fflate', 'three', 'video.js', 'webp-converter-browser']) {
  assert(
    !packageJson.dependencies?.[dependency] && !packageJson.devDependencies?.[dependency],
    `Unused dependency remains installed: ${dependency}`,
  )
}

console.log(
  `Code health audit passed: ${preloadKeys.length} renderer APIs and ${handleChannels.size} IPC handlers checked.`,
)
