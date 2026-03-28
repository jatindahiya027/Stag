export interface Asset {
  id: string
  name: string
  ext: string
  filePath: string
  thumbnailData?: string   // base64 data URL or file:// URL (compressed thumbnail)
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
}

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

export interface ColorInfo {
  hex: string
  ratio: number
}

export interface Annotation {
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

export interface SmartRule {
  field: 'tags' | 'name' | 'ext' | 'rating' | 'color'
  operator: 'contains' | 'is' | 'gte' | 'lte' | 'similar'
  value: string | number
}

export type ViewMode = 'grid' | 'list' | 'masonry'

export interface ImportProgress {
  total: number
  current: number
  currentName: string
  done: boolean
}

export interface AppSettings {
  libraryPath: string
  threads: number
  bgColor: string
  accentColor: string
}
