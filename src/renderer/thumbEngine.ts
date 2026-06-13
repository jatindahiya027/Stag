/**
 * Background thumbnail engine for video and 3D assets.
 * Runs entirely in the renderer but independent of component visibility.
 * Imported by useStore (for post-import queuing) and App.tsx (for startup queuing).
 * Does NOT import from useStore — uses electronAPI directly to avoid circular deps.
 */

import { isVideo, is3D, extractPaletteOnceForAsset } from './utils/helpers'
import { applyModelEnvironment, ensureThreeJS, patchGltfBuffers } from './components/LightboxModal'

// ── Queue factory ─────────────────────────────────────────────────────────────
function makeQueue(maxConcurrent: number) {
  const queue: Array<() => void> = []
  let running = 0
  const flush = () => {
    while (running < maxConcurrent && queue.length) {
      running++
      const job = queue.shift()!
      requestAnimationFrame(() => setTimeout(() => { try { job() } catch {} }, 0))
    }
  }
  return {
    add:  (fn: () => void) => { queue.push(fn); flush() },
    done: () => { running = Math.max(0, running - 1); setTimeout(flush, 80) },
  }
}

let videoQueue = makeQueue(2)
const modelQueue = makeQueue(1)  // 1 WebGL context at a time

export function applyImportThreads(threads: number) {
  videoQueue = makeQueue(Math.max(1, Math.floor(threads || 1)))
}

// ── Global dedup set ──────────────────────────────────────────────────────────
const _bgQueued = new Set<string>()

// ── Helpers ───────────────────────────────────────────────────────────────────
function emitRendererThumbProgress(data: Record<string, any>) {
  window.dispatchEvent(new CustomEvent('stag:thumbProgress', { detail: data }))
}

function bgSaveThumb(
  id: string,
  dataUrl: string,
  dims?: { width: number; height: number },
  saveOptions: Record<string, any> = {}
): Promise<string | null> {
  const api = (window as any).electronAPI
  const applyThumb = (thumbUrl: string) => {
    import('./store/useStore').then(({ useStore }) => {
      const updates: Record<string, any> = { thumbnailData: thumbUrl }
      if (dims) { updates.width = dims.width; updates.height = dims.height }
      useStore.getState().updateAsset(id, updates)
      const latest = useStore.getState().assets.find(a => a.id === id)
      if (latest && !latest.colors?.length) {
        extractPaletteOnceForAsset(id, thumbUrl, latest.colors, colors => {
          const current = useStore.getState().assets.find(a => a.id === id)
          if (!current?.colors?.length) useStore.getState().updateAsset(id, { colors } as any)
        }).catch(() => {})
      }
      // Auto-queue for AI captioning if enabled and not yet tagged
      const store = useStore.getState()
      const { aiSettings, ollamaSessionFailed } = store
      if (aiSettings.enabled && !ollamaSessionFailed) {
        const asset = store.assets.find(a => a.id === id)
        if (asset && !asset.aiTagged) {
          store.startAiQueue([{ ...asset, thumbnailData: thumbUrl }])
        }
      }
    })
  }

  // file:// URLs come from main-process ffmpeg (already saved to disk + DB updated)
  if (dataUrl.startsWith('file://')) {
    applyThumb(dataUrl)
    return Promise.resolve(dataUrl)
  }

  if (api?.dbSaveThumbnail) {
    return api.dbSaveThumbnail(id, dataUrl, saveOptions).then((result: any) => {
      const fileUrl = typeof result === 'string' ? result : result?.thumbUrl
      if (fileUrl) {
        applyThumb(fileUrl)
        if (result?.thumbnailVariants) {
          import('./store/useStore').then(({ useStore }) => {
            useStore.getState().updateAsset(id, { thumbnailVariants: result.thumbnailVariants } as any)
          })
        }
      }
      return fileUrl || null
    }).catch(() => null)
  } else {
    applyThumb(dataUrl)
    return Promise.resolve(dataUrl)
  }
}

