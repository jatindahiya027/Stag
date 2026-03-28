import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { isImage, isVideo, isAudio, isFont, is3D, isDoc, isDesign } from '../utils/helpers'
import styles from './LightboxModal.module.css'

// ── Shared Three.js loader ─────────────────────────────────────────────────
let _threeState: 'idle'|'loading'|'ready' = 'idle'
let _threeCbs: Array<()=>void> = []
export function ensureThreeJS(cb: ()=>void) {
  if (_threeState === 'ready') { cb(); return }
  _threeCbs.push(cb)
  if (_threeState === 'loading') return
  _threeState = 'loading'
  const urls = [
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    'https://cdn.jsdelivr.net/npm/fflate@0.6.9/umd/index.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/FBXLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/STLLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/ColladaLoader.js',
  ]
  let i = 0
  const next = () => {
    if (i >= urls.length) { _threeState = 'ready'; _threeCbs.forEach(f => f()); _threeCbs = []; return }
    const url = urls[i++]
    if (document.querySelector(`script[src="${url}"]`)) { next(); return }
    const s = document.createElement('script'); s.src = url
    s.onload = next; s.onerror = next  // keep going even if one fails
    document.head.appendChild(s)
  }
  next()
}

// ── 3D viewer — robust blank-screen fix ───────────────────────────────────────
// Uses a mutable `session` ref so the RAF loop sees cleanup synchronously.
// ── Interactive 3D viewer ──────────────────────────────────────────────────────
function Model3DViewer({ asset }: { asset: any }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading'|'ready'|'error'>('loading')
  const orbitRef = useRef({ theta: 0.5, phi: 0.3, dist: 3, dragging: false, lx: 0, ly: 0 })
  const renderRef = useRef<{ renderer: any; camera: any; scene: any; animId: number } | null>(null)

  useEffect(() => {
    const el = mountRef.current; if (!el) return
    let cancelled = false

    ensureThreeJS(() => {
      if (cancelled) return
      const THREE = (window as any).THREE
      if (!THREE) { setStatus('error'); return }

      const W = el.clientWidth || 800, H = el.clientHeight || 500
      const canvas = document.createElement('canvas')
      canvas.width = W; canvas.height = H
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:0 0 var(--radius-xl) var(--radius-xl)'
      el.appendChild(canvas)

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
      renderer.setSize(W, H); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setClearColor(0x000000, 0)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(45, W/H, 0.0001, 1e7)
      scene.add(new THREE.AmbientLight(0xffffff, 0.9))
      const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(4,7,5); scene.add(sun)
     // const fill = new THREE.DirectionalLight(0x88aaff, 0.5); fill.position.set(-3,-2,-4); scene.add(fill)
// 1. Hemisphere Light (Better than AmbientLight: gradient from sky color to ground color)
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8)
hemiLight.position.set(0, 10, 0)
scene.add(hemiLight)

// 2. Main Key Light (Directional - acts like the Sun)
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2)
keyLight.position.set(5, 8, 5)
scene.add(keyLight)

// 3. Fill Light (Directional - softer, cooler light to fill in shadows)
const fillLight = new THREE.DirectionalLight(0x88bbff, 0.6)
fillLight.position.set(-5, 3, -5)
scene.add(fillLight)

// 4. Accent Point Light (Adds a warm, local glowing highlight near the model)
const pointLight = new THREE.PointLight(0xffccaa, 1.5, 20)
pointLight.position.set(-2, 2, 3)
scene.add(pointLight)

// 5. Rim Light (Spotlight from behind to separate the model from the background)
const rimLight = new THREE.SpotLight(0xffffff, 2)
rimLight.position.set(0, 5, -8)
rimLight.angle = Math.PI / 4
rimLight.penumbra = 0.5
scene.add(rimLight)
      const state = { renderer, camera, scene, animId: 0 }
      renderRef.current = state

      const fp = asset.filePath.replace(/\\/g, '/')
      const url = `file://${fp}`
      const ext = asset.ext.toLowerCase()

      const onLoad = (obj: any) => {
        if (cancelled) { renderer.dispose(); return }
        const model = obj.scene ?? obj  // GLTF has .scene, others are direct
        const box = new THREE.Box3().setFromObject(model)
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        const maxD = Math.max(size.x, size.y, size.z) || 1
        model.position.sub(center)
        scene.add(model)

        // Add subtle grid
        const grid = new THREE.GridHelper(maxD*4, 10, 0x334, 0x223)
        grid.position.y = -size.y/2; scene.add(grid)

        // Set initial camera position
        orbitRef.current.dist = maxD * 2.2
        const o = orbitRef.current
        camera.position.set(
          o.dist * Math.sin(o.theta) * Math.cos(o.phi),
          o.dist * Math.sin(o.phi),
          o.dist * Math.cos(o.theta) * Math.cos(o.phi)
        )
        camera.lookAt(0,0,0)

        const animate = () => {
          state.animId = requestAnimationFrame(animate)
          renderer.render(scene, camera)
        }
        animate()
        setStatus('ready')
      }
      const onErr = () => { if (!cancelled) setStatus('error') }

      try {
        if ((ext==='glb'||ext==='gltf') && THREE.GLTFLoader) new THREE.GLTFLoader().load(url, onLoad, undefined, onErr)
        else if (ext==='obj' && THREE.OBJLoader) new THREE.OBJLoader().load(url, onLoad, undefined, onErr)
        else if (ext==='stl' && THREE.STLLoader) {
          new THREE.STLLoader().load(url, (geo: any) => {
            const mat = new THREE.MeshStandardMaterial({ color:0x88aacc, roughness:0.4, metalness:0.3 })
            onLoad(new THREE.Mesh(geo, mat))
          }, undefined, onErr)
        }
        else if (ext==='dae' && THREE.ColladaLoader) new THREE.ColladaLoader().load(url, (c: any) => onLoad(c.scene||c), undefined, onErr)
        else if (ext==='fbx' && THREE.FBXLoader) new THREE.FBXLoader().load(url, onLoad, undefined, onErr)
        else onErr()
      } catch { onErr() }
    })

    return () => {
  cancelled = true;
  if (renderRef.current) {
    const { renderer, animId } = renderRef.current;
    
    // 1. Stop the animation loop
    cancelAnimationFrame(animId);
    
    // 2. Remove the specific canvas element from the DOM
    if (renderer.domElement && renderer.domElement.parentNode === el) {
      el.removeChild(renderer.domElement);
    }

    // 3. Dispose of the renderer and WebGL context
    renderer.dispose();
    renderer.forceContextLoss(); // Optional: helps clear memory faster
  }
  renderRef.current = null;
};
  }, [asset.id])

  const updateCamera = () => {
    const r = renderRef.current; if (!r) return
    const o = orbitRef.current
    r.camera.position.set(
      o.dist * Math.sin(o.theta) * Math.cos(o.phi),
      o.dist * Math.sin(o.phi),
      o.dist * Math.cos(o.theta) * Math.cos(o.phi)
    )
    r.camera.lookAt(0,0,0)
  }

  const onMD = (e: React.MouseEvent) => { orbitRef.current.dragging=true; orbitRef.current.lx=e.clientX; orbitRef.current.ly=e.clientY }
  const onMM = (e: React.MouseEvent) => {
    const o = orbitRef.current; if (!o.dragging) return
    o.theta -= (e.clientX-o.lx)*0.012; o.phi = Math.max(-1.3, Math.min(1.3, o.phi+(e.clientY-o.ly)*0.009))
    o.lx=e.clientX; o.ly=e.clientY; updateCamera()
  }
  const onMU = () => { orbitRef.current.dragging=false }
  const onWheel = (e: React.WheelEvent) => {
    orbitRef.current.dist *= e.deltaY > 0 ? 1.12 : 0.88
    updateCamera(); e.stopPropagation()
  }

  return (
    <div className={styles.model3dMount} ref={mountRef}
      onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onMU} onWheel={onWheel}>
      {status==='loading' && <div className={styles.model3dOverlay}>⏳ Loading {asset.ext.toUpperCase()} model…</div>}
      {status==='error'   && <div className={styles.model3dOverlay}>⚠️ Cannot preview .{asset.ext}<br/><small style={{opacity:.6}}>Supported: GLB, GLTF, OBJ, STL, DAE</small></div>}
      {status==='ready'   && <div className={styles.model3dHint}>Drag to orbit · Scroll to zoom</div>}
    </div>
  )
}

