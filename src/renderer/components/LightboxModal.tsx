import { useState, useCallback, useEffect, useRef, useMemo, createElement } from 'react'
import mpegts from 'mpegts.js'
import { FileText, Archive, Palette, Box, BookOpen, Folder, ExternalLink, X, AlertTriangle, Play, Pause, Volume2, VolumeX, Maximize, Minimize, Printer, Trash2, Share2, Sun, Copy, Globe2, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import { useStore } from '../store/useStore'
import { isImage, isVideo, isAudio, isFont, is3D, isEditableTarget } from '../utils/helpers'
import { shareAssets } from '../utils/share'
import styles from './LightboxModal.module.css'

// ── GLTF robust loader — embeds all external resources via IPC ─────────────
/**
 * Reads a GLTF JSON file and embeds all external binary buffers + textures as
 * base64 data URIs so Three.js never has to XHR local files.
 *
 * Returns the patched JSON string when ALL required buffers could be read.
 * Returns null if any buffer is missing — caller should fall back to normal
 * XHR load so Three.js surfaces a clear "Failed to load buffer" error.
 */
export async function patchGltfBuffers(filePath: string): Promise<string | null> {
  const api = (window as any).electronAPI
  const textResult = await api?.readText?.(filePath, 5 * 1024 * 1024).catch(() => null)
  if (!textResult?.text) return null
  let json: any
  try { json = JSON.parse(textResult.text) } catch { return null }

  const sep = filePath.includes('\\') ? '\\' : '/'
  const dir = filePath.substring(0, filePath.lastIndexOf(sep) + 1)

  // Embed buffer files (geometry) — abort entirely if any required buffer is missing
  if (Array.isArray(json.buffers)) {
    for (const buf of json.buffers) {
      if (!buf.uri || buf.uri.startsWith('data:')) continue
      const absPath = dir + buf.uri.replace(/\//g, sep)
      const b64 = await api?.readBinary?.(absPath).catch(() => null)
      if (!b64) return null  // missing buffer = no geometry = abort, let caller show error
      buf.uri = `data:application/octet-stream;base64,${b64}`
    }
  }

  // Embed image files (textures) — silently skip if missing (Three.js uses default material)
  if (Array.isArray(json.images)) {
    for (const img of json.images) {
      if (!img.uri || img.uri.startsWith('data:')) continue
      const imgExt = img.uri.split('.').pop()?.toLowerCase() ?? 'png'
      const mime   = imgExt === 'jpg' || imgExt === 'jpeg' ? 'image/jpeg' : `image/${imgExt}`
      const absPath = dir + img.uri.replace(/\//g, sep)
      const b64 = await api?.readBinary?.(absPath).catch(() => null)
      if (b64) img.uri = `data:${mime};base64,${b64}`
    }
  }

  return JSON.stringify(json)
}

// ── Shared Three.js loader ─────────────────────────────────────────────────
let _threeState: 'idle'|'loading'|'ready' = 'idle'
let _threeCbs: Array<()=>void> = []

function _loadScript(url: string): Promise<void> {
  return new Promise(resolve => {
    if (document.querySelector(`script[src="${url}"]`)) { resolve(); return }
    const s = document.createElement('script'); s.src = url
    s.onload = () => resolve(); s.onerror = () => resolve()
    document.head.appendChild(s)
  })
}

export function ensureThreeJS(cb: ()=>void) {
  if (_threeState === 'ready') { cb(); return }
  _threeCbs.push(cb)
  if (_threeState === 'loading') return
  _threeState = 'loading'
  // Load THREE first (establishes global), then fflate, then all loaders in parallel
  _loadScript('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js')
    .then(() => _loadScript('https://cdn.jsdelivr.net/npm/fflate@0.6.9/umd/index.js'))
    .then(() => Promise.all([
      _loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js'),
      _loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/DRACOLoader.js'),
      _loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.js'),
      _loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/STLLoader.js'),
      _loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/ColladaLoader.js'),
      _loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/FBXLoader.js'),
    ]))
    .then(() => Promise.all([
      _loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/PLYLoader.js'),
      _loadScript('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/EXRLoader.js'),
    ]))
    .then(() => { _threeState = 'ready'; _threeCbs.forEach(f => f()); _threeCbs = [] })
}

export function modelEnvironmentUrl() {
  return new URL('./resting_place_1k.exr', window.location.href).href
}

export function applyModelEnvironment(
  THREE: any,
  renderer: any,
  scene: any,
  intensity = 1.2
): Promise<() => void> {
  return new Promise<() => void>(resolve => {
    if (!THREE?.EXRLoader || !THREE?.PMREMGenerator) {
      resolve(() => {})
      return
    }

    const pmrem = new THREE.PMREMGenerator(renderer)
    try { pmrem.compileEquirectangularShader?.() } catch {}

    new THREE.EXRLoader().load(
      modelEnvironmentUrl(),
      (texture: any) => {
        try {
          const envMap = pmrem.fromEquirectangular(texture).texture
          const previousEnvironment = scene.environment
          scene.environment = envMap
          texture.dispose?.()
          resolve(() => {
            if (scene.environment === envMap) scene.environment = previousEnvironment ?? null
            envMap.dispose?.()
            pmrem.dispose?.()
          })
        } catch {
          try { texture.dispose?.(); pmrem.dispose?.() } catch {}
          resolve(() => {})
        }
      },
      undefined,
      () => {
        try { pmrem.dispose?.() } catch {}
        resolve(() => {})
      }
    )
  }).then(dispose => {
    scene.traverse?.((child: any) => {
      if (!child?.isMesh) return
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m: any) => {
        if (!m) return
        if ('envMapIntensity' in m) m.envMapIntensity = intensity
        m.needsUpdate = true
      })
    })
    return dispose
  })
}

// ── Interactive 3D viewer ──────────────────────────────────────────────────────
function Model3DViewer({ asset }: { asset: any }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [status, setStatus]       = useState<'loading'|'ready'|'error'>('loading')
  const [progress, setProgress]   = useState(0)
  const [errorMsg, setErrorMsg]   = useState('')
  const [isPlaceholder, setIsPlaceholder] = useState(false)
  const [lightingIntensity, setLightingIntensity] = useState(1)
  const lightingIntensityRef = useRef(1)
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const orbitRef = useRef({
    theta: 0.6, phi: 0.3, dist: 3,
    dragging: false, lx: 0, ly: 0,
    thetaV: 0, phiV: 0,
    autoRotate: false,
    idleTimer: 0,
  })
  const renderRef = useRef<{ renderer: any; camera: any; scene: any; animId: number; needsRender: boolean; lights?: any[]; disposeEnvironment?: () => void } | null>(null)

  const fileSizeMB = asset.size ? (asset.size / 1024 / 1024) : 0
  // Large files get more time; baseline 30s, +1s per MB over 10MB, cap 120s
  const loadTimeoutMs = Math.min(120000, 30000 + Math.max(0, fileSizeMB - 10) * 1000)

  const applyLightingIntensity = useCallback((intensity: number) => {
    const state = renderRef.current
    if (!state) return
    state.lights?.forEach((light: any) => {
      const base = light.userData?.baseIntensity
      if (typeof base === 'number') light.intensity = base * intensity
    })
    state.scene?.traverse?.((child: any) => {
      if (!child?.isMesh) return
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m: any) => {
        if (!m) return
        if ('envMapIntensity' in m) m.envMapIntensity = 1.2 * intensity
        m.needsUpdate = true
      })
    })
    state.needsRender = true
  }, [])

  useEffect(() => {
    lightingIntensityRef.current = lightingIntensity
    applyLightingIntensity(lightingIntensity)
  }, [applyLightingIntensity, lightingIntensity])

  useEffect(() => {
    const el = mountRef.current; if (!el) return
    let cancelled = false
    setProgress(0); setErrorMsg('')

    // Arm a timeout — FBXLoader gives no cancellation API so we just surface an error
    loadTimerRef.current = setTimeout(() => {
      if (!cancelled) {
        setErrorMsg(`Timed out loading ${fileSizeMB.toFixed(0)} MB file`)
        setStatus('error')
      }
    }, loadTimeoutMs)

    ensureThreeJS(() => {
      if (cancelled) return
      const THREE = (window as any).THREE
      if (!THREE) { setStatus('error'); return }

      const W = el.clientWidth || 900, H = el.clientHeight || 600
      const canvas = document.createElement('canvas')
      canvas.width = W; canvas.height = H
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'
      el.appendChild(canvas)

      // ── Renderer ──────────────────────────────────────────────────────────────
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, logarithmicDepthBuffer: true })
      renderer.setSize(W, H)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
      renderer.setClearColor(0x0a0b12, 1)
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFShadowMap
      // ACES filmic tone mapping for cinematic look
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.25

      // ── Scene + camera ────────────────────────────────────────────────────────
      const scene = new THREE.Scene()
      // Subtle fog for depth
      scene.fog = new THREE.FogExp2(0x0a0b12, 0.018)

      const camera = new THREE.PerspectiveCamera(42, W / H, 0.0001, 1e7)

      // ── Studio three-point lighting ──────────────────────────────────────────
      const hemi = new THREE.HemisphereLight(0xf4f7ff, 0x2b2f38, 0.22)
      scene.add(hemi)

      const key = new THREE.DirectionalLight(0xfff0dc, 1.85)
      key.position.set(5, 7, 5)
      key.castShadow = true
      key.shadow.mapSize.width = 1024; key.shadow.mapSize.height = 1024
      key.shadow.camera.near = 0.1; key.shadow.camera.far = 200
      key.shadow.bias = -0.001
      scene.add(key)

      const fill = new THREE.DirectionalLight(0xdce8ff, 0.55)
      fill.position.set(-5, 3, 4)
      scene.add(fill)

      const rim = new THREE.DirectionalLight(0xe8f1ff, 1.25)
      rim.position.set(-4, 5, -6)
      scene.add(rim)

      const floorBounce = new THREE.DirectionalLight(0xeaf2ff, 0.35)
      floorBounce.position.set(0, -4, 2)
      scene.add(floorBounce)

      const lights = [hemi, key, fill, rim, floorBounce]
      lights.forEach((light: any) => { light.userData.baseIntensity = light.intensity })

      const state: { renderer: any; camera: any; scene: any; animId: number; needsRender: boolean; lights?: any[]; disposeEnvironment?: () => void } = {
        renderer,
        camera,
        scene,
        animId: 0,
        needsRender: true,
        lights,
      }
      renderRef.current = state
      applyLightingIntensity(lightingIntensityRef.current)
      applyModelEnvironment(THREE, renderer, scene).then(disposeEnvironment => {
        if (cancelled) { disposeEnvironment(); return }
        state.disposeEnvironment = disposeEnvironment
        applyLightingIntensity(lightingIntensityRef.current)
      })

      const fp = asset.filePath.replace(/\\/g, '/')
      const url = `file://${fp}`
      const ext = asset.ext.toLowerCase()

      const onLoad = (obj: any) => {
        if (loadTimerRef.current) { clearTimeout(loadTimerRef.current); loadTimerRef.current = null }
        if (cancelled) { renderer.dispose(); return }
        try {
        const model = obj.scene ?? obj

        // Centre + normalise scale
        const box = new THREE.Box3().setFromObject(model)
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        const maxD = Math.max(size.x, size.y, size.z) || 1
        model.position.sub(center)

        // Scale fog so it's always visible at camera distance regardless of model size
        scene.fog = new THREE.FogExp2(0x0a0b12, 0.04 / maxD)

        // Enable shadows; fix material issues for FBX (Blender inverted normals → DoubleSide)
        model.traverse((child: any) => {
          if (!child.isMesh) return
          child.castShadow = true; child.receiveShadow = true
          const mats = Array.isArray(child.material) ? child.material : [child.material]
          mats.forEach((m: any) => {
            if (!m) return
            if ('envMapIntensity' in m) m.envMapIntensity = 1.2 * lightingIntensityRef.current
            m.needsUpdate = true
          })
          if (ext === 'fbx') {
            mats.forEach((m: any) => {
              if (!m) return
              m.side = THREE.DoubleSide
              m.needsUpdate = true
            })
          }
        })
        scene.add(model)

        // ── Floor plane ────────────────────────────────────────────────────────
        const floorY = -size.y / 2
        const floorSize = maxD * 7

        // Shadow-receiving plane
        const floorGeo = new THREE.PlaneGeometry(floorSize, floorSize)
        const floorMat = new THREE.MeshStandardMaterial({
          color: 0x4a4f58, roughness: 0.84, metalness: 0.02,
          transparent: true, opacity: 0.9,
        })
        const floor = new THREE.Mesh(floorGeo, floorMat)
        floor.rotation.x = -Math.PI / 2
        floor.position.y = floorY
        floor.receiveShadow = true
        scene.add(floor)

        // Faint grid on top of floor
        const grid = new THREE.GridHelper(floorSize, 16, 0x6a707a, 0x5b616b)
        grid.position.y = floorY + 0.001
        scene.add(grid)

        // Update shadow camera frustum to fit model
        const s = maxD * 3
        key.shadow.camera.left = -s; key.shadow.camera.right = s
        key.shadow.camera.top = s; key.shadow.camera.bottom = -s
        key.shadow.camera.updateProjectionMatrix()

        // Initial camera
        orbitRef.current.dist = maxD * 2.4
        positionCamera(camera, orbitRef.current)

        // ── Animate — demand rendering: only render when camera or scene changed ──
        const animate = () => {
          state.animId = requestAnimationFrame(animate)
          const o = orbitRef.current
          let changed = false

          if (o.autoRotate && !o.dragging) {
            o.theta += 0.004
            positionCamera(camera, o)
            changed = true
          } else if (!o.dragging) {
            // damping when released
            if (Math.abs(o.thetaV) > 0.0001 || Math.abs(o.phiV) > 0.0001) {
              o.theta += o.thetaV; o.phi += o.phiV
              o.thetaV *= 0.88; o.phiV *= 0.88
              o.phi = Math.max(-1.3, Math.min(1.3, o.phi))
              positionCamera(camera, o)
              changed = true
            }
          }

          if (changed || state.needsRender) {
            renderer.render(scene, camera)
            state.needsRender = false
          }
        }
        animate()
        setStatus('ready')
        } catch (e: any) {
          console.error('[Model3DViewer] onLoad threw:', e)
          setErrorMsg(e?.message || 'Scene setup failed')
          setStatus('error')
        }
      }

      const clearTimer = () => { if (loadTimerRef.current) { clearTimeout(loadTimerRef.current); loadTimerRef.current = null } }

      const onErr = (err?: any) => {
        clearTimer()
        let msg = ''
        if (err instanceof Error) msg = err.message
        else if (err?.message) msg = err.message
        else if (err?.target?.responseURL) msg = `Failed to load: ${err.target.responseURL.split('/').pop()}`
        console.warn('[Model3DViewer] load error for', ext, ':', msg, err)
        if (cancelled) return

        // GLTF with missing .bin: substitute a placeholder box so the viewer
        // still works — show it as 'ready' with a hint overlay instead of error
        if (ext === 'gltf') {
          const T = (window as any).THREE
          if (T?.BoxGeometry) {
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
              onLoad({ scene: group })
              setIsPlaceholder(true)
              return
            } catch {}
          }
        }

        setErrorMsg(msg); setStatus('error')
      }

      const onProgress = (xhr: any) => {
        if (xhr.total > 0) setProgress(Math.round(xhr.loaded / xhr.total * 100))
      }

      const makeGltfLoader = () => {
        const gltfLoader = new THREE.GLTFLoader()
        if (THREE.DRACOLoader) {
          const base = window.location.href.replace(/\/[^/]*$/, '/')
          const dracoLoader = new THREE.DRACOLoader()
          dracoLoader.setDecoderPath(`${base}draco/gltf/`)
          gltfLoader.setDRACOLoader(dracoLoader)
        }
        return gltfLoader
      }

      try {
        if ((ext==='glb'||ext==='gltf') && THREE.GLTFLoader) {
          if (ext === 'gltf') {
            // Pre-embed all external resources via IPC so missing .bin doesn't crash load
            patchGltfBuffers(asset.filePath).then(patchedJson => {
              if (cancelled) return
              const gl = makeGltfLoader()
              if (patchedJson) {
                const dir = asset.filePath.replace(/\\/g, '/').replace(/\/[^/]+$/, '/')
                gl.parse(patchedJson, `file://${dir}/`, onLoad, onErr)
              } else {
                // patchGltfBuffers failed (missing .bin or unreadable) — show placeholder directly
                if (!cancelled) onErr()
              }
            }).catch(() => { if (!cancelled) onErr() })
          } else {
            makeGltfLoader().load(url, onLoad, onProgress, onErr)
          }
        } else if (ext==='obj' && THREE.OBJLoader)               new THREE.OBJLoader().load(url, onLoad, onProgress, onErr)
        else if (ext==='stl' && THREE.STLLoader) {
          new THREE.STLLoader().load(url, (geo: any) => {
            const mat = new THREE.MeshStandardMaterial({ color: 0x7aa8d0, roughness: 0.35, metalness: 0.45 })
            onLoad(new THREE.Mesh(geo, mat))
          }, onProgress, onErr)
        }
        else if (ext==='ply' && THREE.PLYLoader) {
          new THREE.PLYLoader().load(url, (geo: any) => {
            geo.computeVertexNormals()
            const mat = new THREE.MeshStandardMaterial({ color: 0x8ecae6, roughness: 0.4, metalness: 0.2, vertexColors: geo.hasAttribute('color') })
            onLoad(new THREE.Mesh(geo, mat))
          }, onProgress, onErr)
        }
        else if (ext==='dae' && THREE.ColladaLoader) new THREE.ColladaLoader().load(url, (c: any) => onLoad(c.scene || c), onProgress, onErr)
        else if (ext==='fbx' && THREE.FBXLoader)      new THREE.FBXLoader().load(url, onLoad, onProgress, onErr)
        else onErr()
      } catch { onErr() }
    })

    return () => {
      cancelled = true
      if (loadTimerRef.current) { clearTimeout(loadTimerRef.current); loadTimerRef.current = null }
      if (renderRef.current) {
        const { renderer, animId, disposeEnvironment } = renderRef.current
        cancelAnimationFrame(animId)
        try { disposeEnvironment?.() } catch {}
        if (renderer.domElement?.parentNode === el) el.removeChild(renderer.domElement)
        renderer.dispose()
        try { renderer.forceContextLoss() } catch {}
      }
      renderRef.current = null
    }
  }, [asset.id])

  const positionCamera = (camera: any, o: any) => {
    camera.position.set(
      o.dist * Math.sin(o.theta) * Math.cos(o.phi),
      o.dist * Math.sin(o.phi),
      o.dist * Math.cos(o.theta) * Math.cos(o.phi),
    )
    camera.lookAt(0, 0, 0)
  }

  const onMD = (e: React.MouseEvent) => {
    const o = orbitRef.current
    o.dragging = true; o.autoRotate = false
    o.lx = e.clientX; o.ly = e.clientY
    o.thetaV = 0; o.phiV = 0
  }
  const onMM = (e: React.MouseEvent) => {
    const o = orbitRef.current; if (!o.dragging) return
    const dx = e.clientX - o.lx, dy = e.clientY - o.ly
    o.thetaV = -dx * 0.010; o.phiV = dy * 0.008
    o.theta += o.thetaV
    o.phi = Math.max(-1.3, Math.min(1.3, o.phi + o.phiV))
    o.lx = e.clientX; o.ly = e.clientY
    const r = renderRef.current; if (r) { positionCamera(r.camera, o); r.needsRender = true }
  }
  const onMU = () => { orbitRef.current.dragging = false }
  const onWheel = (e: React.WheelEvent) => {
    const o = orbitRef.current
    o.dist = Math.max(0.1, o.dist * (e.deltaY > 0 ? 1.1 : 0.91))
    const r = renderRef.current; if (r) { positionCamera(r.camera, o); r.needsRender = true }
    e.stopPropagation()
  }

  return (
    <div className={styles.model3dMount} ref={mountRef}
      onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onMU} onWheel={onWheel}>
      {status === 'loading' && (
        <div className={styles.model3dOverlay}>
          <div className={styles.model3dSpinner} />
          <span>
            Loading {asset.ext.toUpperCase()}…{progress > 0 && progress < 100 ? ` ${progress}%` : ''}
          </span>
          {fileSizeMB > 20 && (
            <small style={{opacity:0.5,fontSize:11}}>
              {fileSizeMB.toFixed(0)} MB — large file, parsing may take a moment
            </small>
          )}
          {fileSizeMB > 20 && (
            <button
              style={{marginTop:10,padding:'4px 12px',opacity:0.6,fontSize:11,cursor:'pointer',background:'transparent',border:'1px solid rgba(255,255,255,0.2)',borderRadius:4,color:'inherit'}}
              onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>
              Open in external app instead ↗
            </button>
          )}
        </div>
      )}
      {status === 'error' && (
        <div className={styles.model3dOverlay}>
          <Box size={32} strokeWidth={1.0} style={{ opacity: 0.4 }} />
          <span>{errorMsg || `Cannot preview .${asset.ext}`}</span>
          {errorMsg?.includes('.bin') && (
            <small style={{opacity:0.55,fontSize:11,maxWidth:320,textAlign:'center',lineHeight:1.5}}>
              GLTF files reference external .bin files. Make sure the .bin is in the same folder as the .gltf.
            </small>
          )}
          <small style={{opacity:0.35,fontSize:11}}>Supported: GLB · GLTF · OBJ · STL · DAE · FBX · PLY</small>
          <button
            style={{marginTop:10,padding:'4px 14px',fontSize:12,cursor:'pointer',background:'transparent',border:'1px solid rgba(255,255,255,0.25)',borderRadius:4,color:'inherit'}}
            onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>
            Open in external app ↗
          </button>
        </div>
      )}
      {status === 'ready' && isPlaceholder && (
        <div style={{position:'absolute',top:10,left:'50%',transform:'translateX(-50%)',
          background:'rgba(0,0,0,0.55)',borderRadius:6,padding:'4px 12px',
          fontSize:11,color:'rgba(255,146,43,0.9)',whiteSpace:'nowrap',pointerEvents:'none'}}>
          Geometry unavailable · companion .bin file is missing
        </div>
      )}
      {status === 'ready' && (
        <div className={styles.model3dHint}>
          <span>⟳ Drag</span><span style={{opacity:0.35}}>·</span>
          <span>⊕ Scroll to zoom</span><span style={{opacity:0.35}}>·</span>
          <label className={styles.model3dLightingControl} onMouseDown={e => e.stopPropagation()}>
            <Sun size={13} strokeWidth={2} />
            <input
              type="range"
              min="0.35"
              max="2.2"
              step="0.05"
              value={lightingIntensity}
              onChange={e => setLightingIntensity(Number(e.currentTarget.value))}
              aria-label="Lighting intensity"
            />
            <span>{Math.round(lightingIntensity * 100)}%</span>
          </label>
        </div>
      )}
    </div>
  )
}