// ── Video frame extraction ────────────────────────────────────────────────────
function bgProcessVideo(id: string, filePath: string, ext: string, saveOptions: Record<string, any> = {}) {
  return new Promise<string | null>((resolve) => videoQueue.add(() => {
    console.log('[VideoThumb] Renderer canvas attempt:', filePath)
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true; v.preload = 'auto'
    v.src = `file://${filePath.replace(/\\/g, '/')}`

    let captured = false
    let tid: ReturnType<typeof setTimeout>

    const fallbackToMain = () => {
      videoQueue.done()
      console.log('[VideoThumb] Canvas failed, trying main-process ffmpeg:', filePath)
      const api = (window as any).electronAPI
      const request = api?.generateVideoThumb?.({ id, filePath, ext, ...saveOptions })
      if (!request?.then) {
        resolve(null)
        return
      }
      request.then((result: any) => {
        if (result?.thumbUrl) {
          bgSaveThumb(id, result.thumbUrl, { width: result.width, height: result.height })
          resolve(result.thumbUrl)
        } else {
          console.warn('[VideoThumb] ffmpeg fallback also failed for:', filePath)
          resolve(null)
        }
      }).catch(() => resolve(null))
    }

    const finish = (success: boolean) => {
      clearTimeout(tid); v.src = ''; v.load()
      if (!success) fallbackToMain()
      else videoQueue.done()
    }

    const grab = () => {
      if (captured) return
      captured = true
      try {
        if (v.videoWidth === 0 || v.readyState < 2) { finish(false); return }
        const W = Math.min(v.videoWidth, 768)
        const H = Math.max(1, Math.round((W * v.videoHeight) / v.videoWidth))
        const c = document.createElement('canvas')
        c.width = W; c.height = H
        const ctx = c.getContext('2d')
        if (ctx) {
          ctx.drawImage(v, 0, 0, W, H)
          const url = c.toDataURL('image/webp', 0.96)
          if (url.length > 500) {
            console.log('[VideoThumb] Canvas captured', W, 'x', H, 'for', filePath)
            bgSaveThumb(id, url, { width: v.videoWidth, height: v.videoHeight }, saveOptions)
              .then(resolve)
              .finally(() => finish(true))
            return
          }
        }
      } catch {}
      finish(false)
    }

    v.addEventListener('loadedmetadata', () => {
      v.currentTime = isFinite(v.duration) && v.duration > 0 ? Math.max(0.1, v.duration * 0.1) : 0.5
    }, { once: true })
    v.addEventListener('seeked', grab, { once: true })
    v.addEventListener('error', () => {
      if (!captured) { captured = true; finish(false) }
    }, { once: true })
    tid = setTimeout(() => {
      if (!captured) {
        captured = true
        console.warn('[VideoThumb] Canvas timed out for:', filePath)
        finish(false)
      }
    }, 8000)
    v.load()
  }))
}