// ── Text/code preview ─────────────────────────────────────────────────────────
const CODE_EXTS = ['js','ts','jsx','tsx','py','sh','bash','css','scss','html','xml','yaml','yml','toml','ini','env','gitignore','rb','go','rs','java','cpp','c','h','php','sql']
const IMG_EXTS  = ['jpg','jpeg','png','gif','webp','svg','bmp','ico','avif']

function TextPreview({ asset }: { asset: any }) {
  const [content, setContent] = useState<string|null>(null)
  const [loading, setLoading] = useState(true)
  const [truncated, setTruncated] = useState(false)

  useEffect(() => {
    setLoading(true); setContent(null)
    ;(window as any).electronAPI?.readText(asset.filePath, 100000).then((r: any) => {
      if (r?.text != null) { setContent(r.text); setTruncated(r.truncated) }
      else setContent('(Could not read file)')
      setLoading(false)
    })
  }, [asset.id])

  const isCode = CODE_EXTS.includes(asset.ext) || ['json','md','csv','xml'].includes(asset.ext)
  return (
    <div className={styles.textPreview}>
      {loading && <div className={styles.centreMsg}>⏳ Loading…</div>}
      {!loading && content != null && (
        <>
          {truncated && <div className={styles.truncBanner}>Showing first 100 KB · <button onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>Open full file ↗</button></div>}
          <pre className={`${styles.textContent} ${isCode ? styles.codeContent : ''}`}>{content}</pre>
        </>
      )}
    </div>
  )
}

