const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const main = read('electron/main.js')
const preload = read('electron/preload.js')
const settings = read('src/renderer/components/SettingsPanel.tsx')
const titleBar = read('src/renderer/components/TitleBar.tsx')
const store = read('src/renderer/store/useStore.ts')

assert(!titleBar.includes('const EXT_OPTIONS ='), 'File-type filters must not use a hard-coded extension list.')
assert(titleBar.includes('counts.extensions'), 'File-type filters must use database extension counts.')
assert(main.includes('const extensions = {}'), 'Database counts must include extension totals.')

assert(!settings.includes('Change Location'), 'The library location must not be user-configurable.')
assert(!preload.includes('getLibraryPath:'), 'The retired library-path API must not remain exposed.')
assert(!preload.includes('moveLibrary:'), 'The retired library-move API must not remain exposed.')
assert(!main.includes("ipcMain.handle('settings:moveLibrary'"), 'The retired library-move handler must be removed.')

assert(!settings.includes('importCopyEnabled'), 'Copy on import must not have an enable/disable setting.')
assert(!store.includes('settings?.importCopyEnabled'), 'Imports must always use the managed local folder.')
assert(!main.includes("reason: 'disabled'"), 'The import-copy handler must not retain a disabled branch.')

assert(main.includes('migrateManagedFolder'), 'Managed WebGrab and Local folder changes must migrate existing files.')
assert(preload.includes('setLocalImportPath:'), 'The Local managed-folder migration API must be exposed.')
assert(settings.includes('setLocalImportPath'), 'Changing the Local folder must invoke migration immediately.')

assert(!main.includes('Remove from Stag Only'), 'The permanent-delete dialog must not offer DB-only removal.')
assert(!preload.includes('dbHardDeleteAssetsDbOnly:'), 'DB-only permanent deletion must not remain exposed.')
assert(!store.includes('permanentDeleteDbOnly:'), 'DB-only permanent deletion must not remain in renderer state.')

console.log('Library management contract audit passed.')