// ── Session-level video mute preference ──────────────────────────────────────
let _sessionMuted = true  // muted by default; persists across lightbox opens

// ── Formats that need server-side conversion before Chromium can render them ──
const NEEDS_CONVERSION = new Set(['heic','heif','hif','icns','tga','dds','eps','tgs','tiff','tif'])

// ── Converted image preview ───────────────────────────────────────────────────
function ConvertedImagePreview({ asset }: { asset: any }) {
  const [src, setSrc]     = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    setSrc(null); setError(false)
    ;(window as any).electronAPI?.preparePreview(asset.id, asset.filePath, asset.ext.toLowerCase())
      .then((result: any) => {
        if (result?.url) setSrc(result.url)
        else setError(true)
      })
      .catch(() => setError(true))
  }, [asset.id])

  if (error) return (
    <div className={styles.centreMsg}>
      <AlertTriangle size={24} style={{ marginBottom: 6, opacity: 0.5 }} />
      <span>Cannot preview .{asset.ext}</span>
      <button className={styles.openExtBtn} style={{ marginTop: 8 }}
        onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>
        Open in external app ↗
      </button>
    </div>
  )
  if (!src) return <div className={styles.centreMsg}>Converting…</div>
  return (
    <img src={src} className={styles.previewImg} alt={asset.name}
      style={{ objectFit: 'contain', maxWidth: '100%', maxHeight: '100%' }} />
  )
}