// ── PDF preview ───────────────────────────────────────────────────────────────
function PdfPreview({ asset }: { asset: any }) {
  const fp = asset.filePath.replace(/\\/g, '/')
  return (
    <div className={styles.pdfWrap}>
      <object data={`file://${fp}`} type="application/pdf" className={styles.pdfObject}>
        <div className={styles.centreMsg}>
          📄 PDF preview not available<br/>
          <button className={styles.openExtBtn} onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>Open in PDF reader ↗</button>
        </div>
      </object>
    </div>
  )
}

// ── Font preview ──────────────────────────────────────────────────────────────
const FONT_SAMPLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789 !@#$%^&*()\nThe quick brown fox jumps over the lazy dog'
function FontPreview({ asset }: { asset: any }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const fontId = `font_preview_${asset.id}`

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
      {!loaded && !error && <div className={styles.centreMsg}>⏳ Loading font…</div>}
      {error && <div className={styles.centreMsg}>⚠️ Could not load font</div>}
      {loaded && (
        <>
          <div className={styles.fontName}>{asset.name}</div>
          {[72,48,32,24,18,14].map(sz => (
            <div key={sz} className={styles.fontSample} style={{ fontFamily: `"${fontId}"`, fontSize: sz }}>
              {sz > 40 ? 'Aa Bb Cc' : sz > 20 ? 'The quick brown fox' : FONT_SAMPLE.split('\n')[3]}
            </div>
          ))}
          <pre className={styles.fontGrid} style={{ fontFamily: `"${fontId}"` }}>{FONT_SAMPLE}</pre>
        </>
      )}
    </div>
  )
}

// ── Audio player ──────────────────────────────────────────────────────────────
function AudioPreview({ asset }: { asset: any }) {
  const fp = asset.filePath.replace(/\\/g, '/')
  return (
    <div className={styles.audioPreview}>
      <div className={styles.audioIcon}>🎵</div>
      <div className={styles.audioName}>{asset.name}.{asset.ext}</div>
      <audio controls autoPlay className={styles.audioPlayer} key={asset.id}>
        <source src={`file://${fp}`} />
      </audio>
    </div>
  )
}