// ── 3D model rendering ────────────────────────────────────────────────────────
function render3DThumb(filePath: string, ext: string, cb: (url: string | null) => void) {
  ensureThreeJS(() => {
    const T = (window as any).THREE
    if (!T) { cb(null); modelQueue.done(); return }
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 400
    let renderer: any
    let disposeEnvironment: (() => void) | undefined
    let envReady: Promise<void> = Promise.resolve()

    // Single resolved flag + cleanup — prevents double done() on timeout race
    let resolved = false
    let tid: ReturnType<typeof setTimeout>
    const finish = (url: string | null) => {
      if (resolved) return
      resolved = true
      clearTimeout(tid)
      cb(url)
      try { disposeEnvironment?.() } catch {}
      try { renderer?.dispose() } catch {}
      modelQueue.done()
    }
    // 60s hard timeout — prevents modelQueue blocking on unparseable/huge files
    tid = setTimeout(() => finish(null), 60000)

    try {
      renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' })
      renderer.setSize(400, 400); renderer.setClearColor(0x131620, 1)
      renderer.toneMapping = T.ACESFilmicToneMapping ?? 4
      renderer.toneMappingExposure = 1.25
      if (T.SRGBColorSpace) renderer.outputColorSpace = T.SRGBColorSpace
      const scene = new T.Scene()
      const camera = new T.PerspectiveCamera(42, 1, 0.0001, 1e7)
      envReady = applyModelEnvironment(T, renderer, scene).then(dispose => {
        if (resolved) {
          dispose()
          return
        }
        disposeEnvironment = dispose
      })
      // Match the preview viewer's studio three-point lighting.
      scene.add(new T.HemisphereLight(0xf4f7ff, 0x2b2f38, 0.22))
      const key = new T.DirectionalLight(0xfff0dc, 1.85); key.position.set(5, 7, 5); scene.add(key)
      const fill = new T.DirectionalLight(0xdce8ff, 0.55); fill.position.set(-5, 3, 4); scene.add(fill)
      const rim = new T.DirectionalLight(0xe8f1ff, 1.25); rim.position.set(-4, 5, -6); scene.add(rim)
      const floorBounce = new T.DirectionalLight(0xeaf2ff, 0.35); floorBounce.position.set(0, -4, 2); scene.add(floorBounce)
      const url = `file://${filePath.replace(/\\/g, '/')}`
      const done2 = (obj: any) => {
        if (resolved) return
        const model = obj.scene ?? obj
        const box = new T.Box3().setFromObject(model)
        const center = box.getCenter(new T.Vector3())
        const size = box.getSize(new T.Vector3())
        const maxD = Math.max(size.x, size.y, size.z) || 1
        model.position.sub(center)
        model.traverse((child: any) => {
          if (!child.isMesh) return
          const mats = Array.isArray(child.material) ? child.material : [child.material]
          mats.forEach((m: any) => {
            if (!m) return
            if ('envMapIntensity' in m) m.envMapIntensity = 1.2
            if (ext === 'fbx') m.side = T.DoubleSide
            m.needsUpdate = true
          })
        })
        camera.position.set(maxD * 1.3, maxD * 1.0, maxD * 1.7); camera.lookAt(0, 0, 0)
        scene.add(model)
        const capture = () => {
          envReady.finally(() => {
            if (resolved) return
            renderer.render(scene, camera)
            try { finish(canvas.toDataURL('image/webp', 0.96)) } catch { finish(null) }
          })
        }
        if (ext === 'fbx') {
          let frames = 0
          const settle = () => {
            if (resolved) return
            renderer.render(scene, camera)
            frames += 1
            if (frames >= 8) window.setTimeout(capture, 120)
            else window.requestAnimationFrame(settle)
          }
          window.requestAnimationFrame(settle)
        } else {
          renderer.render(scene, camera); renderer.render(scene, camera); renderer.render(scene, camera)
          capture()
        }
      }
      const fail = (err?: any) => {
        console.warn('[3DThumb] load failed for', ext, err)
        // GLTF with missing .bin: render a placeholder box for the thumbnail
        if (ext === 'gltf' && !resolved && T.BoxGeometry) {
          try {
            const col = 0xff922b
            const solid = new T.Mesh(
              new T.BoxGeometry(1, 1, 1),
              new T.MeshStandardMaterial({ color: col, roughness: 0.55, metalness: 0.15, transparent: true, opacity: 0.55 })
            )
            const wire = new T.Mesh(
              new T.BoxGeometry(1.02, 1.02, 1.02),
              new T.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: 0.45 })
            )
            const group = new T.Group(); group.add(solid); group.add(wire)
            done2(group); return
          } catch {}
        }
        finish(null)
      }
      const makeGltfLoader = () => {
        const gl = new T.GLTFLoader()
        if (T.DRACOLoader) {
          const base = window.location.href.replace(/\/[^/]*$/, '/')
          const dracoLoader = new T.DRACOLoader()
          dracoLoader.setDecoderPath(`${base}draco/gltf/`)
          gl.setDRACOLoader(dracoLoader)
        }
        return gl
      }
      if ((ext === 'glb' || ext === 'gltf') && T.GLTFLoader) {
        if (ext === 'gltf') {
          patchGltfBuffers(filePath).then(patchedJson => {
            if (resolved) return
            const gl = makeGltfLoader()
            if (patchedJson) {
              const dir = filePath.replace(/\\/g, '/').replace(/\/[^/]+$/, '/')
              gl.parse(patchedJson, `file://${dir}/`, done2, fail)
            } else {
              // patchGltfBuffers failed (missing .bin) — render placeholder directly
              if (!resolved) fail()
            }
          }).catch(() => { if (!resolved) fail() })
        } else {
          makeGltfLoader().load(url, done2, undefined, fail)
        }
      }
      else if (ext === 'obj' && T.OBJLoader) new T.OBJLoader().load(url, done2, undefined, fail)
      else if (ext === 'stl' && T.STLLoader) new T.STLLoader().load(url, (geo: any) => {
        const mat = new T.MeshStandardMaterial({ color: 0x99bbdd, roughness: 0.35, metalness: 0.15 })
        done2(new T.Mesh(geo, mat))
      }, undefined, fail)
      else if (ext === 'ply' && T.PLYLoader) new T.PLYLoader().load(url, (geo: any) => {
        geo.computeVertexNormals()
        const mat = new T.MeshStandardMaterial({ color: 0x8ecae6, roughness: 0.4, metalness: 0.2, vertexColors: geo.hasAttribute('color') })
        done2(new T.Mesh(geo, mat))
      }, undefined, fail)
      else if (ext === 'dae' && T.ColladaLoader) new T.ColladaLoader().load(url, (c: any) => done2(c.scene ?? c), undefined, fail)
      else if (ext === 'fbx' && T.FBXLoader) new T.FBXLoader().load(url, done2, undefined, fail)
      else { console.warn('[3DThumb] no loader for ext:', ext, '— THREE loaders available:', Object.keys(T).filter(k => k.endsWith('Loader'))); finish(null) }
    } catch { finish(null) }
  })
}

