import { Asset } from '../types'

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  zip: 'application/zip',
}

function assetFileName(asset: Asset) {
  return `${asset.name}.${asset.ext}`
}

function mimeForAsset(asset: Asset) {
  return MIME_BY_EXT[asset.ext.toLowerCase()] || 'application/octet-stream'
}

function base64ToBytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function copyPathsFallback(assets: Asset[], showToast?: (message: string, type?: any, duration?: number) => void) {
  const paths = assets.map(a => a.filePath).join('\n')
  await navigator.clipboard?.writeText(paths).catch(() => {})
  showToast?.(
    assets.length === 1
      ? 'Sharing is unavailable here; copied file path'
      : 'Sharing is unavailable here; copied file paths',
    'info',
    5000,
  )
}

export async function shareAssets(
  assets: Asset[],
  showToast?: (message: string, type?: any, duration?: number) => void,
) {
  const shareTargets = assets.filter(a => a?.filePath)
  if (!shareTargets.length) return

  const api = (window as any).electronAPI
  const nativeResult = await api?.shareFiles?.(shareTargets.map(a => a.filePath)).catch(() => null)
  if (nativeResult?.ok) return

  const shareApi = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
    share?: (data: ShareData) => Promise<void>
  }

  if (!shareApi.share || typeof File === 'undefined') {
    await copyPathsFallback(shareTargets, showToast)
    return
  }

  try {
    const files = await Promise.all(shareTargets.map(async asset => {
      const base64 = await api?.readBinary?.(asset.filePath)
      if (!base64) throw new Error(`Could not read ${assetFileName(asset)}`)
      return new File([base64ToBytes(base64)], assetFileName(asset), { type: mimeForAsset(asset) })
    }))

    const payload: ShareData = {
      files,
      title: shareTargets.length === 1 ? assetFileName(shareTargets[0]) : `${shareTargets.length} Stag files`,
    }
    if (shareApi.canShare && !shareApi.canShare(payload)) {
      await copyPathsFallback(shareTargets, showToast)
      return
    }

    await shareApi.share(payload)
  } catch (error: any) {
    if (error?.name === 'AbortError') return
    showToast?.(error?.message || 'Could not share selected files', 'error', 5000)
  }
}