// ── Generic / unsupported ─────────────────────────────────────────────────────
function GenericPreview({ asset }: { asset: any }) {
  const ICONS: Record<string,string> = {
    pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📋', pptx:'📋',
    zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦',
    psd:'🎨', ai:'🎨', fig:'🎨', sketch:'🎨', xd:'🎨', eps:'🎨', afdesign:'🎨',
    blend:'🎲', fbx:'🎲', '3ds':'🎲',
    epub:'📖', mobi:'📖',
  }
  const icon = ICONS[asset.ext] || '📁'
  return (
    <div className={styles.genericPreview}>
      <div className={styles.genericIcon}>{icon}</div>
      <div className={styles.genericExt}>{asset.ext.toUpperCase()}</div>
      <div className={styles.genericName}>{asset.name}.{asset.ext}</div>
      <button className={styles.openExtBtn} onClick={() => (window as any).electronAPI?.openPath(asset.filePath)}>
        Open in external app ↗
      </button>
    </div>
  )
}

// ── Decide which viewer to use ────────────────────────────────────────────────
function PreviewContent({ asset, zoom, pan, dragging, onImgLoad }: any) {
  const fp = asset.filePath.replace(/\\/g, '/')
  const ext = asset.ext.toLowerCase()

  if (isImage(ext)) return (
    <img key={asset.id} src={`file://${fp}`} className={styles.previewImg} alt={asset.name} draggable={false}
      style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transition: dragging?'none':'transform 0.08s' }}
      onLoad={onImgLoad} />
  )
  if (isVideo(ext)) return (
    <video key={asset.id} src={`file://${fp}`} className={styles.previewVideo} controls autoPlay playsInline />
  )
  if (isAudio(ext)) return <AudioPreview asset={asset} />
  if (is3D(ext))    return <Model3DViewer asset={asset} />
  if (ext === 'pdf') return <PdfPreview asset={asset} />
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
  const { lightboxAsset, setLightboxAsset, assets, filteredAssetIds } = useStore()
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x:0, y:0 })
  const [dragging, setDragging] = useState(false)
  const [drag0, setDrag0] = useState({ x:0, y:0, px:0, py:0 })
  const [naturalSz, setNaturalSz] = useState<{w:number;h:number}|null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!lightboxAsset) { setNaturalSz(null); return }
    setZoom(1); setPan({x:0,y:0}); setNaturalSz(null)
  }, [lightboxAsset?.id])

  const goDir = useCallback((dir: 1|-1) => {
    if (!lightboxAsset) return
    const idx = filteredAssetIds.indexOf(lightboxAsset.id)
    const next = assets.find(a => a.id === filteredAssetIds[idx+dir])
    if (next) setLightboxAsset(next)
  }, [lightboxAsset, filteredAssetIds, assets])

  const close = useCallback(() => { setLightboxAsset(null) }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key==='Escape') close(); else if (e.key==='ArrowRight') goDir(1); else if (e.key==='ArrowLeft') goDir(-1) }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [close, goDir])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setZoom(z => Math.max(0.2, Math.min(10, z*(e.deltaY>0?0.88:1.14))))
  }, [])

  if (!lightboxAsset) return null

  const idx = filteredAssetIds.indexOf(lightboxAsset.id)
  const ext = lightboxAsset.ext.toLowerCase()
  const isImg = isImage(ext)
  const is3d  = is3D(ext)
  const isVid = isVideo(ext)
  const isPdf = ext === 'pdf'
  const isTxt = ['txt','md','json','csv','xml','html','css','js','ts','jsx','tsx','py','sh','bash',
                  'yaml','yml','toml','ini','env','rb','go','rs','java','cpp','c','h','php','sql','log'].includes(ext)
  const isFnt = isFont(ext)
  const isAud = isAudio(ext)

  // Size the modal based on content type — #5 FIX: all constrained to viewport
  const VW = window.innerWidth, VH = window.innerHeight
  const MAXW = Math.min(1100, VW * 0.95), MAXH = VH * 0.92, HDRH = 42
  let mW = MAXW, mH = MAXH

  if (isImg) {
    const sw = naturalSz?.w ?? lightboxAsset.width ?? 0
    const sh = naturalSz?.h ?? lightboxAsset.height ?? 0
    if (sw>0 && sh>0) {
      const avH = MAXH - HDRH
      if (sw/sh > MAXW/avH) { mW = Math.min(sw, MAXW); mH = Math.round(mW/(sw/sh)) + HDRH }
      else { mH = Math.min(sh, avH) + HDRH; mW = Math.round((mH-HDRH)*(sw/sh)) }
      mW = Math.max(300, mW); mH = Math.max(200, mH)
    }
  } else if (is3d)  { mW = Math.min(900, MAXW); mH = Math.min(600, MAXH) }
  else if (isPdf)   { mW = Math.min(860, MAXW); mH = MAXH }
  else if (isTxt)   { mW = Math.min(900, MAXW); mH = MAXH }
  else if (isFnt)   { mW = Math.min(700, MAXW); mH = Math.min(580, MAXH) }
  else if (isAud)   { mW = Math.min(420, MAXW); mH = 280 }
  else if (isVid)   { mW = Math.min(900, MAXW); mH = MAXH }
  else              { mW = Math.min(420, MAXW); mH = 300 }

  // Ensure never exceeds viewport
  mW = Math.min(mW, MAXW); mH = Math.min(mH, MAXH)

  const canZoom = isImg
  const contentH = mH - HDRH

  return (
    <div className={styles.overlay} onClick={close}>
      <div className={styles.modal} style={{ width: mW, height: mH }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className={styles.header}>
          <span className={styles.assetName}>{lightboxAsset.name}.{lightboxAsset.ext}</span>
          <div className={styles.hActions}>
            {canZoom && <>
              <button className={styles.hBtn} onClick={() => { setZoom(1); setPan({x:0,y:0}) }}>1:1</button>
              <button className={styles.hBtn} onClick={() => setZoom(z => Math.min(10, z*1.3))}>+</button>
              <span className={styles.zoomLbl}>{Math.round(zoom*100)}%</span>
              <button className={styles.hBtn} onClick={() => setZoom(z => Math.max(0.2, z*0.77))}>−</button>
            </>}
            <button className={styles.hBtn} onClick={() => (window as any).electronAPI?.openPath(lightboxAsset.filePath)} title="Open externally">↗</button>
            <button className={styles.closeBtn} onClick={close}>✕</button>
          </div>
        </div>

        {/* Content */}
        <div className={styles.content}
          onWheel={canZoom ? handleWheel : undefined}
          onMouseDown={canZoom ? (e => { if(e.button!==0) return; setDragging(true); setDrag0({x:e.clientX,y:e.clientY,px:pan.x,py:pan.y}) }) : undefined}
          onMouseMove={canZoom ? (e => { if(!dragging) return; setPan({x:drag0.px+e.clientX-drag0.x,y:drag0.py+e.clientY-drag0.y}) }) : undefined}
          onMouseUp={canZoom ? (() => setDragging(false)) : undefined}
          onMouseLeave={canZoom ? (() => setDragging(false)) : undefined}
          style={{ height: contentH, cursor: canZoom&&zoom>1?(dragging?'grabbing':'grab'):'default' }}>
          <PreviewContent
            asset={lightboxAsset} zoom={zoom} pan={pan} dragging={dragging}
            onImgLoad={(e: any) => { const i=e.currentTarget; setNaturalSz({w:i.naturalWidth,h:i.naturalHeight}) }}
          />
        </div>

        {/* Navigation */}
        {idx>0 && <button className={`${styles.nav} ${styles.prev}`} onClick={e=>{e.stopPropagation();goDir(-1)}}>‹</button>}
        {idx<filteredAssetIds.length-1 && <button className={`${styles.nav} ${styles.next}`} onClick={e=>{e.stopPropagation();goDir(1)}}>›</button>}
        <div className={styles.counter}>{idx+1} / {filteredAssetIds.length}</div>
      </div>
    </div>
  )
}