function make3DPlaceholder(ext: string): string | null {
  try {
    const colors: Record<string, string> = {
      glb: '#ff922b', gltf: '#ff922b', obj: '#4ecdc4',
      fbx: '#ff6b9d', stl: '#c7f464', dae: '#88d8b0', ply: '#8ecae6'
    }
    const col = colors[ext] || '#ff922b'
    const c = document.createElement('canvas'); c.width = 400; c.height = 400
    const ctx = c.getContext('2d'); if (!ctx) return null

    // Dark background
    const bg = ctx.createRadialGradient(200, 180, 0, 200, 200, 260)
    bg.addColorStop(0, '#1c1f30'); bg.addColorStop(1, '#0d0f18')
    ctx.fillStyle = bg; ctx.fillRect(0, 0, 400, 400)

    // Isometric box wireframe
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.75
    ctx.lineJoin = 'round'
    const cx = 200, cy = 175, s = 72
    // top face
    const top = [[cx, cy - s], [cx + s, cy - s/2], [cx, cy], [cx - s, cy - s/2]]
    ctx.beginPath(); ctx.moveTo(top[0][0], top[0][1])
    top.forEach(p => ctx.lineTo(p[0], p[1])); ctx.closePath(); ctx.stroke()
    // right face
    ctx.beginPath()
    ctx.moveTo(cx + s, cy - s/2); ctx.lineTo(cx + s, cy + s/2)
    ctx.lineTo(cx, cy + s); ctx.lineTo(cx, cy); ctx.closePath(); ctx.stroke()
    // left face
    ctx.beginPath()
    ctx.moveTo(cx - s, cy - s/2); ctx.lineTo(cx - s, cy + s/2)
    ctx.lineTo(cx, cy + s); ctx.lineTo(cx, cy); ctx.closePath(); ctx.stroke()
    // vertical edges
    ctx.globalAlpha = 0.35
    ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy - s - 10); ctx.stroke()

    // Extension label
    ctx.globalAlpha = 0.9
    ctx.fillStyle = col
    ctx.font = 'bold 30px system-ui, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(ext.toUpperCase(), 200, 305)

    ctx.globalAlpha = 0.45
    ctx.fillStyle = '#8891aa'
    ctx.font = '13px system-ui, sans-serif'
    ctx.fillText('3D Model', 200, 340)

    return c.toDataURL('image/webp', 0.96)
  } catch { return null }
}

