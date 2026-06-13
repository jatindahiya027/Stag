const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const packageJson = require(path.join(root, 'package.json'))
const installerInclude = fs.readFileSync(
  path.join(root, packageJson.build.nsis.include),
  'utf8',
)

assert.strictEqual(
  packageJson.build.executableName,
  'Stag',
  'The packaged executable name must remain explicit and stable across upgrades.',
)
assert.strictEqual(
  packageJson.build.nsis.shortcutName,
  packageJson.build.executableName,
  'Shortcut and executable names must remain aligned.',
)
assert.strictEqual(
  packageJson.build.nsis.createDesktopShortcut,
  'always',
  'electron-builder must recreate the desktop shortcut on reinstalls.',
)
assert.strictEqual(
  packageJson.build.nsis.differentialPackage,
  false,
  'Windows installers must not force the 7z differential package path.',
)
assert.strictEqual(
  packageJson.build.nsis.useZip,
  true,
  'Windows installers must extract ZIP payloads directly instead of using the ARM64-broken CopyFiles stage.',
)
assert(
  installerInclude.indexOf('!include x64.nsh') <
    installerInclude.indexOf('!undef IsNativeARM64'),
  'The ARM64 environment probe must replace IsNativeARM64 before extraction macros are defined.',
)
assert(
  installerInclude.includes('Session Manager\\Environment') &&
    installerInclude.includes('"PROCESSOR_ARCHITECTURE"'),
  'The ARM64 probe must use the system registry because Parallels omits processor variables from x86 processes.',
)
assert(
  !installerInclude.includes('customInstall') &&
    !installerInclude.includes('$appExe') &&
    !installerInclude.includes('CreateShortCut'),
  'The custom include must not duplicate extraction checks or shortcut creation.',
)

console.log('Windows installer contract audit passed.')
