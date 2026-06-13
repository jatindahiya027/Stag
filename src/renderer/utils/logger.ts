type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

function countText(count: number | undefined, single: string, plural = `${single}s`) {
  const n = Number(count ?? 0)
  return `${n} ${n === 1 ? single : plural}`
}

function fileNameFromPath(path: any) {
  if (typeof path !== 'string') return ''
  const clean = path.replace(/\\/g, '/')
  return clean.split('/').filter(Boolean).pop() || path
}

function itemLabel(item: any) {
  if (!item) return ''
  const name = item.displayName || item.fileName || item.filename || item.name
  const ext = item.ext ? `.${item.ext}` : ''
  if (name) return `${name}${ext && !String(name).endsWith(ext) ? ext : ''}`
  return fileNameFromPath(item.filePath || item.path || item.src || item.dest || item.id)
}

function itemList(items: any, max = 4) {
  if (!Array.isArray(items) || items.length === 0) return ''
  const names = items.map(itemLabel).filter(Boolean)
  if (!names.length) return ''
  const shown = names.slice(0, max).join(', ')
  return names.length > max ? `${shown}, and ${names.length - max} more` : shown
}

function readableEventName(event: string) {
  return event
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

function buildReadableMessage(event: string, data?: any) {
  const count = data?.count ?? data?.imported ?? data?.resultCount ?? data?.processed
  const copiedCount = data?.copiedCount ?? data?.successCount
  const failedCount = data?.failedCount
  const names = itemList(data?.assets || data?.files || data?.items || data?.targets || data?.results)
  const suffix = names ? `: ${names}` : ''

  switch (event) {
    case 'import.start':
      return `Import started for ${countText(data?.count, 'file')}${suffix}`
    case 'import.skipped_all_existing':
      return `Import skipped because all ${countText(data?.count, 'file')} already exist`
    case 'import.settings_loaded':
      return data?.copyEnabled
        ? `Import settings loaded: copy-on-import is ON, destination is ${data?.copyPath || 'not set'}`
        : `Import settings loaded: copy-on-import is OFF`
    case 'import.copy_on_import.start':
      return `Copy started for ${countText(data?.count, 'file')} to ${data?.dest || 'library folder'}${suffix}`
    case 'import.copy_on_import.done':
      if (data?.ok === false) return `Copy failed: ${data?.reason || 'unknown reason'}`
      if (failedCount) return `Copy finished with ${countText(copiedCount, 'success', 'successes')} and ${countText(failedCount, 'failure')}${suffix}`
      return `Copy finished successfully for ${countText(copiedCount ?? data?.resultCount, 'file')}${suffix}`
    case 'import.batch.inserted':
      return `Added ${countText(data?.count, 'asset')} to the library database${suffix}`
    case 'import.thumbs.batch.done':
      return `Generated thumbnails for ${data?.returned ?? 0} of ${data?.requested ?? 0} requested files`
    case 'import.thumbs.background_queued':
      return `Queued background thumbnail generation for ${countText(data?.count, 'file')}${suffix}`
    case 'import.done':
      return `Import completed: ${countText(data?.imported, 'file')} added${data?.copied ? ' and copied to library' : ''}${suffix}`
    case 'asset.trash':
      return `Moved ${countText(data?.count, 'item')} to trash${suffix}`
    case 'asset.permanent_delete.prompt':
      return `Asked user how to permanently delete ${countText(data?.count, 'item')}${suffix}`
    case 'asset.permanent_delete.cancelled':
      return `User cancelled permanent delete${suffix}`
    case 'asset.permanent_delete.from_disk':
      return `Permanently deleted ${countText(data?.count, 'file')} from disk and library${suffix}`
    case 'asset.permanent_delete.db_only':
    case 'asset.remove_from_library':
      return `Removed ${countText(data?.count, 'item')} from Stag only; files were kept on disk${suffix}`
    case 'asset.restore':
      return `Restored ${countText(data?.count, 'item')} from trash${suffix}`
    case 'asset.permanent_delete.legacy':
      return `Permanently deleted ${countText(data?.count, 'item')} from library${suffix}`
    case 'asset.update':
      return `Updated asset ${itemLabel(data?.asset) || data?.id || ''}`.trim()
    case 'folder.add':
      return `Folder created: ${data?.folder?.name || data?.name || data?.id || 'unknown'}`
    case 'folder.update':
      return `Folder updated: ${data?.folder?.name || data?.name || data?.id || 'unknown'}`
    case 'folder.delete':
      return `Folder deleted: ${data?.folder?.name || data?.id || 'unknown'}`
    case 'tag.add':
      return `Tag created: ${data?.tag || 'unknown'}`
    case 'tag.delete':
      return `Tag deleted: ${data?.tag || 'unknown'}`
    case 'tag.delete_all':
      return `All tags deleted from Stag; files were not deleted`
    case 'ai.queue.start_requested':
      return `AI tagging requested for ${countText(data?.count, 'image')}${suffix}`
    case 'ai.queue.started':
      return `AI tagging queue started with ${countText(data?.pending, 'image')} using ${data?.model || 'selected model'}`
    case 'ai.queue.appended':
      return `Added ${countText(data?.appended, 'image')} to the running AI queue; ${data?.pending ?? 0} pending`
    case 'ai.queue.processing':
      return `AI tagging started for ${itemLabel(data)}; ${data?.remaining ?? 0} remaining`
    case 'ai.queue.asset_tagged':
      return `AI tagging completed for ${itemLabel(data)} with tags: ${(data?.tags || []).join(', ') || 'none'}`
    case 'ai.queue.asset_failed':
      return `AI tagging failed for ${itemLabel(data)}: ${data?.error || 'unknown error'}`
    case 'ai.queue.complete':
      return `AI tagging queue completed after ${countText(data?.processed, 'image')}`
    case 'settings.save.start':
      return `Settings save started`
    case 'settings.save.done':
      return `Settings saved`
    default:
      return `${readableEventName(event)}${count !== undefined ? ` (${count})` : ''}${suffix}`
  }
}

function summarize(value: any, depth = 0): any {
  if (value == null) return value
  if (depth > 2) return '[depth-limit]'
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (Array.isArray(value)) {
    const shown = value.slice(0, 20).map(v => summarize(v, depth + 1))
    if (value.length > shown.length) shown.push(`... ${value.length - shown.length} more`)
    return shown
  }
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return `[data-url ${value.length} chars]`
    if (value.length > 500) return value.slice(0, 500) + `... [${value.length} chars]`
    return value
  }
  if (typeof value !== 'object') return value
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(value)) {
    if (/thumbnailData|dataUrl|base64|image|buffer/i.test(k)) {
      out[k] = typeof v === 'string' ? `[${k} ${v.length} chars]` : summarize(v, depth + 1)
      continue
    }
    out[k] = summarize(v, depth + 1)
  }
  return out
}

function send(level: LogLevel, module: string, event: string, data?: any, message?: string) {
  try {
    const readableMessage = message || buildReadableMessage(event, data)
    ;(window as any).electronAPI?.log?.({
      level,
      module,
      event,
      data: summarize(data),
      message: readableMessage,
      time: new Date().toISOString(),
    }).catch?.(() => {})
  } catch {}
}

export function createRendererLogger(module: string) {
  return {
    trace: (event: string, data?: any, message?: string) => send('trace', module, event, data, message),
    debug: (event: string, data?: any, message?: string) => send('debug', module, event, data, message),
    info:  (event: string, data?: any, message?: string) => send('info', module, event, data, message),
    warn:  (event: string, data?: any, message?: string) => send('warn', module, event, data, message),
    error: (event: string, data?: any, message?: string) => send('error', module, event, data, message),
    fatal: (event: string, data?: any, message?: string) => send('fatal', module, event, data, message),
  }
}
