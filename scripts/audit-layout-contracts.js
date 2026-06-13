const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const grid = fs.readFileSync(path.join(root, 'src/renderer/components/AssetGrid.tsx'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src/renderer/components/AssetGrid.module.css'), 'utf8')
const sidebar = fs.readFileSync(path.join(root, 'src/renderer/components/Sidebar.tsx'), 'utf8')
const inspectorCss = fs.readFileSync(path.join(root, 'src/renderer/components/Inspector.module.css'), 'utf8')

assert(
  /useLayoutEffect\(\(\) => \{\s*virtualizer\.measure\(\)\s*\}, \[virtualizer, labelHeight, cardW, viewMode, justifiedRows\]\)/.test(grid),
  'Virtual rows must remeasure after thumbnail-label or justified-layout metrics change.',
)
assert(
  /\.thumbnailMeta\s*\{[\s\S]*?height:\s*48px;[\s\S]*?box-sizing:\s*border-box;/.test(css),
  'Thumbnail metadata rendered height must match reserved virtual height.',
)
assert(
  sidebar.includes('count={recentVisibleCount}') &&
    sidebar.includes("activeFolderType: 'all'") &&
    sidebar.includes('assetIds: recentAssetIds'),
  'Recently Used count must come from visible non-deleted DB assets, not raw recent IDs.',
)
assert(
  sidebar.includes("import appIconUrl from '../../../public/icon.png'") &&
    sidebar.includes('className={styles.brandIcon} src={appIconUrl}'),
  'Sidebar brand must use the packaged Stag app icon.',
)
assert(
  /\.nameLabel\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?box-sizing:\s*border-box;/.test(inspectorCss),
  'Long inspector filenames must wrap inside the available panel width.',
)

console.log('Layout contract audit passed: grids and narrow inspector content stay contained.')
