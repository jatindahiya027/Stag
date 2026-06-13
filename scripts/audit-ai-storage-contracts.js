const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const main = read('electron/main.js')
const tips = read('AI-index/tipsv2_search.py')
const dino = read('AI-index/dinov3_search.py')

for (const retiredPath of ['ai-staging', 'dino-staging', 'ai-run-pending']) {
  assert(!main.includes(`path.join(getDataDir(), '${retiredPath}')`), `${retiredPath} must not be a persistent AI cache.`)
}

assert(main.includes('createAiAssetManifest'), 'Electron must build AI inputs from SQLite-backed asset rows.')
assert(main.includes('cleanupLegacyAiStaging'), 'Legacy AI staging directories must be removed.')
assert(tips.includes('--manifest'), 'TIPSv2 must index from a manifest instead of a staged folder.')
assert(dino.includes('--manifest'), 'DINOv3 must index from a manifest instead of a staged folder.')
assert(tips.includes('"source_version"'), 'TIPSv2 freshness must use a source version independent of temporary paths.')
assert(dino.includes('"source_versions"'), 'DINOv3 freshness must use source versions independent of temporary paths.')

console.log('AI storage contract audit passed.')