// ── Text/code preview ─────────────────────────────────────────────────────────
const CODE_EXTS = ['js','ts','jsx','tsx','py','sh','bash','css','scss','html','xml','yaml','yml','toml','ini','env','gitignore','rb','go','rs','java','cpp','c','h','php','sql']
function fmtTime(s: number) {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`
}

function TextPreview({ asset }: { asset: any }) {
  const updateAsset = useStore(state => state.updateAsset)
  const [content, setContent] = useState<string|null>(null)
  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)
  const [saveState, setSaveState] = useState<'saved'|'pending'|'saving'|'error'>('saved')
  const latestContentRef = useRef('')
  const savedContentRef = useRef('')
  const resultIsTruncatedRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const writeQueueRef = useRef<Promise<any>>(Promise.resolve())
  const currentAssetIdRef = useRef(asset.id)
  const mountedRef = useRef(true)
  const api = (window as any).electronAPI
  currentAssetIdRef.current = asset.id

  const persistContent = useCallback(async (nextContent: string, quiet = false) => {
    if (truncated || nextContent === savedContentRef.current) return
    if (!quiet && mountedRef.current) setSaveState('saving')
    const result = await (writeQueueRef.current = writeQueueRef.current
      .catch(() => null)
      .then(() => api?.writeText?.(asset.id, asset.filePath, nextContent)))
    if (!result?.ok) {
      if (mountedRef.current && currentAssetIdRef.current === asset.id) setSaveState('error')
      return
    }
    updateAsset(asset.id, {
      size: result.size ?? new Blob([nextContent]).size,
      mtime: result.mtime ?? Date.now(),
    })
    if (currentAssetIdRef.current === asset.id) {
      savedContentRef.current = nextContent
      if (mountedRef.current && latestContentRef.current === nextContent) setSaveState('saved')
    }
  }, [api, asset.filePath, asset.id, truncated, updateAsset])

  useEffect(() => {
    let cancelled = false
    mountedRef.current = true
    setLoading(true)
    setContent(null)
    setTruncated(false)
    resultIsTruncatedRef.current = false
    latestContentRef.current = ''
    savedContentRef.current = ''
    setSaveState('saved')
    api?.readText(asset.filePath, 5 * 1024 * 1024).then((result: any) => {
      if (cancelled) return
      const text = result?.text ?? ''
      if (result?.text != null) {
        setContent(text)
        setTruncated(!!result.truncated)
        latestContentRef.current = text
        savedContentRef.current = text
      } else {
        setContent('')
        setSaveState('error')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
      mountedRef.current = false
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current)
      if (!resultIsTruncatedRef.current && latestContentRef.current !== savedContentRef.current) {
        const finalContent = latestContentRef.current
        writeQueueRef.current = writeQueueRef.current
          .catch(() => null)
          .then(() => api?.writeText?.(asset.id, asset.filePath, finalContent))
      }
    }
  }, [api, asset.filePath, asset.id])

  useEffect(() => { resultIsTruncatedRef.current = truncated }, [truncated])

  const handleChange = (nextContent: string) => {
    setContent(nextContent)
    latestContentRef.current = nextContent
    setSaveState('pending')
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void persistContent(nextContent)
    }, 350)
  }

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const editor = event.currentTarget
    const start = editor.selectionStart
    const end = editor.selectionEnd
    const nextContent = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`
    handleChange(nextContent)
    requestAnimationFrame(() => {
      editor.selectionStart = editor.selectionEnd = start + 2
    })
  }

  const isCode = CODE_EXTS.includes(asset.ext) || ['json','md','csv','xml'].includes(asset.ext)
  return (
    <div className={styles.textPreview}>
      {loading && <div className={styles.centreMsg}>⏳ Loading…</div>}
      {!loading && content != null && (
        <>
          <div className={`${styles.textEditorStatus} ${saveState === 'error' ? styles.textEditorStatusError : ''}`}>
            <span>{truncated ? 'Read-only: file is larger than 5 MB' : saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Could not save' : 'Unsaved changes'}</span>
            {truncated && <button onClick={() => api?.openPath(asset.filePath)}>Open externally</button>}
          </div>
          <textarea
            className={`${styles.textContent} ${styles.textEditor} ${isCode ? styles.codeContent : ''}`}
            value={content}
            readOnly={truncated}
            spellCheck={!isCode}
            onChange={event => handleChange(event.target.value)}
            onKeyDown={handleEditorKeyDown}
            aria-label={`Edit ${asset.name}`}
          />
        </>
      )}
    </div>
  )
}

