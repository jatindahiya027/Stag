/**
 * Background thumbnail engine for video and 3D assets.
 * Runs entirely in the renderer but independent of component visibility.
 * Imported by useStore (for post-import queuing) and App.tsx (for startup queuing).
 * Does NOT import from useStore — uses electronAPI directly to avoid circular deps.
 */

import { isVideo, is3D } from './utils/helpers'
import { ensureThreeJS } from './components/LightboxModal'

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

export let videoQueue = makeQueue(2)
export const modelQueue = makeQueue(1)  // 1 WebGL context at a time

export function applyImportThreads(threads: number) {
  videoQueue = makeQueue(Math.max(1, Math.min(threads, 4)))
}

// ── Global dedup set ──────────────────────────────────────────────────────────
const _bgQueued = new Set<string>()

// ── Helpers ───────────────────────────────────────────────────────────────────
function bgSaveThumb(id: string, dataUrl: string) {
  const api = (window as any).electronAPI
  if (api?.dbSaveThumbnail) {
    api.dbSaveThumbnail(id, dataUrl).then((fileUrl: string | null) => {
      if (fileUrl) {
        // Update store via direct Zustand import-free path — dynamic require avoids
        // circular dep at module-evaluation time. Zustand store is already initialised
        // by the time any thumbnail finishes.
        import('./store/useStore').then(({ useStore }) => {
          useStore.getState().updateAsset(id, { thumbnailData: fileUrl })
        })
      }
    })
  } else {
    import('./store/useStore').then(({ useStore }) => {
      useStore.getState().updateAsset(id, { thumbnailData: dataUrl })
    })
  }
}

// ── Video frame extraction ────────────────────────────────────────────────────
function bgProcessVideo(id: string, filePath: string) {
  videoQueue.add(() => {
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true; v.preload = 'auto'
    v.src = `file://${filePath.replace(/\\/g, '/')}`

    let captured = false
    let tid: ReturnType<typeof setTimeout>

    const finish = () => { clearTimeout(tid); v.src = ''; v.load(); videoQueue.done() }

    const grab = () => {
      if (captured) return
      captured = true
      try {
        if (v.videoWidth === 0 || v.readyState < 2) { finish(); return }
        const W = Math.min(v.videoWidth, 480)
        const H = Math.max(1, Math.round((W * v.videoHeight) / v.videoWidth))
        const c = document.createElement('canvas')
        c.width = W; c.height = H
        const ctx = c.getContext('2d')
        if (ctx) {
          ctx.drawImage(v, 0, 0, W, H)
          const url = c.toDataURL('image/jpeg', 0.82)
          if (url.length > 500) bgSaveThumb(id, url)
        }
      } catch {}
      finish()
    }

    v.addEventListener('loadedmetadata', () => {
      v.currentTime = isFinite(v.duration) && v.duration > 0 ? Math.max(0.1, v.duration * 0.1) : 0.5
    }, { once: true })
    v.addEventListener('seeked', grab, { once: true })
    v.addEventListener('error', () => { if (!captured) { captured = true; finish() } }, { once: true })
    tid = setTimeout(() => { if (!captured) { captured = true; finish() } }, 8000)
    v.load()
  })
}

// ── 3D model rendering ────────────────────────────────────────────────────────
function render3DThumb(filePath: string, ext: string, cb: (url: string | null) => void) {
  ensureThreeJS(() => {
    const T = (window as any).THREE
    if (!T) { cb(null); modelQueue.done(); return }
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 400
    let renderer: any
    try {
      renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'default' })
      renderer.setSize(400, 400); renderer.setClearColor(0x131620, 1)
      const scene = new T.Scene()
      const camera = new T.PerspectiveCamera(45, 1, 0.0001, 1e7)
      scene.add(new T.AmbientLight(0xffffff, 0.85))
      const sun = new T.DirectionalLight(0xffffff, 1.3); sun.position.set(4, 6, 5); scene.add(sun)
      const fill = new T.DirectionalLight(0x8899ff, 0.4); fill.position.set(-3, -1, -4); scene.add(fill)
      const url = `file://${filePath.replace(/\\/g, '/')}`
      const done2 = (obj: any) => {
        const model = obj.scene ?? obj
        const box = new T.Box3().setFromObject(model)
        const center = box.getCenter(new T.Vector3())
        const size = box.getSize(new T.Vector3())
        const maxD = Math.max(size.x, size.y, size.z) || 1
        model.position.sub(center)
        camera.position.set(maxD * 1.2, maxD * 0.8, maxD * 1.8); camera.lookAt(0, 0, 0)
        scene.add(model)
        renderer.render(scene, camera); renderer.render(scene, camera)
        try { cb(canvas.toDataURL('image/jpeg', 0.9)) } catch { cb(null) }
        try { renderer.dispose() } catch {}
        modelQueue.done()
      }
      const fail = () => { try { renderer?.dispose() } catch {}; cb(null); modelQueue.done() }
      if ((ext === 'glb' || ext === 'gltf') && T.GLTFLoader) new T.GLTFLoader().load(url, done2, undefined, fail)
      else if (ext === 'obj' && T.OBJLoader) new T.OBJLoader().load(url, done2, undefined, fail)
      else if (ext === 'stl' && T.STLLoader) new T.STLLoader().load(url, (geo: any) => {
        const mat = new T.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.4, metalness: 0.3 })
        done2(new T.Mesh(geo, mat))
      }, undefined, fail)
      else if (ext === 'dae' && T.ColladaLoader) new T.ColladaLoader().load(url, (c: any) => done2(c.scene ?? c), undefined, fail)
      else if (ext === 'fbx' && T.FBXLoader) new T.FBXLoader().load(url, done2, undefined, fail)
      else { try { renderer.dispose() } catch {}; cb(null); modelQueue.done() }
    } catch { try { renderer?.dispose() } catch {}; cb(null); modelQueue.done() }
  })
}

function bgProcess3D(id: string, filePath: string, ext: string) {
  modelQueue.add(() => {
    render3DThumb(filePath, ext, (url) => {
      if (url) bgSaveThumb(id, url)
    })
  })
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
      bgProcessVideo(a.id, a.filePath)
    }
  }
}
