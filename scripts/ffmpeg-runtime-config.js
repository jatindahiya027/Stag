const path = require('path')

const TARGETS = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', binaryArch: 'arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', binaryArch: 'x64' },
  'win32-x64': { platform: 'win32', arch: 'x64', binaryArch: 'x64' },
  'win32-arm64': {
    platform: 'win32',
    arch: 'arm64',
    binaryArch: 'x64',
    compatibilityMode: 'windows-x64-emulation',
    sourceTarget: 'win32-x64',
  },
}

function runtimeDir(root, target) {
  return path.join(root, 'resources', 'ffmpeg', target)
}

function runtimeExecutable(root, target) {
  const config = TARGETS[target]
  if (!config) throw new Error(`Unknown FFmpeg runtime target: ${target}`)
  return path.join(runtimeDir(root, target), config.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
}

module.exports = { TARGETS, runtimeDir, runtimeExecutable }
