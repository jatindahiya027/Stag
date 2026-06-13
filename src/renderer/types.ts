export interface Asset {
  id: string
  name: string
  ext: string
  filePath: string
  thumbnailData?: string   // base64 data URL or file:// URL (full compressed thumbnail)
  thumbnailVariants?: {
    sm?: string            // small grid thumbnail
    md?: string            // medium grid thumbnail
    lg?: string            // large/retina grid thumbnail
  }
  size: number
  width?: number
  height?: number
  duration?: number
  mtime: number
  btime: number
  importTime: number
  tags: string[]
  folders: string[]
  rating: number
  notes: string
  url: string
  colors: ColorInfo[]
  annotation: Annotation[]
  deleted?: boolean        // soft-delete (trash)
  deletedAt?: number
  aiTagged?: boolean       // has AI description/tags been generated?
  aiDescription?: string   // AI-generated description
  aiEmbedded?: boolean     // has TIPSv2 embedding been indexed for AI search?
}

export type SearchField = 'name' | 'description' | 'extension' | 'tag'

export interface AiSettings {
  enabled: boolean
  ollamaUrl: string        // default: http://localhost:11434
  model: string            // e.g. "llava", "llava:13b"
}

export interface AiProgress {
  total: number
  done: number
  current: string          // filename being processed
  active: boolean
}

export interface AiFeatureStatus {
  tipsv2: {
    repoId: string
    installed: boolean
    downloading: boolean
    enabled: boolean
    hasIndex: boolean
    indexPath: string
  }
  dinov3: {
    repoId: string
    installed: boolean
    downloading: boolean
    enabled: boolean
    hasIndex: boolean
    indexPath: string
  }
  tagging: {
    enabled: boolean
    ollamaUrl: string
    model: string
    active?: boolean
    models?: string[]
  }
}

interface ColorInfo {
  hex: string
  ratio: number
}

interface Annotation {
  id: string
  x: number
  y: number
  label: string
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  color: string
  icon: string
  autoTags: string[]
  sortOrder: number
}

export interface SmartFolder {
  id: string
  name: string
  rules: SmartRule[]
  logic: 'ANY' | 'ALL'
}

interface SmartRule {
  field: 'tags' | 'name' | 'ext' | 'rating' | 'color'
  operator: 'contains' | 'is' | 'gte' | 'lte' | 'similar'
  value: string | number
}

export type ViewMode = 'masonry' | 'justified' | 'grid' | 'list'

export interface ImportProgress {
  jobId?: string
  status?: 'queued' | 'running' | 'completed' | 'failed'
  total: number
  current: number
  currentName: string
  done: boolean
}

export interface CopyProgress {
  jobId?: string
  status?: 'queued' | 'running' | 'completed' | 'failed'
  fileIndex: number   // how many files fully copied
  total: number       // total files to copy
  fileName: string    // current file being copied
  bytesDone: number   // bytes copied for current file
  bytesTotal: number  // size of current file
}
