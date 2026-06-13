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

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  return target.isContentEditable || !!target.closest('[contenteditable="true"]')
}

export function isImage(ext: string): boolean {
  return ['jpg','jpeg','jpe','jfif','png','gif','webp','svg','bmp',
          'tiff','tif','ico','avif','heic','heif','hif',
          'icns','tga','dds','eps','tgs',
          'raw','cr2','nef'].includes(ext)
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

// ── Color extraction ──────────────────────────────────────────────────────────
function extractColorsFromImg(img: HTMLImageElement): string[] {
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

export function extractPaletteFromImageSrc(src: string): Promise<{ hex: string; ratio: number }[]> {
  return new Promise(resolve => {
    if (!src) { resolve([]); return }
    const img = new Image()
    img.onload = () => {
      const colors = extractColorsFromImg(img)
      resolve(colors.map((hex, i) => ({ hex: rgbToHex(hex), ratio: [0.35, 0.25, 0.2, 0.12, 0.08][i] || 0.05 })))
    }
    img.onerror = () => resolve([])
    img.src = src
  })
}

const paletteJobs = new Set<string>()

export async function extractPaletteOnceForAsset(
  assetId: string,
  src: string | undefined,
  existingColors: { hex: string; ratio: number }[] | undefined,
  save: (colors: { hex: string; ratio: number }[]) => void | Promise<void>
) {
  if (!assetId || !src || existingColors?.length || paletteJobs.has(assetId)) return
  paletteJobs.add(assetId)
  try {
    const colors = await extractPaletteFromImageSrc(src)
    if (colors.length) await save(colors)
  } finally {
    paletteJobs.delete(assetId)
  }
}

// Compress image to a high-quality thumbnail data URL
function rgbToHex(rgb: string): string {
  // Already a hex string (from extractColorsFromImg which returns hex directly)
  if (rgb.startsWith('#')) return rgb
  const m = rgb.match(/\d+/g)
  if (!m || m.length < 3) return rgb
  return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('')
}
