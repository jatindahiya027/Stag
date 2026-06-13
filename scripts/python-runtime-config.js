const path = require('path')

const TARGETS = {
  'darwin-arm64': { condaPlatform: 'osx-arm64', electronPlatform: 'darwin', arch: 'arm64' },
  'darwin-x64': { condaPlatform: 'osx-64', electronPlatform: 'darwin', arch: 'x64' },
  'win32-x64': { condaPlatform: 'win-64', electronPlatform: 'win32', arch: 'x64' },
  'win32-arm64': {
    condaPlatform: 'win-64',
    electronPlatform: 'win32',
    arch: 'arm64',
    binaryArch: 'x64',
    compatibilityMode: 'windows-x64-emulation',
    sourceTarget: 'win32-x64',
  },
}

const CONDA_PACKAGES = [
  'python=3.12',
  'pip',
  'faiss-cpu>=1.8,<2',
  'huggingface_hub>=0.34,<2',
  'numpy>=1.24,<3',
  'pillow>=10,<13',
  'pytorch>=2.2,<3',
  'safetensors>=0.4,<1',
  'sentencepiece>=0.2,<1',
  'torchvision>=0.17,<1',
  'tqdm>=4.66,<5',
  'transformers>=4.56,<5',
]

const REQUIRED_CONDA_PACKAGES = [
  'faiss-cpu',
  'numpy',
  'pillow',
  'python',
  'pytorch',
  'torchvision',
  'tqdm',
  'transformers',
]

function runtimeDir(root, target) {
  return path.join(root, 'resources', 'python', target)
}

function runtimeExecutable(root, target) {
  const config = TARGETS[target]
  if (!config) throw new Error(`Unknown Python runtime target: ${target}`)
  return config.electronPlatform === 'win32'
    ? path.join(runtimeDir(root, target), 'python.exe')
    : path.join(runtimeDir(root, target), 'bin', 'python3')
}

module.exports = {
  CONDA_PACKAGES,
  REQUIRED_CONDA_PACKAGES,
  TARGETS,
  runtimeDir,
  runtimeExecutable,
}