function DocumentReaderToolbar({ subtitle, onPrev, onNext, onZoomOut, onZoomIn, onPrint, onFullscreen, fullscreen = false, extraControl }: {
  subtitle: string
  onPrev: () => void
  onNext: () => void
  onZoomOut: () => void
  onZoomIn: () => void
  onPrint?: () => void
  onFullscreen?: () => void
  fullscreen?: boolean
  extraControl?: React.ReactNode
}) {
  return (
    <div className={styles.documentToolbar}>
      <div className={styles.documentSubtitle}>{subtitle}</div>
      <div className={styles.documentControls}>
        <button onClick={onPrev} data-tooltip="Previous page" aria-label="Previous page"><ChevronLeft size={15} /></button>
        <button onClick={onNext} data-tooltip="Next page" aria-label="Next page"><ChevronRight size={15} /></button>
        <span className={styles.documentControlDivider} />
        <button onClick={onZoomOut} data-tooltip="Zoom out" aria-label="Zoom out"><ZoomOut size={14} /></button>
        <button onClick={onZoomIn} data-tooltip="Zoom in" aria-label="Zoom in"><ZoomIn size={14} /></button>
        {extraControl}
        {onPrint && <button onClick={onPrint} data-tooltip="Print current page" aria-label="Print current page"><Printer size={14} /></button>}
        {onFullscreen && (
          <button onClick={onFullscreen} data-tooltip={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
          </button>
        )}
      </div>
    </div>
  )
}

// ── PDF preview ───────────────────────────────────────────────────────────────
function PdfPreview({ asset }: { asset: any }) {
  const iframeCleanupRef = useRef<(() => void) | null>(null)
  const [viewerSource, setViewerSource] = useState('')
  const [status, setStatus] = useState<'loading'|'ready'|'error'>('loading')

  useEffect(() => {
    let disposed = false
    let pdfBlobUrl = ''
    setStatus('loading')
    setViewerSource('')
    ;(async () => {
      const base64 = await (window as any).electronAPI?.readBinary?.(asset.filePath)
      if (!base64) throw new Error('Could not read PDF file')
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      pdfBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      const viewerUrl = new URL('./pdfjs/web/viewer.html', window.location.href)
      viewerUrl.searchParams.set('file', pdfBlobUrl)
      if (!disposed) setViewerSource(viewerUrl.href)
    })().catch((error: any) => {
      console.error('[PDF.js viewer]', error)
      if (!disposed) setStatus('error')
    })
    return () => {
      disposed = true
      iframeCleanupRef.current?.()
      iframeCleanupRef.current = null
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl)
    }
  }, [asset.id, asset.filePath])

  const handleViewerLoad = (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    iframeCleanupRef.current?.()
    const viewerWindow = event.currentTarget.contentWindow
    if (viewerWindow) {
      const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== ' ' || isEditableTarget(keyEvent.target)) return
        keyEvent.preventDefault()
        keyEvent.stopImmediatePropagation()
        useStore.getState().setLightboxAsset(null)
      }
      viewerWindow.addEventListener('keydown', handleKeyDown)
      iframeCleanupRef.current = () => viewerWindow.removeEventListener('keydown', handleKeyDown)
    }
    setStatus('ready')
  }

  return (
    <div className={styles.pdfOfficialViewer}>
      {viewerSource && (
        <iframe
          key={viewerSource}
          className={styles.pdfViewerFrame}
          src={viewerSource}
          title={`PDF viewer: ${asset.name}`}
          onLoad={handleViewerLoad}
        />
      )}
      {status === 'loading' && <div className={styles.documentStatus}>Loading Mozilla PDF.js viewer…</div>}
      {status === 'error' && (
        <div className={styles.documentStatus}>
          <AlertTriangle size={24} />
          <span>PDF preview could not be loaded.</span>
          <button className={styles.openExtBtn} onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>Open externally</button>
        </div>
      )}
    </div>
  )
}

