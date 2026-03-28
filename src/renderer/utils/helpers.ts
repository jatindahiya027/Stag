export function generateId(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36)
}

export function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

export function formatDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function getFileExt(name: string): string {
  return (name.split('.').pop() || '').toLowerCase()
}

export function isImage(ext: string): boolean {
  return ['jpg','jpeg','png','gif','webp','svg','bmp','tiff','tif','ico','avif','heic','heif','raw','cr2','nef'].includes(ext)
}

export function isVideo(ext: string): boolean {
  return ['mp4','webm','mov','avi','mkv','m4v','ogv','flv','wmv','3gp',
          'ts','mts','m2ts','m2v','mpg','mpeg','mp2','mpe','mpv',
          'rm','rmvb','vob','divx','asf','f4v','h264','hevc'].includes(ext)
}

export function isAudio(ext: string): boolean {
  return ['mp3','wav','flac','aac','m4a','ogg','opus','wma','aiff'].includes(ext)
}

export function isFont(ext: string): boolean {
  return ['ttf','otf','woff','woff2','eot'].includes(ext)
}

export function is3D(ext: string): boolean {
  return ['glb','gltf','obj','fbx','stl','dae','3ds','ply','usdz'].includes(ext)
}

export function isDoc(ext: string): boolean {
  return ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md'].includes(ext)
}

export function isDesign(ext: string): boolean {
  return ['psd','ai','xd','fig','sketch','eps','afdesign','afphoto'].includes(ext)
}

export function getFileCategory(ext: string): string {
  if (isImage(ext)) return 'image'
  if (isVideo(ext)) return 'video'
  if (isAudio(ext)) return 'audio'
  if (is3D(ext))    return '3d'
  if (isFont(ext))  return 'font'
  if (isDesign(ext))return 'design'
  if (isDoc(ext))   return 'doc'
  return 'file'
}

export function getDefaultTags(ext: string): string[] {
  if (isImage(ext))  return []
  if (isVideo(ext))  return ['Video']
  if (isAudio(ext))  return ['Audio']
  if (is3D(ext))     return ['3D', ext.toUpperCase()]
  if (isFont(ext))   return ['Font', 'Typography']
  if (isDesign(ext)) return ['Design', ext.toUpperCase()]
  if (ext === 'pdf') return ['PDF', 'Document']
  if (ext === 'glb' || ext === 'gltf') return ['3D', 'GLTF']
  if (ext === 'obj') return ['3D', 'OBJ']
  if (ext === 'fbx') return ['3D', 'FBX']
  return []
}

export function getExtBadgeColor(ext: string): string {
  const map: Record<string, string> = {
    jpg:'#4a9eff', jpeg:'#4a9eff', png:'#52c078', gif:'#f5a623', webp:'#9b59b6',
    svg:'#e74c3c', pdf:'#e05252', psd:'#31a8ff', ai:'#ff9a00',
    mp4:'#ff6b6b', mov:'#ff6b6b', mkv:'#ff6b6b', webm:'#ff6b6b', avi:'#ff6b6b',
    mp3:'#4d96ff', wav:'#4d96ff', flac:'#4d96ff', aac:'#4d96ff', m4a:'#4d96ff',
    ttf:'#6bcb77', otf:'#6bcb77', woff:'#6bcb77', woff2:'#6bcb77',
    glb:'#ff922b', gltf:'#ff922b', obj:'#ff922b', fbx:'#ff922b', stl:'#ff922b',
    fig:'#a259ff', sketch:'#faa41a', xd:'#ff61f6',
  }
  return map[ext] || '#5c6370'
}

export function getTypeIcon(ext: string): string {
  const cat = getFileCategory(ext)
  const icons: Record<string, string> = {
    image: '🖼', video: '🎬', audio: '🎵', '3d': '📦',
    font: '🔤', design: '🎨', doc: '📄', file: '📁',
  }
  return icons[cat] || '📁'
}

// ── Color extraction ──────────────────────────────────────────────────────────
export function extractColorsFromImg(img: HTMLImageElement): string[] {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 50; canvas.height = 50
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, 50, 50)
    const data = ctx.getImageData(0, 0, 50, 50).data
    const buckets: Record<string, { r: number; g: number; b: number; n: number }> = {}
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3]
      if (a < 128) continue
      const r = Math.round(data[i] / 32) * 32
      const g = Math.round(data[i + 1] / 32) * 32
      const b = Math.round(data[i + 2] / 32) * 32
      const k = `${r},${g},${b}`
      if (!buckets[k]) buckets[k] = { r, g, b, n: 0 }
      buckets[k].n++
    }
    return Object.values(buckets)
      .sort((a, b) => b.n - a.n)
      .slice(0, 5)
      .map(v => '#' + [v.r, v.g, v.b].map(n => n.toString(16).padStart(2, '0')).join(''))
  } catch { return [] }
}

// Compress image to small thumbnail data URL
export function compressImageToThumb(src: string, maxW = 400, maxH = 400): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const ratio = Math.min(maxW / img.width, maxH / img.height, 1)
      const w = Math.round(img.width * ratio)
      const h = Math.round(img.height * ratio)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, w, h)
      resolve({ dataUrl: canvas.toDataURL('image/webp', 0.75), w: img.width, h: img.height })
    }
    img.onerror = () => resolve({ dataUrl: src, w: 0, h: 0 })
    img.src = src
  })
}

export function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2,'0')}`
}

// Aliases used by Inspector and store
export const extractColors = extractColorsFromImg

export function rgbToHex(rgb: string): string {
  // Already a hex string (from extractColorsFromImg which returns hex directly)
  if (rgb.startsWith('#')) return rgb
  const m = rgb.match(/\d+/g)
  if (!m || m.length < 3) return rgb
  return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('')
}
