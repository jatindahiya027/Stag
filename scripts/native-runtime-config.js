const TARGETS = {
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    nativeArch: 'arm64',
    sharpPackages: [
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64',
    ],
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    nativeArch: 'x64',
    sharpPackages: [
      '@img/sharp-darwin-x64',
      '@img/sharp-libvips-darwin-x64',
    ],
  },
  'win32-arm64': {
    platform: 'win32',
    arch: 'arm64',
    nativeArch: 'arm64',
    compatibilityArch: 'x64',
    sharpPackages: ['@img/sharp-win32-arm64'],
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    nativeArch: 'x64',
    sharpPackages: ['@img/sharp-win32-x64'],
  },
}

module.exports = { TARGETS }
