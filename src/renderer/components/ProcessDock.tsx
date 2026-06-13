import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import styles from './ProcessDock.module.css'

type ProcessItem = {
  id: string
  label: string
  detail?: string
  count?: string
  percent: number
  color: string
  indeterminate?: boolean
}

function clampPct(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

interface Props {
  sidebarOpen: boolean
  inspectorOpen: boolean
}

export default function ProcessDock({ sidebarOpen, inspectorOpen }: Props) {
  const aiProgress = useStore(s => s.aiProgress)
  const importProgress = useStore(s => s.importProgress)
  const copyProgress = useStore(s => s.copyProgress)
  const aiIndexProgress = useStore(s => s.aiIndexProgress)
  const dinoIndexProgress = useStore(s => s.dinoIndexProgress)
  const aiSearchLoading = useStore(s => s.aiSearchLoading)
  const [thumbProgress, setThumbProgress] = useState<any>(null)
  const [importThumbProgress, setImportThumbProgress] = useState<any>(null)
  const [foregroundProgress, setForegroundProgress] = useState<any>(null)
  const [modelDownloads, setModelDownloads] = useState<Record<string, any>>({})
  const [ollamaPull, setOllamaPull] = useState<any>(null)
  const [runtimeProgress, setRuntimeProgress] = useState<any>(null)

  useEffect(() => {
    const api = (window as any).electronAPI
    const updateThumbProgress = (data: any) => {
      // Variant generation is cache maintenance for the same imported assets.
      // Showing its smaller queues makes the overall import appear to restart.
      if (data?.type === 'variants') return
      if (data?.type === 'import-thumbs') {
        setImportThumbProgress(data)
        return
      }
      if (data?.type === 'done' && data?.scope === 'import-thumbs') {
        setImportThumbProgress(data)
        window.setTimeout(() => {
          setImportThumbProgress((current: any) => current === data ? null : current)
        }, 1200)
        return
      }
      setThumbProgress(data)
      if (data?.type === 'done' || data?.type === 'error') {
        window.setTimeout(() => {
          setThumbProgress((current: any) => current === data ? null : current)
        }, 1200)
      }
    }
    const offThumbProgress = api?.onThumbProgress?.(updateThumbProgress)
    const offModelDownload = api?.onAiModelDownloadProgress?.((data: any) => {
      setModelDownloads(current => {
        if (['done', 'error', 'cancelled'].includes(data.type)) {
          const next = { ...current }
          delete next[data.feature]
          return next
        }
        return { ...current, [data.feature]: data }
      })
    })
    const offOllamaPull = api?.onOllamaModelPullProgress?.((data: any) => {
      setOllamaPull(['done', 'error', 'cancelled'].includes(data.status) ? null : data)
    })
    api?.getRuntimeStatus?.().then((data: any) => {
      if (data?.type !== 'done' && data?.type !== 'pending') setRuntimeProgress(data)
    }).catch(() => {})
    const offRuntime = api?.onRuntimeProgress?.((data: any) => {
      setRuntimeProgress(data)
      if (data?.type === 'done') {
        window.setTimeout(() => setRuntimeProgress((current: any) => current === data ? null : current), 3000)
      }
    })
    const onRendererThumbProgress = (event: Event) => {
      updateThumbProgress((event as CustomEvent).detail)
    }
    window.addEventListener('stag:thumbProgress', onRendererThumbProgress)
    const onForegroundProgress = (event: Event) => {
      setForegroundProgress((event as CustomEvent).detail || null)
    }
    window.addEventListener('stag:foregroundProgress', onForegroundProgress)
    return () => {
      offThumbProgress?.()
      offModelDownload?.()
      offOllamaPull?.()
      offRuntime?.()
      window.removeEventListener('stag:thumbProgress', onRendererThumbProgress)
      window.removeEventListener('stag:foregroundProgress', onForegroundProgress)
    }
  }, [])

  const processItems: ProcessItem[] = []
  if (runtimeProgress && !['done', 'core_ready', 'pending'].includes(runtimeProgress.type)) {
    const total = Number(runtimeProgress.bytesTotal || 0)
    const done = Number(runtimeProgress.bytesDone || 0)
    processItems.push({
      id: 'runtime-install',
      label: runtimeProgress.label || 'Installing application dependencies',
      detail: runtimeProgress.error || runtimeProgress.detail,
      count: total > 0 ? `${Math.round(done / 1048576)}/${Math.round(total / 1048576)} MB` : undefined,
      percent: total > 0 ? clampPct((done / total) * 100) : 30,
      color: runtimeProgress.type === 'error' ? '#e05252' : '#61e294',
      indeterminate: total <= 0 && runtimeProgress.type !== 'error',
    })
  }
  Object.values(modelDownloads).forEach((download: any) => {
    const total = Number(download.bytesTotal || 0)
    const done = Number(download.bytesDone || 0)
    processItems.push({
      id: `model-${download.feature}`,
      label: `Downloading ${download.feature === 'dinov3' ? 'DINOv3' : 'TIPSv2'} model`,
      detail: download.file,
      count: total > 0 ? `${Math.round(done / 1048576)}/${Math.round(total / 1048576)} MB` : undefined,
      percent: total > 0 ? clampPct((done / total) * 100) : 30,
      color: download.feature === 'dinov3' ? '#8b7cff' : 'var(--accent)',
      indeterminate: total <= 0,
    })
  })
  if (ollamaPull) {
    const total = Number(ollamaPull.total || 0)
    const done = Number(ollamaPull.completed || 0)
    processItems.push({
      id: 'ollama-model',
      label: 'Downloading Ollama model',
      detail: ollamaPull.model,
      percent: total > 0 ? clampPct((done / total) * 100) : 30,
      color: 'var(--accent)',
      indeterminate: total <= 0,
    })
  }
  const importThumbActive = !!importThumbProgress &&
    !(importThumbProgress.type === 'done' && importThumbProgress.scope === 'import-thumbs')
  const thumbActive = !!thumbProgress && thumbProgress.type !== 'done' && thumbProgress.type !== 'error'
  const aiEmbeddingActive = !!aiIndexProgress && aiIndexProgress.type !== 'done' && aiIndexProgress.type !== 'error'
  const dinoIndexActive = !!dinoIndexProgress &&
    dinoIndexProgress.type !== 'done' &&
    dinoIndexProgress.type !== 'error' &&
    dinoIndexProgress.type !== 'cancelled' &&
    dinoIndexProgress.type !== 'model_ready'

  if (foregroundProgress) {
    processItems.push({
      id: foregroundProgress.id || 'foreground',
      label: foregroundProgress.label || 'Processing',
      detail: foregroundProgress.detail,
      percent: foregroundProgress.percent ?? 30,
      color: foregroundProgress.color || 'var(--accent)',
      indeterminate: foregroundProgress.indeterminate !== false,
    })
  }

  if (copyProgress) {
    const percent = copyProgress.bytesTotal > 0
      ? clampPct((copyProgress.bytesDone / Math.max(1, copyProgress.bytesTotal)) * 100)
      : clampPct((copyProgress.fileIndex / Math.max(1, copyProgress.total)) * 100)
    processItems.push({
      id: 'copy',
      label: 'Asset copy',
      detail: copyProgress.fileName,
      count: `${copyProgress.fileIndex}/${copyProgress.total}`,
      percent,
      color: '#4fc3f7',
    })
  }

  if (importProgress) {
    processItems.push({
      id: 'import',
      label: 'Asset import',
      detail: importProgress.currentName,
      count: `${importProgress.current}/${importProgress.total}`,
      percent: clampPct((importProgress.current / Math.max(1, importProgress.total)) * 100),
      color: '#ffd93d',
    })
  }

  if (importThumbActive) {
    const current = importThumbProgress.current ?? 0
    const total = importThumbProgress.total ?? 0
    processItems.push({
      id: 'import-thumbs',
      label: 'Preparing previews',
      detail: importThumbProgress.file,
      count: total > 0 ? `${current}/${total}` : undefined,
      percent: total > 0 ? clampPct((current / Math.max(1, total)) * 100) : 30,
      color: '#61e294',
      indeterminate: total <= 0,
    })
  } else if (thumbActive) {
    const current = thumbProgress.current ?? 0
    const total = thumbProgress.total ?? 0
    processItems.push({
      id: 'thumbs',
      label: thumbProgress.type === 'variants' ? 'Thumbnail variants' : 'Thumbnail generation',
      detail: thumbProgress.file,
      count: total > 0 ? `${current}/${total}` : undefined,
      percent: total > 0 ? clampPct((current / Math.max(1, total)) * 100) : 30,
      color: '#61e294',
      indeterminate: total <= 0,
    })
  }

  if (aiProgress?.active) {
    processItems.push({
      id: 'ai-tags',
      label: 'AI tagging',
      detail: aiProgress.current,
      count: `${aiProgress.done}/${aiProgress.total}`,
      percent: clampPct((aiProgress.done / Math.max(1, aiProgress.total)) * 100),
      color: 'var(--accent)',
    })
  }

  if (aiEmbeddingActive) {
    const current = aiIndexProgress.current ?? 0
    const total = aiIndexProgress.total ?? 0
    processItems.push({
      id: 'ai-embed',
      label: aiIndexProgress.type === 'converting'
        ? 'AI source prep'
        : aiIndexProgress.type === 'model_loading'
          ? 'Loading AI model'
          : 'AI embedding',
      detail: aiIndexProgress.file,
      count: total > 0 ? `${current}/${total}` : undefined,
      percent: total > 0 ? clampPct((current / Math.max(1, total)) * 100) : 30,
      color: 'var(--accent)',
      indeterminate: total <= 0,
    })
  }

  if (dinoIndexActive) {
    const current = dinoIndexProgress.current ?? 0
    const total = dinoIndexProgress.total ?? 0
    const label = dinoIndexProgress.type === 'staging'
      ? 'Preparing DINOv3 images'
      : dinoIndexProgress.type === 'model_loading'
        ? 'Loading DINOv3'
        : 'DINOv3 image index'
    processItems.push({
      id: 'dino-index',
      label,
      detail: dinoIndexProgress.file,
      count: total > 0 ? `${current}/${total}` : undefined,
      percent: total > 0 ? clampPct((current / Math.max(1, total)) * 100) : 30,
      color: '#8b7cff',
      indeterminate: total <= 0,
    })
  }

  if (aiSearchLoading) {
    processItems.push({
      id: 'ai-search',
      label: 'AI search',
      percent: 30,
      color: 'var(--accent)',
      indeterminate: true,
    })
  }

  if (processItems.length === 0) return null

  return (
    <div
      className={styles.dock}
      style={{
        left: sidebarOpen ? 'var(--sidebar-width)' : 0,
        right: inspectorOpen ? 'var(--inspector-width)' : 0,
      }}
      role="status"
      aria-live="polite"
      aria-label="Running processes"
    >
      {processItems.map(item => (
        <div className={styles.item} key={item.id}>
          <div className={styles.meta}>
            <span className={styles.name} style={{ color: item.color }}>{item.label}</span>
            {item.detail && <span className={styles.detail}>{item.detail}</span>}
            {item.count && <span className={styles.count}>{item.count}</span>}
          </div>
          <div className={styles.track}>
            <div
              className={`${styles.fill} ${item.indeterminate ? styles.indeterminate : ''}`}
              style={{ width: `${Math.max(item.percent, 3)}%`, background: item.color }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