function EpubPreview({ asset }: { asset: any }) {
  const readerRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<any>(null)
  const renditionRef = useRef<any>(null)
  const [status, setStatus] = useState<'loading'|'ready'|'error'>('loading')
  const [location, setLocation] = useState('Opening book')
  const [fontSize, setFontSize] = useState(100)
  const [errorMessage, setErrorMessage] = useState('')
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === readerRef.current)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    let disposed = false
    setStatus('loading')
    setLocation('Opening book')
    setErrorMessage('')
    ;(async () => {
      try {
        const fileUrl = await (window as any).electronAPI?.getFileUrl(asset.filePath)
        if (!fileUrl || disposed || !mountRef.current) throw new Error('Could not access EPUB file')
        const epubModule: any = await import('epubjs')
        const createBook = typeof epubModule.default === 'function'
          ? epubModule.default
          : epubModule.default?.default || epubModule['module.exports']?.default
        if (typeof createBook !== 'function') throw new Error('EPUB.js failed to initialize')
        const book = createBook(fileUrl, { openAs: 'epub' })
        bookRef.current = book
        await book.opened
        if (disposed || !mountRef.current) return
        const rendition = book.renderTo(mountRef.current, {
          width: '100%',
          height: '100%',
          manager: 'default',
          spread: 'always',
          flow: 'paginated',
          minSpreadWidth: 700,
        })
        renditionRef.current = rendition
        rendition.themes.default({
          body: {
            color: '#292633',
            background: '#fbfaf7',
            'font-family': 'Georgia, serif',
            'line-height': '1.65',
            padding: '2rem 3rem !important',
          },
          'a': { color: '#6c5ce7' },
        })
        rendition.themes.fontSize(`${fontSize}%`)
        const updateLocation = (position: any) => {
          const cfi = position?.start?.cfi
          const sectionIndex = Number(position?.start?.index)
          const sectionCount = book.spine?.spineItems?.length || 0
          if (cfi && book.locations?.total > 0) {
            const percentage = Math.max(0, Math.min(100, Math.round(book.locations.percentageFromCfi(cfi) * 100)))
            setLocation(`${percentage}%`)
          } else if (Number.isFinite(sectionIndex) && sectionCount) {
            setLocation(`Section ${sectionIndex + 1} of ${sectionCount}`)
          } else {
            setLocation('EPUB')
          }
        }
        rendition.on('relocated', updateLocation)
        rendition.on('keydown', (keyEvent: KeyboardEvent) => {
          if (keyEvent.key !== ' ' || isEditableTarget(keyEvent.target)) return
          keyEvent.preventDefault()
          keyEvent.stopImmediatePropagation()
          useStore.getState().setLightboxAsset(null)
        })
        await rendition.display()
        book.locations.generate(1600).then(() => {
          if (!disposed) updateLocation(rendition.currentLocation())
        }).catch(() => {})
        if (!disposed) setStatus('ready')
      } catch (error: any) {
        console.error('[EPUB Preview]', error)
        if (!disposed) {
          setErrorMessage(error?.message || 'Unknown EPUB error')
          setStatus('error')
        }
      }
    })()
    return () => {
      disposed = true
      try { renditionRef.current?.destroy?.() } catch {}
      try { bookRef.current?.destroy?.() } catch {}
      renditionRef.current = null
      bookRef.current = null
    }
  }, [asset.id])

  const changeFontSize = (next: number) => {
    const safe = Math.max(70, Math.min(180, next))
    setFontSize(safe)
    renditionRef.current?.themes?.fontSize?.(`${safe}%`)
  }

  const toggleFullscreen = async () => {
    if (document.fullscreenElement === readerRef.current) await document.exitFullscreen()
    else await readerRef.current?.requestFullscreen()
  }

  const printCurrentPage = () => {
    ;(window as any).electronAPI?.printCurrentView?.()
  }

  return (
    <div ref={readerRef} className={styles.documentReader}>
      <DocumentReaderToolbar
        subtitle={`EPUB · ${location} · ${fontSize}%`}
        onPrev={() => renditionRef.current?.prev?.()}
        onNext={() => renditionRef.current?.next?.()}
        onZoomOut={() => changeFontSize(fontSize - 10)}
        onZoomIn={() => changeFontSize(fontSize + 10)}
        onPrint={printCurrentPage}
        onFullscreen={toggleFullscreen}
        fullscreen={fullscreen}
      />
      <div className={styles.documentStage}>
        <div ref={mountRef} className={styles.epubMount} />
        {status === 'loading' && <div className={styles.documentStatus}>Loading EPUB…</div>}
        {status === 'error' && (
          <div className={styles.documentStatus}>
            <AlertTriangle size={24} />
            <span>EPUB preview could not be loaded.</span>
            {errorMessage && <small>{errorMessage}</small>}
            <button className={styles.openExtBtn} onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>Open externally</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Font preview ──────────────────────────────────────────────────────────────
const FONT_SAMPLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789 !@#$%^&*()\nThe quick brown fox jumps over the lazy dog'
function FontPreview({ asset }: { asset: any }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [sampleText, setSampleText] = useState(FONT_SAMPLE.split('\n')[3])
  const fontId = `font_preview_${asset.id}`
  const previewText = sampleText.trim() || FONT_SAMPLE.split('\n')[3]

  useEffect(() => {
    setLoaded(false); setError(false)
    const fp = asset.filePath.replace(/\\/g, '/')
    const style = document.createElement('style')
    style.id = fontId
    style.textContent = `@font-face { font-family: "${fontId}"; src: url("file://${fp}"); font-display: swap; }`
    document.head.appendChild(style)
    // Wait for font to load
    document.fonts.load(`16px "${fontId}"`).then(() => setLoaded(true)).catch(() => setError(true))
    return () => { const s = document.getElementById(fontId); if (s) s.remove() }
  }, [asset.id])

  return (
    <div className={styles.fontPreview}>
      {!loaded && !error && <div className={styles.centreMsg}>Loading font…</div>}
      {error && <div className={styles.centreMsg}><AlertTriangle size={20} style={{marginBottom:4}}/> Could not load font</div>}
      {loaded && (
        <>
          <div className={styles.fontHero} style={{ fontFamily: `"${fontId}"` }}>Aa</div>
          <div className={styles.fontMeta}>
            <span className={styles.fontName}>{asset.name}</span>
            <span className={styles.fontExtBadge}>{asset.ext.toUpperCase()}</span>
          </div>
          <textarea
            className={styles.fontInput}
            value={sampleText}
            onChange={e => setSampleText(e.target.value)}
            aria-label="Font preview text"
            rows={2}
          />
          <div className={styles.fontDivider} />
          {[56, 36, 24, 16].map(sz => (
            <div key={sz} className={styles.fontSampleRow}>
              <span className={styles.fontSizeTag}>{sz}px</span>
              <span className={styles.fontSample} style={{ fontFamily: `"${fontId}"`, fontSize: sz }}>
                {previewText}
              </span>
            </div>
          ))}
          <div className={styles.fontDivider} />
          <pre className={styles.fontGrid} style={{ fontFamily: `"${fontId}"` }}>{`${FONT_SAMPLE}\n${previewText}`}</pre>
        </>
      )}
    </div>
  )
}

function VideoScrubStrip({ asset, duration, current, onSeek }: { asset: any; duration: number; current: number; onSeek: (time: number) => void }) {
  const count = 12
  const [frames, setFrames] = useState<string[]>([])
  const [hoverFrames, setHoverFrames] = useState<Record<number, string[]>>({})
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [hoverTick, setHoverTick] = useState(0)
  const active = duration > 0 ? Math.min(count - 1, Math.floor((current / duration) * count)) : 0

  useEffect(() => {
    let cancelled = false
    setFrames([])
    setHoverFrames({})
    setHoverIndex(null)
    if (!duration || duration <= 0) return
    const api = (window as any).electronAPI
    if (!api?.generateVideoThumb) return

    ;(async () => {
      const next: string[] = Array(count).fill('')
      const usableDuration = Math.max(0.1, duration - 0.1)
      for (let i = 0; i < count; i++) {
        if (cancelled) return
        const time = Math.min(usableDuration, Math.max(0, (usableDuration * (i + 0.5)) / count))
        try {
          const result = await api.generateVideoThumb({
            id: `${asset.id}_scrub_${i}`,
            filePath: asset.filePath,
            ext: asset.ext.toLowerCase(),
            timeSec: time,
            transient: true,
            maxDim: 260,
          })
          if (!cancelled && result?.thumbUrl) {
            next[i] = result.thumbUrl
            setFrames([...next])
          }
        } catch {}
      }
    })()

    return () => { cancelled = true }
  }, [asset.id, asset.filePath, asset.ext, duration])

  useEffect(() => {
    if (hoverIndex === null) return
    const sequence = hoverFrames[hoverIndex]
    if (!sequence?.length) return
    const id = window.setInterval(() => setHoverTick(t => t + 1), 180)
    return () => window.clearInterval(id)
  }, [hoverIndex, hoverFrames])

  const ensureHoverFrames = async (index: number) => {
    if (!duration || hoverFrames[index]?.length) return
    const api = (window as any).electronAPI
    if (!api?.generateVideoThumb) return
    const usableDuration = Math.max(0.1, duration - 0.1)
    const segStart = (usableDuration * index) / count
    const segEnd = (usableDuration * (index + 1)) / count
    const times = [0.12, 0.32, 0.52, 0.72, 0.9].map(p => Math.min(usableDuration, segStart + (segEnd - segStart) * p))
    const sequence: string[] = []
    for (let n = 0; n < times.length; n++) {
      try {
        const result = await api.generateVideoThumb({
          id: `${asset.id}_scrub_hover_${index}_${n}`,
          filePath: asset.filePath,
          ext: asset.ext.toLowerCase(),
          timeSec: times[n],
          transient: true,
          maxDim: 260,
        })
        if (result?.thumbUrl) sequence.push(result.thumbUrl)
      } catch {}
    }
    if (sequence.length) setHoverFrames(currentFrames => ({ ...currentFrames, [index]: sequence }))
  }

  return (
    <div className={styles.scrubStrip} aria-label="Video scrub thumbnails">
      {Array.from({ length: count }).map((_, i) => {
        const time = duration > 0 ? (duration * i) / count : 0
        const sequence = hoverFrames[i]
        const thumb = hoverIndex === i && sequence?.length ? sequence[hoverTick % sequence.length] : frames[i]
        const isSkeleton = !thumb
        return (
          <button
            key={i}
            className={`${styles.scrubThumb} ${i === active ? styles.scrubThumbActive : ''} ${isSkeleton ? styles.scrubThumbLoading : ''} ${hoverIndex === i ? styles.scrubThumbHover : ''}`}
            style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}
            onClick={() => onSeek(time)}
            onMouseEnter={() => { setHoverIndex(i); setHoverTick(0); ensureHoverFrames(i) }}
            onMouseLeave={() => setHoverIndex(null)}
            aria-label={`Seek to ${fmtTime(time)}`}
          />
        )
      })}
    </div>
  )
}

// ── MPEG-TS player via mpegts.js — custom controls like ts-preview/server.js ──
function TsMpegtsPlayer({ asset }: { asset: any }) {
  const videoRef      = useRef<HTMLVideoElement>(null)
  const wrapRef       = useRef<HTMLDivElement>(null)
  const playerRef     = useRef<any>(null)
  const seekingRef    = useRef(false)   // ref so event handlers see live value
  const wasPlayingRef = useRef(false)   // remember play state before seek

  const [ready, setReady]     = useState<{ url: string; durationSec: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted,   setMuted]   = useState(_sessionMuted)
  const [current, setCurrent] = useState(0)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    seekingRef.current = false
    wasPlayingRef.current = false
    setReady(null)
    setPlaying(false)
    setCurrent(0)
    setError(null)
  }, [asset.id])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = (window as any).electronAPI
        const [port, durationMs] = await Promise.all([
          api?.getBridgePort?.() as Promise<number> ?? Promise.resolve(57432),
          api?.getVideoDuration?.(asset.filePath) as Promise<number | null> ?? Promise.resolve(null),
        ])
        if (!cancelled) {
          const encoded = encodeURIComponent(asset.filePath)
          setReady({
            url: `http://127.0.0.1:${port}/videostream?path=${encoded}`,
            durationSec: durationMs ? durationMs / 1000 : 0,
          })
        }
      } catch { if (!cancelled) setError('Failed to initialise player') }
    })()
    return () => { cancelled = true }
  }, [asset.filePath])

  useEffect(() => {
    if (!ready || !videoRef.current) return
    if (!mpegts.isSupported()) { setError('MSE not supported'); return }

    const ext = asset.ext.toLowerCase()
    const mediaDataSource: any = {
      type: ext === 'flv' ? 'flv' : 'mpegts',
      isLive: false,
      url: ready.url,
    }
    if (ready.durationSec > 0) mediaDataSource.duration = Math.round(ready.durationSec * 1000)

    const player = mpegts.createPlayer(mediaDataSource, {
      enableWorker: true, enableStashBuffer: true,
      stashInitialSize: 2 * 1024 * 1024, lazyLoad: false,
      autoCleanupSourceBuffer: true,
      seekType: 'range', rangeLoadZeroStart: true, accurateSeek: true,
    })
    playerRef.current = player
    player.attachMediaElement(videoRef.current)
    player.load()
    player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
      console.error('[mpegts]', type, detail)
      setError(`${detail}`)
    })
    videoRef.current.play().catch(() => {})
    return () => { try { player.destroy() } catch {} ; playerRef.current = null }
  }, [ready])

  // Event listeners — use refs so handlers always see current seeking state
  useEffect(() => {
    const v = videoRef.current; if (!v) return
    const onPlay  = () => setPlaying(true)
    const onPause = () => { if (!seekingRef.current) setPlaying(false) }
    const onTime  = () => { if (!seekingRef.current) setCurrent(v.currentTime || 0) }
    v.addEventListener('play',       onPlay)
    v.addEventListener('pause',      onPause)
    v.addEventListener('timeupdate', onTime)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('timeupdate', onTime)
    }
  }, [])  // mount only — handlers read refs, not stale state

  const togglePlay = () => {
    const v = videoRef.current; if (!v) return
    v.paused ? v.play().catch(() => {}) : v.pause()
  }
  const toggleMute = () => {
    const v = videoRef.current; if (!v) return
    v.muted = !v.muted
    _sessionMuted = v.muted
    setMuted(v.muted)
  }
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) wrapRef.current?.requestFullscreen()
    else document.exitFullscreen()
  }
  const onSeekInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current
    wasPlayingRef.current = !!(v && !v.paused)
    seekingRef.current = true
    setCurrent(Number(e.target.value))
  }
  const onSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value)
    const v = videoRef.current
    if (v && Number.isFinite(t)) {
      v.currentTime = t
      // mpegts.js pauses internally during buffer refill — resume if was playing
      if (wasPlayingRef.current) {
        const resume = () => { v.play().catch(() => {}); v.removeEventListener('seeked', resume) }
        v.addEventListener('seeked', resume)
      }
    }
    seekingRef.current = false
  }
  const dur = ready?.durationSec ?? 0

  const seekTo = (t: number) => {
    const v = videoRef.current
    if (!v || !Number.isFinite(t)) return
    v.currentTime = Math.max(0, Math.min(t, dur || t))
    setCurrent(v.currentTime)
    if (!v.paused) v.play().catch(() => {})
  }

  if (error) return (
    <div className={styles.videoPlayerWrap} style={{ display:'flex', alignItems:'center', justifyContent:'center', color:'rgba(255,255,255,0.45)', fontSize:13 }}>
      {error}
    </div>
  )

  return (
    <div ref={wrapRef} className={styles.videoPlayerWrap}>
      <video ref={videoRef} key={asset.id} className={styles.previewVideo} playsInline muted={muted} />
      <VideoScrubStrip asset={asset} duration={dur} current={current} onSeek={seekTo} />
      <div className={styles.tsControls}>
        <button className={styles.tsBtn} onClick={togglePlay}>{playing ? <Pause size={13} strokeWidth={2}/> : <Play size={13} strokeWidth={2}/>}</button>
        <span className={styles.tsTime}>{fmtTime(current)} / {fmtTime(dur)}</span>
        <input className={styles.tsSeek} type="range" min={0} max={dur || 0} step={0.1}
          value={current}
          onChange={onSeekInput}
          onMouseUp={onSeekChange as any}
          onTouchEnd={onSeekChange as any}
        />
        <button className={styles.tsBtn} onClick={toggleMute}>{muted ? <VolumeX size={13} strokeWidth={2}/> : <Volume2 size={13} strokeWidth={2}/>}</button>
        <span className={styles.videoExtBadge} style={{ marginLeft: 4 }}>{asset.ext.toUpperCase()}</span>
        <button className={styles.tsBtn} onClick={toggleFullscreen} data-tooltip="Fullscreen" aria-label="Fullscreen"><Maximize size={12} strokeWidth={2}/></button>
      </div>
    </div>
  )
}