function bgProcess3D(id: string, filePath: string, ext: string, saveOptions: Record<string, any> = {}) {
  return new Promise<string | null>((resolve) => modelQueue.add(() => {
    render3DThumb(filePath, ext, (url) => {
      if (url) {
        bgSaveThumb(id, url, undefined, saveOptions).then(resolve)
        return
      }
      // Render failed (e.g. missing .bin) — save a styled placeholder so the
      // asset gets a thumbnailData and isn't re-queued every session.
      const placeholder = make3DPlaceholder(ext)
      if (placeholder) bgSaveThumb(id, placeholder, undefined, saveOptions).then(resolve)
      else resolve(null)
    })
  }))
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Enqueue background thumbnail generation for video and 3D assets.
 * Safe to call multiple times — already-queued or already-thumbed assets are skipped.
 * Images are handled by the main-process nativeImage worker, not here.
 */
export function enqueueBackgroundThumbs(
  assets: Array<{ id: string; filePath: string; ext: string; thumbnailData?: string }>
) {
  for (const a of assets) {
    if (a.thumbnailData || _bgQueued.has(a.id)) continue
    if (is3D(a.ext)) {
      _bgQueued.add(a.id)
      bgProcess3D(a.id, a.filePath, a.ext)
    } else if (isVideo(a.ext)) {
      _bgQueued.add(a.id)
      bgProcessVideo(a.id, a.filePath, a.ext)
    }
  }
}

export async function generateBackgroundThumbsSequential(
  assets: Array<{ id: string; filePath: string; ext: string; thumbnailData?: string }>,
  saveOptions: Record<string, any> = {},
  progressOptions: { type?: string; offset?: number; total?: number } = {},
) {
  const completed: string[] = []
  const pending = assets.filter(a => !a.thumbnailData)
  const progressType = progressOptions.type || 'media'
  const progressOffset = Math.max(0, progressOptions.offset || 0)
  const progressTotal = Math.max(pending.length, progressOptions.total || pending.length)
  const emitProgress = (current: number, file?: string) => emitRendererThumbProgress({
    type: progressType,
    current: Math.min(progressTotal, progressOffset + current),
    total: progressTotal,
    ...(file ? { file } : {}),
  })
  let processed = 0
  emitProgress(0)
  await Promise.all(pending.map(async a => {
    const file = a.filePath.replace(/\\/g, '/').split('/').pop()
    emitProgress(processed, file)
    _bgQueued.add(a.id)
    const thumbUrl = is3D(a.ext)
      ? await bgProcess3D(a.id, a.filePath, a.ext, saveOptions)
      : isVideo(a.ext)
        ? await bgProcessVideo(a.id, a.filePath, a.ext, saveOptions)
        : null
    if (thumbUrl) completed.push(a.id)
    processed += 1
    emitProgress(processed, file)
  }))
  if (progressType === 'media') {
    emitRendererThumbProgress({ type: 'done', current: processed, total: pending.length })
  } else {
    emitProgress(processed)
  }
  return completed
}
