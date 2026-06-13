const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8')
const runtimeManager = fs.readFileSync(path.join(root, 'electron/runtimeDependencyManager.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const { TARGETS } = require('./python-runtime-config')
const {
  aiInstallerKind,
  imageMagickInstallerArch,
  parseProgressPercent,
  runtimeCondaSubdir,
  runtimePaths,
  runtimeToolEnvironment,
  sanitizeTerminalOutput,
  selectImageMagickInstaller,
} = require('../electron/runtimeDependencyManager')
const { pythonProbeTimeout } = require('../electron/pythonRuntime')

assert.deepStrictEqual(
  Object.keys(TARGETS).sort(),
  ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'],
  'All requested Python runtime targets must be configured.',
)
assert.strictEqual(TARGETS['win32-arm64'].condaPlatform, 'win-64')
assert.strictEqual(TARGETS['win32-arm64'].binaryArch, 'x64')
assert.strictEqual(TARGETS['win32-arm64'].compatibilityMode, 'windows-x64-emulation')
assert.strictEqual(TARGETS['win32-arm64'].sourceTarget, 'win32-x64')
assert.strictEqual(runtimeCondaSubdir('win32', 'arm64'), 'win-64')
assert.strictEqual(runtimeCondaSubdir('win32', 'x64'), null)
assert.strictEqual(runtimeCondaSubdir('darwin', 'arm64'), null)
assert.strictEqual(aiInstallerKind('win32'), 'pip')
assert.strictEqual(aiInstallerKind('darwin'), 'conda')
assert.strictEqual(imageMagickInstallerArch('win32', 'arm64'), 'arm64')
assert.strictEqual(imageMagickInstallerArch('win32', 'x64'), 'x64')
assert.strictEqual(imageMagickInstallerArch('darwin', 'arm64'), null)
assert.strictEqual(
  sanitizeTerminalOutput('Solving environment: \u001b[A\u0008\u0008done\rInstalling packages 95%'),
  'Installing packages 95%',
)
assert.strictEqual(parseProgressPercent('svt-av1 | 1.4 MB | #########4 | 95%'), 95)
assert.strictEqual(parseProgressPercent('Downloading torch (24.0 MB/80.0 MB)'), 30)
assert.strictEqual(parseProgressPercent('Solving environment'), null)
assert.strictEqual(
  selectImageMagickInstaller(
    'ImageMagick-7.1.2-25-Q8-x64-static.exe ImageMagick-7.1.2-26-Q8-x64-static.exe',
    'x64',
  ),
  'https://imagemagick.org/archive/binaries/ImageMagick-7.1.2-26-Q8-x64-static.exe',
)
const windowsToolEnv = runtimeToolEnvironment({
  pythonDir: 'C:\\Stag\\runtime\\python',
  magick: 'C:\\Stag\\runtime\\imagemagick\\magick.exe',
  ghostscript: 'C:\\Stag\\runtime\\python\\Library\\bin\\gswin64c.exe',
  ffmpeg: 'C:\\Stag\\runtime\\python\\Library\\bin\\ffmpeg.exe',
  ffprobe: 'C:\\Stag\\runtime\\python\\Library\\bin\\ffprobe.exe',
}, { PATH: 'C:\\Windows\\System32' }, 'win32')
assert(windowsToolEnv.PATH.startsWith('C:\\Stag\\runtime\\imagemagick'))
assert.strictEqual(windowsToolEnv.MAGICK_HOME, 'C:\\Stag\\runtime\\imagemagick')
assert(windowsToolEnv.GS_LIB.includes('C:\\Stag\\runtime\\python\\Library\\Init'))
assert.strictEqual(pythonProbeTimeout('win32', 'arm64'), 120000)
assert.strictEqual(pythonProbeTimeout('win32', 'x64'), 60000)
assert.strictEqual(pythonProbeTimeout('darwin', 'arm64'), 20000)
assert(
  runtimeManager.includes("CONDA_SUBDIR: subdir"),
  'Windows ARM64 Conda installs must explicitly use win-64 packages.',
)
assert(
  runtimeManager.includes('https://download.pytorch.org/whl/cpu') &&
    runtimeManager.includes("'--only-binary=:all:'"),
  'Windows AI dependencies must use prebuilt CPU wheels instead of a large Conda solve.',
)
assert(
  runtimeManager.includes("await condaInstall(['ghostscript>=10,<11']") &&
    runtimeManager.includes("await condaInstall(['imagemagick>=7,<8']") &&
    runtimeManager.includes('selectImageMagickInstaller(await response.text(), arch)'),
  'Core runtime must install ImageMagick and Ghostscript on every supported platform.',
)
assert(
  main.includes("const magickCommand = resolveToolCommand(_magickPath, 'magick')") &&
    main.includes('_spawn(magickCommand') &&
    main.includes('_sp(magickCommand') &&
    main.includes("check(resolveToolCommand(_magickPath, 'magick'), ['--version'])") &&
    main.includes("check(_ghostscriptPath, ['--version'])") &&
    main.includes('env: managedToolEnvironment()'),
  'Packaged media conversion and availability checks must use managed ImageMagick and Ghostscript paths.',
)
assert(
  runtimeManager.includes("await run(installedPaths.magick, ['-version']") &&
    runtimeManager.includes("await run(installedPaths.ghostscript, ['--version']") &&
    runtimeManager.includes('runtimeToolEnvironment(installedPaths)'),
  'Runtime installation must execute and verify the exact managed media-tool paths.',
)
assert(
  runtimeManager.includes('if (!force && isAiReady())') &&
    runtimeManager.includes("emit({ type: 'done', label: 'AI runtime ready' })"),
  'Adding media tools to an existing valid runtime must not reinstall all large AI packages.',
)
assert(
  main.includes('runtimeDependencies.getPaths().python') &&
    main.includes('if (app.isPackaged) return null'),
  'Packaged builds must use the managed runtime path and never silently use user Python.',
)
assert(
  main.includes('env: pythonEnvironment(pythonBin)'),
  'Python processes must use isolated bundled-runtime environment variables.',
)
assert(!packageJson.build.beforePack, 'Packaged builds must not require a pre-bundled Python runtime.')
assert(
  !JSON.stringify(packageJson.build).includes('resources/python') &&
  !JSON.stringify(packageJson.build).includes('resources/ffmpeg'),
  'Python and FFmpeg must install in user data, not ship inside the app package.',
)
const freshRuntime = runtimePaths({
  getPath(name) {
    if (name === 'home') return '/Users/TestUser'
    if (name === 'userData') return '/Users/TestUser/Library/Application Support/Stag'
    throw new Error(`Unexpected app path: ${name}`)
  },
})
assert(
  !freshRuntime.pythonDir.includes(' '),
  'Fresh Miniforge installations must use a prefix without spaces.',
)
const spacedHomeRuntime = runtimePaths({
  getPath(name) {
    if (name === 'home') return '/Users/Test User'
    if (name === 'userData') return '/Users/Test User/Library/Application Support/Stag'
    throw new Error(`Unexpected app path: ${name}`)
  },
})
assert(
  !spacedHomeRuntime.pythonDir.includes(' '),
  'Miniforge prefix must remain space-free when the user home path contains spaces.',
)
assert(
  runtimeManager.includes('await ensureCore({ force })') &&
  main.includes('runtimeDependencies.ensureAi()') &&
  main.includes("webContents.send('runtime:progress'"),
  'Fresh installs must download dependencies with visible progress.',
)
const rendererMain = fs.readFileSync(path.join(root, 'src/renderer/main.tsx'), 'utf8')
const bootstrap = fs.readFileSync(path.join(root, 'src/renderer/components/RuntimeBootstrap.tsx'), 'utf8')
assert(rendererMain.includes('<RuntimeBootstrap />'), 'Dependency bootstrap must render before the main app.')
assert(
  runtimeManager.includes('progressPercent: progressPercent ?? undefined') &&
    bootstrap.includes('hasMeasuredProgress') &&
    bootstrap.includes('{progress}%'),
  'Direct downloads and package-manager downloads must show measured progress percentages.',
)
assert(
  bootstrap.includes('if (ready) return <App />') &&
    bootstrap.includes('api?.initialRuntimeReady === true') &&
    bootstrap.includes('installRuntime') &&
    bootstrap.includes('current?.aiReady') &&
    bootstrap.includes("next.type === 'done'") &&
    bootstrap.includes('installing_imagemagick') &&
    bootstrap.includes('installing_ghostscript'),
  'Main app must mount only after Python, FFmpeg, ImageMagick, Ghostscript, and AI packages are ready.',
)
assert(
  main.includes("'--stag-runtime-ready=1'") &&
  preload.includes("initialRuntimeReady: process.argv.includes('--stag-runtime-ready=1')"),
  'Installed dependencies must render the main app on the first frame without flashing the installer.',
)
const settings = fs.readFileSync(path.join(root, 'src/renderer/components/SettingsPanel.tsx'), 'utf8')
assert(
  preload.includes("ipcRenderer.invoke('runtime:reinstall')") &&
  main.includes("ipcMain.handle('runtime:reinstall'") &&
  settings.includes('reinstallRuntime'),
  'Settings must provide a runtime dependency reinstall action.',
)
assert(
  main.includes("ipcMain.handle('runtime:checkInternet'") &&
    preload.includes("checkRuntimeInternet: () => ipcRenderer.invoke('runtime:checkInternet')") &&
    runtimeManager.includes('async function checkInternet()'),
  'First-run installation must verify internet access in the main process.',
)
assert(
  bootstrap.includes("'welcome' | 'theme' | 'requirements' | 'installing'") &&
    bootstrap.includes('onboardingInstallStarted: true') &&
    bootstrap.includes("settings?.onboardingInstallStarted === true") &&
    bootstrap.includes("settings?.onboardingCompleted === true") &&
    bootstrap.includes('void install(false)') &&
    bootstrap.includes("setScreen('welcome')"),
  'First-run onboarding must restart before installation and resume once installation has begun.',
)
assert(
  bootstrap.includes("localStorage.setItem('stag-theme', nextTheme)") &&
    bootstrap.includes("document.documentElement.dataset.theme = nextTheme"),
  'Theme selection must apply immediately and persist.',
)

console.log('Python runtime contract audit passed: all dependencies install before first launch.')