// ── Video player — .mp4, .mov, .webm, etc. — custom controls ────────────────────
function VideoPlayer({ asset }: { asset: any }) {
  const ext = asset.ext.toLowerCase()

  // mpegts.js handles MPEG-TS (.ts, .mts, .m2ts) and FLV (.flv)
  if (ext === 'ts' || ext === 'mts' || ext === 'm2ts' || ext === 'flv') return <TsMpegtsPlayer asset={asset} />

  // All other video: native HTML5 with custom controls
  return <NativeVideoPlayer asset={asset} />
}

function NativeVideoPlayer({ asset }: { asset: any }) {
  const videoRef   = useRef<HTMLVideoElement>(null)
  const wrapRef    = useRef<HTMLDivElement>(null)
  const seekingRef = useRef(false)

  const [playing,    setPlaying]    = useState(false)
  const [muted,      setMuted]      = useState(_sessionMuted)
  const [current,    setCurrent]    = useState(0)
  const [dur,        setDur]        = useState(0)

  const fp  = asset.filePath.replace(/\\/g, '/')
  const url = `file://${fp}`
  const ext = asset.ext.toLowerCase()

  const mimeMap: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/x-m4v',
    mov: 'video/quicktime', webm: 'video/webm',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
    mpg: 'video/mpeg', mpeg: 'video/mpeg', m2ts: 'video/mp2t',
  }
  const mimeType = mimeMap[ext] || 'video/mp4'

  useEffect(() => {
    const v = videoRef.current
    seekingRef.current = false
    setPlaying(false)
    setCurrent(0)
    setDur(0)
    if (v) {
      try {
        v.pause()
        v.currentTime = 0
        v.load()
      } catch {}
    }
  }, [asset.id])

  useEffect(() => {
    const v = videoRef.current; if (!v) return
    const onPlay    = () => setPlaying(true)
    const onPause   = () => { if (!seekingRef.current) setPlaying(false) }
    const onTime    = () => { if (!seekingRef.current) setCurrent(v.currentTime || 0) }
    const onMeta    = () => setDur(isFinite(v.duration) ? v.duration : 0)
    const onDurChng = () => setDur(isFinite(v.duration) ? v.duration : 0)
    v.addEventListener('play',           onPlay)
    v.addEventListener('pause',          onPause)
    v.addEventListener('timeupdate',     onTime)
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('durationchange', onDurChng)
    return () => {
      v.removeEventListener('play',           onPlay)
      v.removeEventListener('pause',          onPause)
      v.removeEventListener('timeupdate',     onTime)
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('durationchange', onDurChng)
    }
  }, [])  // mount only — handlers read seekingRef, not stale state

  const togglePlay = () => {
    const v = videoRef.current; if (!v) return
    v.paused ? v.play().catch(() => {}) : v.pause()
  }
  const toggleMute = () => {
    const v = videoRef.current; if (!v) return
    v.muted = !v.muted
    _sessionMuted = v.muted
    setMuted(v.muted)
  }
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) wrapRef.current?.requestFullscreen()
    else document.exitFullscreen()
  }
  const onSeekInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    seekingRef.current = true
    setCurrent(Number(e.target.value))
  }
  const onSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value)
    if (videoRef.current && Number.isFinite(t)) videoRef.current.currentTime = t
    seekingRef.current = false
  }
  const seekTo = (t: number) => {
    const v = videoRef.current
    if (!v || !Number.isFinite(t)) return
    v.currentTime = Math.max(0, Math.min(t, dur || t))
    setCurrent(v.currentTime)
  }

  return (
    <div ref={wrapRef} className={styles.videoPlayerWrap}>
      <video ref={videoRef} key={asset.id} className={styles.previewVideo}
        autoPlay playsInline preload="auto" muted={muted}>
        <source src={url} type={mimeType} />
        <source src={url} />
      </video>
      <VideoScrubStrip asset={asset} duration={dur} current={current} onSeek={seekTo} />
      <div className={styles.tsControls}>
        <button className={styles.tsBtn} onClick={togglePlay}>{playing ? <Pause size={13} strokeWidth={2}/> : <Play size={13} strokeWidth={2}/>}</button>
        <span className={styles.tsTime}>{fmtTime(current)} / {fmtTime(dur)}</span>
        <input className={styles.tsSeek} type="range" min={0} max={dur || 0} step={0.1}
          value={current} onChange={onSeekInput}
          onMouseUp={onSeekChange as any} onTouchEnd={onSeekChange as any} />
        <button className={styles.tsBtn} onClick={toggleMute}>{muted ? <VolumeX size={13} strokeWidth={2}/> : <Volume2 size={13} strokeWidth={2}/>}</button>
        <span className={styles.videoExtBadge}>{asset.ext.toUpperCase()}</span>
        <button className={styles.tsBtn} onClick={toggleFullscreen} data-tooltip="Fullscreen" aria-label="Fullscreen"><Maximize size={12} strokeWidth={2}/></button>
      </div>
    </div>
  )
}

