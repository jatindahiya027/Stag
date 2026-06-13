const fs = require('fs')
const path = require('path')

const MODELS = {
  tipsv2: {
    repoId: 'jatin027/tipsv2-l14',
    directory: 'tipsv2-l14',
  },
  dinov3: {
    repoId: 'jatin027/dinov3-vitl16-pretrain-lvd1689m',
    directory: 'dinov3-vitl16-pretrain-lvd1689m',
  },
}

function createAiModelManager({ getRootDir, sendProgress }) {
  const activeDownloads = new Map()

  function modelDir(feature) {
    const model = MODELS[feature]
    if (!model) throw new Error(`Unknown AI model: ${feature}`)
    return path.join(getRootDir(), 'ai-models', model.directory)
  }

  function markerPath(feature) {
    return path.join(modelDir(feature), '.stag-installed.json')
  }

  function isInstalled(feature) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath(feature), 'utf8'))
      return marker.repoId === MODELS[feature].repoId
    } catch {
      return false
    }
  }

  function status(feature) {
    const model = MODELS[feature]
    return {
      feature,
      repoId: model.repoId,
      installed: isInstalled(feature),
      downloading: activeDownloads.has(feature),
    }
  }

  function allStatus() {
    return {
      tipsv2: status('tipsv2'),
      dinov3: status('dinov3'),
    }
  }

  function emit(feature, data) {
    sendProgress?.({ feature, repoId: MODELS[feature].repoId, ...data })
  }

  async function fetchManifest(feature, signal) {
    const repoId = MODELS[feature].repoId
    const response = await fetch(`https://huggingface.co/api/models/${repoId}?blobs=true`, { signal })
    if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status}`)
    const manifest = await response.json()
    return (manifest.siblings || [])
      .filter(file => file?.rfilename && file.rfilename !== '.gitattributes')
      .map(file => ({
        name: file.rfilename,
        size: Number(file.size || file.lfs?.size || file.blob?.size || 0),
      }))
  }

  async function downloadFile(feature, file, destination, signal, onBytes) {
    const repoId = MODELS[feature].repoId
    const encodedPath = file.name.split('/').map(encodeURIComponent).join('/')
    const url = `https://huggingface.co/${repoId}/resolve/main/${encodedPath}?download=true`
    const partialPath = `${destination}.part`
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    let existing = 0
    try { existing = fs.statSync(partialPath).size } catch {}
    const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {}
    let response = await fetch(url, { headers, redirect: 'follow', signal })
    if (existing > 0 && response.status !== 206) {
      try { fs.unlinkSync(partialPath) } catch {}
      existing = 0
      response = await fetch(url, { redirect: 'follow', signal })
    }
    if (!response.ok || !response.body) throw new Error(`Failed to download ${file.name}: HTTP ${response.status}`)
    onBytes(existing)
    const stream = fs.createWriteStream(partialPath, { flags: existing > 0 ? 'a' : 'w' })
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        stream.write(Buffer.from(value))
        onBytes(value.byteLength)
      }
    } finally {
      await new Promise(resolve => stream.end(resolve))
    }
    if (file.size > 0 && fs.statSync(partialPath).size !== file.size) {
      throw new Error(`Incomplete download for ${file.name}`)
    }
    fs.renameSync(partialPath, destination)
  }

  async function download(feature) {
    if (!MODELS[feature]) return { ok: false, error: 'unknown-model' }
    if (isInstalled(feature)) return { ok: true, installed: true, status: status(feature) }
    if (activeDownloads.has(feature)) return { ok: false, error: 'download-in-progress', status: status(feature) }

    const controller = new AbortController()
    activeDownloads.set(feature, controller)
    emit(feature, { type: 'preparing', current: 0, total: 0 })
    try {
      const files = await fetchManifest(feature, controller.signal)
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
      let downloadedBytes = 0
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        const destination = path.join(modelDir(feature), file.name)
        if (file.size > 0) {
          try {
            if (fs.statSync(destination).size === file.size) {
              downloadedBytes += file.size
              continue
            }
          } catch {}
        }
        await downloadFile(feature, file, destination, controller.signal, bytes => {
          downloadedBytes += bytes
          emit(feature, {
            type: 'downloading',
            current: index + 1,
            total: files.length,
            file: file.name,
            bytesDone: downloadedBytes,
            bytesTotal: totalBytes,
          })
        })
      }
      fs.mkdirSync(modelDir(feature), { recursive: true })
      fs.writeFileSync(markerPath(feature), JSON.stringify({
        repoId: MODELS[feature].repoId,
        installedAt: new Date().toISOString(),
      }, null, 2))
      emit(feature, { type: 'done', current: files.length, total: files.length, bytesDone: totalBytes, bytesTotal: totalBytes })
      return { ok: true, installed: true, status: status(feature) }
    } catch (error) {
      const cancelled = error?.name === 'AbortError'
      emit(feature, { type: cancelled ? 'cancelled' : 'error', error: cancelled ? 'cancelled' : String(error?.message || error) })
      return { ok: false, error: cancelled ? 'cancelled' : String(error?.message || error), status: status(feature) }
    } finally {
      activeDownloads.delete(feature)
    }
  }

  function cancel(feature) {
    const controller = activeDownloads.get(feature)
    if (!controller) return false
    controller.abort()
    return true
  }

  return {
    allStatus,
    cancel,
    download,
    getModelPath: modelDir,
    isInstalled,
    status,
  }
}

module.exports = { createAiModelManager }