// ── Audio player ──────────────────────────────────────────────────────────────
function AudioPreview({ asset }: { asset: any }) {
  const fp = asset.filePath.replace(/\\/g, '/')
  const [playing, setPlaying] = useState(false)
  const [dur, setDur] = useState(0)
  const [current, setCurrent] = useState(0)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const seed = asset.id.split('').reduce((n: number, ch: string) => n + ch.charCodeAt(0), 0)
  const bars = Array.from({ length: 64 }, (_, i) => {
    const wave = Math.sin((i + seed) * 0.72) * 0.25 + Math.sin((i + seed) * 0.19) * 0.18
    return Math.max(0.18, Math.min(1, 0.58 + wave))
  })
  const trimLeft = dur ? (trimStart / dur) * 100 : 0
  const trimRight = dur ? 100 - (trimEnd / dur) * 100 : 0

  const playTrim = () => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = trimStart
    audio.play().catch(() => {})
  }

  return (
    <div className={styles.audioPreview}>
      <div className={styles.audioTimeline}>
        <div className={styles.audioWave}>
          {bars.map((h, i) => (
            <div key={i} className={`${styles.audioBar} ${playing ? styles.audioBarPlaying : ''}`}
              style={{ height: `${h * 74}px`, animationDelay: `${i * 0.035}s` }} />
          ))}
        </div>
        <div className={styles.audioTrimRegion} style={{ left: `${trimLeft}%`, right: `${trimRight}%` }} />
        <div className={styles.audioPlayhead} style={{ left: `${dur ? (current / dur) * 100 : 0}%` }} />
        <input
          className={`${styles.audioTrimRange} ${styles.audioTrimStart}`}
          type="range"
          min={0}
          max={dur || 0}
          step={0.05}
          value={trimStart}
          onChange={e => setTrimStart(Math.min(Number(e.target.value), Math.max(0, trimEnd - 0.1)))}
          aria-label="Trim start"
        />
        <input
          className={`${styles.audioTrimRange} ${styles.audioTrimEnd}`}
          type="range"
          min={0}
          max={dur || 0}
          step={0.05}
          value={trimEnd}
          onChange={e => setTrimEnd(Math.max(Number(e.target.value), Math.min(dur, trimStart + 0.1)))}
          aria-label="Trim end"
        />
      </div>
      <div className={styles.audioMeta}>
        <div className={styles.audioTitle}>{asset.name}</div>
        <div className={styles.audioExt}>{asset.ext.toUpperCase()}</div>
      </div>
      <div className={styles.audioTrimMeta}>
        <span>Start {fmtTime(trimStart)}</span>
        <button className={styles.audioTrimPlay} onClick={playTrim}>
          <Play size={12} strokeWidth={2} />
          Preview Trim
        </button>
        <span>End {fmtTime(trimEnd || dur)}</span>
      </div>
      <audio ref={audioRef} controls autoPlay className={styles.audioPlayer} key={asset.id}
        onLoadedMetadata={e => {
          const nextDur = Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0
          setDur(nextDur)
          setTrimStart(0)
          setTrimEnd(nextDur)
        }}
        onTimeUpdate={e => {
          const t = e.currentTarget.currentTime || 0
          setCurrent(t)
          if (trimEnd > 0 && t > trimEnd + 0.03) {
            e.currentTarget.pause()
            e.currentTarget.currentTime = trimStart
          }
        }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}>
        <source src={`file://${fp}`} />
      </audio>
    </div>
  )
}

// ── Generic / unsupported ─────────────────────────────────────────────────────
function GenericPreview({ asset }: { asset: any }) {
  const ext = asset.ext.toLowerCase()
  let icon = <Folder size={52} strokeWidth={1.0} style={{ opacity: 0.4 }} />
  if (['pdf','doc','docx','txt','md'].includes(ext)) icon = <FileText size={52} strokeWidth={1.0} style={{ opacity: 0.5, color: '#e05252' }} />
  if (['zip','rar','7z','tar','gz'].includes(ext))    icon = <Archive size={52} strokeWidth={1.0} style={{ opacity: 0.5, color: '#9b59b6' }} />
  if (['psd','ai','fig','sketch','xd','eps'].includes(ext)) icon = <Palette size={52} strokeWidth={1.0} style={{ opacity: 0.5, color: '#a259ff' }} />
  if (['blend','fbx','3ds'].includes(ext))             icon = <Box size={52} strokeWidth={1.0} style={{ opacity: 0.5, color: '#ff922b' }} />
  if (['epub','mobi'].includes(ext))                   icon = <BookOpen size={52} strokeWidth={1.0} style={{ opacity: 0.5, color: '#ff922b' }} />

  const sizeStr = asset.size ? (asset.size > 1048576 ? `${(asset.size/1048576).toFixed(1)} MB` : `${Math.round(asset.size/1024)} KB`) : null
  return (
    <div className={styles.genericPreview}>
      <div className={styles.genericIconWrap}>{icon}</div>
      <div className={styles.genericExt}>{asset.ext.toUpperCase()}</div>
      <div className={styles.genericName}>{asset.name}.{asset.ext}</div>
      {sizeStr && <div className={styles.genericSize}>{sizeStr}</div>}
      <button className={styles.openExtBtn} onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>
        <ExternalLink size={13} strokeWidth={1.8} style={{ display:'inline', verticalAlign:'middle', marginRight:4 }} />Open in external app
      </button>
    </div>
  )
}

function WebsitePreview({ asset }: { asset: any }) {
  const webviewRef = useRef<any>(null)
  const [state, setState] = useState<'loading'|'ready'|'error'>('loading')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    setState('loading')
    const ready = () => setState('ready')
    const failed = (event: any) => {
      if (event?.errorCode !== -3) setState('error')
    }
    webview.addEventListener('dom-ready', ready)
    webview.addEventListener('did-stop-loading', ready)
    webview.addEventListener('did-fail-load', failed)
    return () => {
      webview.removeEventListener('dom-ready', ready)
      webview.removeEventListener('did-stop-loading', ready)
      webview.removeEventListener('did-fail-load', failed)
    }
  }, [asset.id, retry])

  return (
    <div className={styles.websitePreview}>
      {createElement('webview' as any, {
        key: `${asset.id}-${retry}`,
        ref: webviewRef,
        src: asset.url,
        className: styles.websiteWebview,
        partition: 'persist:url-preview',
      })}
      {state === 'loading' && <div className={styles.websiteStatus}>Loading website…</div>}
      {state === 'error' && (
        <div className={styles.websiteStatus}>
          <AlertTriangle size={24} />
          <span>This website could not be loaded inside Stag.</span>
          <div className={styles.websiteStatusActions}>
            <button className={styles.openExtBtn} onClick={() => setRetry(value => value + 1)}>Retry</button>
            <button className={styles.openExtBtn} onClick={() => (window as any).electronAPI?.openExternalUrl(asset.url)}>Open in browser</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Decide which viewer to use ────────────────────────────────────────────────
function PreviewContent({ asset, zoom, pan, dragging, onImgLoad }: any) {
  const ext = asset.ext.toLowerCase()

  if (ext === 'url') return <WebsitePreview asset={asset} />

  const fp = asset.filePath.replace(/\\/g, '/')
  if (isImage(ext)) {
    // Formats needing server-side conversion before Chromium can render them
    if (NEEDS_CONVERSION.has(ext)) return <ConvertedImagePreview asset={asset} />
    return (
      <img key={asset.id} src={`file://${fp}`} className={styles.previewImg} alt={asset.name} draggable={false}
        style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transition: dragging?'none':'transform 0.08s' }}
        onLoad={onImgLoad} />
    )
  }
  if (isVideo(ext)) return <VideoPlayer key={asset.id} asset={asset} />
  if (isAudio(ext)) return <AudioPreview asset={asset} />
  if (is3D(ext))    return <Model3DViewer asset={asset} />
  if (ext === 'pdf') return <PdfPreview asset={asset} />
  if (ext === 'epub') return <EpubPreview asset={asset} />
  if (isFont(ext))  return <FontPreview asset={asset} />
  // Text, code, JSON, CSV, XML, MD, etc.
  if (['txt','md','json','csv','xml','html','css','js','ts','jsx','tsx','py','sh','bash',
       'yaml','yml','toml','ini','env','rb','go','rs','java','cpp','c','h','php','sql',
       'gitignore','log','cfg','conf','env'].includes(ext)) return <TextPreview asset={asset} />
  // Design files and archives — open externally
  return <GenericPreview asset={asset} />
}

// ── Main lightbox ─────────────────────────────────────────────────────────────
export default function LightboxModal() {
  const { lightboxAsset, setLightboxAsset, assets, filteredAssetIds, deleteAssets, permanentDeleteWithPrompt, activeFolderType, showToast } = useStore()
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x:0, y:0 })
  const [dragging, setDragging] = useState(false)
  const [drag0, setDrag0] = useState({ x:0, y:0, px:0, py:0 })
  const [convertedUrl, setConvertedUrl] = useState<string|null>(null)
  const [convertedLoading, setConvertedLoading] = useState(false)
  const [convertedError, setConvertedError] = useState(false)
  const [slideshow, setSlideshow] = useState(false)

  useEffect(() => {
    if (!lightboxAsset) { setConvertedUrl(null); return }
    setZoom(1); setPan({x:0,y:0}); setConvertedUrl(null); setConvertedError(false)
  }, [lightboxAsset?.id])

  // Load converted preview for formats Chromium can't render directly
  useEffect(() => {
    if (!lightboxAsset) return
    const ext = lightboxAsset.ext.toLowerCase()
    if (!NEEDS_CONVERSION.has(ext)) return
    setConvertedLoading(true)
    ;(window as any).electronAPI?.preparePreview(lightboxAsset.id, lightboxAsset.filePath, ext)
      .then((result: any) => {
        if (result?.url) setConvertedUrl(result.url)
        else setConvertedError(true)
      })
      .catch(() => setConvertedError(true))
      .finally(() => setConvertedLoading(false))
  }, [lightboxAsset?.id])

  const assetById = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets])
  const visibleAssetIds = useMemo(() => filteredAssetIds.filter(id => {
    const asset = assetById.get(id)
    if (!asset) return false
    return activeFolderType === 'trash' ? !!asset.deleted : !asset.deleted
  }), [activeFolderType, assetById, filteredAssetIds])

  const goDir = useCallback((dir: 1|-1) => {
    if (!lightboxAsset) return
    const idx = visibleAssetIds.indexOf(lightboxAsset.id)
    const next = assetById.get(visibleAssetIds[idx+dir])
    if (next) setLightboxAsset(next)
  }, [assetById, lightboxAsset, visibleAssetIds, setLightboxAsset])

  const goNextLoop = useCallback(() => {
    if (!lightboxAsset || visibleAssetIds.length < 2) return
    const idx = visibleAssetIds.indexOf(lightboxAsset.id)
    const nextId = visibleAssetIds[(idx + 1) % visibleAssetIds.length]
    const next = assetById.get(nextId)
    if (next) setLightboxAsset(next)
  }, [assetById, lightboxAsset, visibleAssetIds, setLightboxAsset])

  const deleteCurrent = useCallback(async () => {
    if (!lightboxAsset) return

    setSlideshow(false)
    const currentId = lightboxAsset.id
    const idx = visibleAssetIds.indexOf(currentId)
    const nextId = idx >= 0
      ? visibleAssetIds[idx + 1] ?? visibleAssetIds[idx - 1]
      : visibleAssetIds.find(id => id !== currentId)
    const nextAsset = nextId ? assetById.get(nextId) ?? null : null

    if (activeFolderType === 'trash') {
      await permanentDeleteWithPrompt([currentId])
      const stillExists = useStore.getState().assets.some(a => a.id === currentId)
      if (!stillExists) setLightboxAsset(nextAsset)
      return
    }

    setLightboxAsset(nextAsset)
    deleteAssets([currentId])
  }, [activeFolderType, assetById, deleteAssets, lightboxAsset, permanentDeleteWithPrompt, setLightboxAsset, visibleAssetIds])

  const shareCurrent = useCallback(() => {
    if (!lightboxAsset) return
    void shareAssets([lightboxAsset], showToast)
  }, [lightboxAsset, showToast])

  const copyCurrentUrl = useCallback(async () => {
    if (!lightboxAsset?.url) return
    try {
      await navigator.clipboard.writeText(lightboxAsset.url)
      showToast('URL copied', 'success')
    } catch {
      showToast('Could not copy URL', 'error')
    }
  }, [lightboxAsset, showToast])

  const close = useCallback(() => { setSlideshow(false); setLightboxAsset(null) }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      if (e.key==='Escape') close()
      else if (e.key===' ') { e.preventDefault(); e.stopImmediatePropagation(); close() }
      else if (e.key==='ArrowRight') goDir(1)
      else if (e.key==='ArrowLeft') goDir(-1)
      else if (e.key==='Delete' || e.key==='Backspace') { e.preventDefault(); e.stopImmediatePropagation(); void deleteCurrent() }
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [close, deleteCurrent, goDir])

  useEffect(() => {
    if (!slideshow || !lightboxAsset || visibleAssetIds.length < 2) return
    const id = window.setInterval(goNextLoop, 3200)
    return () => window.clearInterval(id)
  }, [slideshow, lightboxAsset?.id, visibleAssetIds.length, goNextLoop])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setZoom(z => Math.max(0.2, Math.min(10, z*(e.deltaY>0?0.88:1.14))))
  }, [])

  if (!lightboxAsset) return null

  const idx = visibleAssetIds.indexOf(lightboxAsset.id)
  const total = visibleAssetIds.length
  const ext = lightboxAsset.ext.toLowerCase()
  const needsConversion = NEEDS_CONVERSION.has(ext)
  const isImg = isImage(ext)
  const isWeb = ext === 'url'
  const canSlideshow = total > 1
  const displayName = isWeb ? lightboxAsset.name : `${lightboxAsset.name}.${lightboxAsset.ext}`

  const bottomNavigation = (
    <div className={styles.previewNavigation} onClick={event => event.stopPropagation()}>
      <button onClick={() => goDir(-1)} disabled={idx <= 0} aria-label="Previous asset">
        <ChevronLeft size={16} />
      </button>
      <span>{idx + 1} / {total}</span>
      <button onClick={() => goDir(1)} disabled={idx >= total - 1} aria-label="Next asset">
        <ChevronRight size={16} />
      </button>
    </div>
  )

  const sharedActions = (
    <div className={styles.previewActions} onClick={event => event.stopPropagation()}>
      <button
        className={`${styles.hBtn} ${slideshow ? styles.hBtnActive : ''}`}
        onClick={() => setSlideshow(value => !value)}
        disabled={!canSlideshow}
        data-tooltip={slideshow ? 'Pause slideshow' : 'Start slideshow'}
        aria-label={slideshow ? 'Pause slideshow' : 'Start slideshow'}
      >
        {slideshow ? <Pause size={14} /> : <Play size={14} />}
      </button>
      {isWeb ? <>
        <button className={styles.hBtn} onClick={copyCurrentUrl} data-tooltip="Copy URL" aria-label="Copy URL"><Copy size={14} /></button>
        <button className={styles.hBtn} onClick={() => (window as any).electronAPI?.openExternalUrl(lightboxAsset.url)} data-tooltip="Open in browser" aria-label="Open in browser"><Globe2 size={14} /></button>
      </> : <>
        <button className={styles.hBtn} onClick={shareCurrent} data-tooltip="Share" aria-label="Share"><Share2 size={14} /></button>
        <button className={styles.hBtn} onClick={() => (window as any).electronAPI?.openPath(lightboxAsset.filePath)} data-tooltip="Open externally" aria-label="Open externally"><ExternalLink size={14} /></button>
      </>}
      <button className={`${styles.hBtn} ${styles.hBtnDanger}`} onClick={deleteCurrent} data-tooltip={activeFolderType === 'trash' ? 'Delete permanently' : 'Move to trash'} aria-label={activeFolderType === 'trash' ? 'Delete permanently' : 'Move to trash'}>
        <Trash2 size={14} />
      </button>
    </div>
  )

  // ── Image: full-screen layout (regular + converted formats) ───────────────
  if (isImg) {
    const imgSrc = needsConversion
      ? convertedUrl
      : `file://${lightboxAsset.filePath.replace(/\\/g, '/')}`

    return (
      <div className={styles.overlay} onClick={close}>
        <div className={styles.previewShell} onClick={event => event.stopPropagation()}>
          <div className={styles.imageTools}>
            <button className={styles.hBtn} onClick={() => { setZoom(1); setPan({x:0,y:0}) }} data-tooltip="Reset zoom" aria-label="Reset zoom">1:1</button>
            <button className={styles.hBtn} onClick={() => { setZoom(1); setPan({x:0,y:0}) }} data-tooltip="Fit image" aria-label="Fit image">Fit</button>
            <button className={styles.hBtn} onClick={() => setZoom(z => Math.min(10, z*1.3))}>+</button>
            <span className={styles.zoomLbl}>{Math.round(zoom*100)}%</span>
            <button className={styles.hBtn} onClick={() => setZoom(z => Math.max(0.1, z*0.77))}>−</button>
          </div>
          {sharedActions}
          <button className={styles.previewClose} onClick={close} aria-label="Close preview">
            <span className={styles.previewCloseVisual}><X size={18} /></span>
          </button>
          <div className={styles.imageOverlay}>
            <div className={styles.imageCanvas}
              style={{ cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
              onWheel={handleWheel}
              onMouseDown={e => { if (e.button !== 0) return; setDragging(true); setDrag0({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }) }}
              onMouseMove={e => { if (!dragging) return; setPan({ x: drag0.px + e.clientX - drag0.x, y: drag0.py + e.clientY - drag0.y }) }}
              onMouseUp={() => setDragging(false)}
              onMouseLeave={() => setDragging(false)}>
              {needsConversion && convertedLoading && <div className={styles.centreMsg}>Converting…</div>}
              {needsConversion && convertedError && (
                <div className={styles.centreMsg}>
                  <AlertTriangle size={24} style={{ marginBottom: 6, opacity: 0.5 }} />
                  <span>Cannot preview .{ext}</span>
                  <button className={styles.openExtBtn} style={{ marginTop: 8 }}
                    onClick={() => (window as any).electronAPI?.openPath(lightboxAsset.filePath)}>
                    Open in external app ↗
                  </button>
                </div>
              )}
              {imgSrc && (
                <img
                  key={lightboxAsset.id + (convertedUrl || '')}
                  src={imgSrc}
                  className={styles.previewImg}
                  alt={lightboxAsset.name}
                  draggable={false}
                  style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transition: dragging ? 'none' : 'transform 0.08s' }}
                />
              )}
            </div>
          </div>
          <div className={styles.previewFilename}>{displayName}</div>
          {bottomNavigation}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.overlay} onClick={close}>
      <div className={`${styles.previewShell} ${styles.nonImageShell}`} onClick={event => event.stopPropagation()}>
        {sharedActions}
        <button className={styles.previewClose} onClick={close} aria-label="Close preview">
          <span className={styles.previewCloseVisual}><X size={18} /></span>
        </button>
        <div className={styles.modal}>
          <div className={styles.content}>
            <PreviewContent asset={lightboxAsset} zoom={1} pan={{x:0,y:0}} dragging={false} onImgLoad={() => {}} />
          </div>
        </div>
        <div className={styles.previewFilename}>{displayName}</div>
        {bottomNavigation}
      </div>
    </div>
  )
}
