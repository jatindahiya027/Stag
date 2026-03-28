# 🦌 Stag — Design Asset Manager

> A pixel-perfect desktop app for organizing, browsing, and managing your design assets — built with **Electron + React + TypeScript**.

Stag is an [Eagle](https://en.eagle.cool/)-inspired design asset manager that runs natively on **Windows 10+**, **macOS 10.15+**, and **Linux**. It stores everything locally — no subscription, no cloud required.

---

## ✨ Features

### Core UI
- Dark theme with fully customizable background and accent colors
- Three-panel layout: **Sidebar** / **Asset Grid** / **Inspector**
- macOS-style traffic light buttons (close / minimize / maximize)
- Custom frameless window with native title bar integration
- Resizable thumbnail grid with a size slider
- Collapsible sidebar and inspector panels
- Toast notification system

### Sidebar
- Library sections: All, Uncategorized, Untagged, All Tags, Trash
- Hierarchical folder tree with expand / collapse
- Folder color icons and asset counts per folder
- Smart Folders with rule-based auto-filtering
- Inline filter bar for quick folder search

### Asset Grid
- Grid, list, and masonry view modes
- Configurable thumbnail size
- File type badge (PSD, JPG, PNG, etc.) with color coding
- Star rating badge on thumbnails
- Multi-select with Ctrl / Cmd + Click
- Drag-and-drop file import from the OS
- Full-text search (name, tags, notes, extension)
- Sort by: date, name, file size, rating
- Filter by rating and file extension

### Inspector Panel
- Asset preview with dominant color extraction
- Color palette swatches (up to 5 dominant colors)
- Inline editable asset name
- Notes textarea
- URL field
- Tag chips (add / remove)
- Folder assignment chips
- 5-star rating (hover + click)
- Full file metadata: dimensions, size, type, import date, modified date
- Export / Show in Finder button

### Supported File Types

| Category | Extensions |
|---|---|
| Images | JPG, JPEG, PNG, GIF, WEBP, BMP, TIFF, ICO, AVIF, HEIC, HEIF, SVG |
| RAW Photos | RAW, CR2, NEF |
| Video | MP4, WEBM, MOV, AVI, MKV, TS, MTS, M2TS, MPG, MPEG, FLV, WMV, M4V, RMVB, 3GP |
| Audio | MP3, WAV, FLAC, AAC, M4A, OGG, OPUS, WMA |
| 3D Models | GLB, GLTF, OBJ, FBX, DAE, STL, BLEND |
| Design | PSD, AI, FIG, SKETCH, XD |
| Documents | PDF |
| Fonts | TTF, OTF, WOFF, WOFF2 |

### Thumbnail Engine
- Background thumbnail generation runs independently of component visibility
- **Images**: base64 data URL via native Electron, compressed to max 600px JPEG at 0.88 quality
- **Videos**: frame extracted at 10% of duration using an off-screen `<video>` element
- **3D models**: rendered via Three.js WebGL in an off-screen canvas (GLB, GLTF, OBJ, STL, DAE, FBX)
- **Audio**: animated waveform placeholder with inline playback toggle
- Concurrency-controlled queues: 2 simultaneous video jobs, 1 WebGL context at a time
- Thumbnails are saved to disk and persist across sessions

### Smart Folders
Smart Folders automatically filter assets based on configurable rules:

| Rule Field | Operators |
|---|---|
| Tags | `contains`, `is empty` |
| Name | `contains` |
| Extension | `is` |
| Rating | `≥` / `≤` |
| Color | `similar` |

Rules can be combined with **ANY** (OR) or **ALL** (AND) logic.

### Persistence
- SQLite-based database via `sql.js` — zero native modules, works on any platform
- Granular IPC operations: insert, update, batch-update, hard-delete
- Thumbnails saved as separate files and referenced by URL
- Settings (theme, library path, performance, AI) persisted across sessions
- Soft-delete / Trash with hard-delete support
- Automatic library path migration

### AI Tagging (Ollama Integration)
- Optional local AI image tagging using [Ollama](https://ollama.ai/)
- Configurable server URL (`http://localhost:11434` by default)
- Model selection (e.g., `llava`, `llava:13b`)
- Generates AI descriptions and tags stored per asset
- Live progress indicator during batch AI tagging

### Appearance Customization
- Custom background color with auto-derived panel shades
- Custom accent color
- Glass/blur effect with adjustable opacity and blur strength
- Theme applied in real-time via CSS custom properties

### File Operations
- Drag-and-drop import from OS
- Multi-file picker dialog
- Folder import (recursive scan)
- Open file in native application (double-click)
- Show in Finder / Explorer
- Multi-file drag-out to OS
- Optional copy-on-import to a managed library folder
- Library folder migration

### Lightbox
- Full-screen asset preview modal
- Keyboard navigation (arrow keys)
- 3D model interactive viewer (orbit, pan, zoom via Three.js)
- Video and audio playback

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Desktop runtime | Electron 28 |
| UI framework | React 18 |
| Language | TypeScript 5 |
| Styling | CSS Modules + CSS custom properties |
| State management | Zustand 4 |
| Build tool | Vite 5 |
| Packaging | electron-builder 24 |
| Database | sql.js 1.12 (SQLite compiled to WASM) |
| 3D rendering | Three.js r128 |
| Image processing | Jimp 1.6 |
| Icons | Lucide React |
| IPC bridge | Electron contextBridge + ipcRenderer |

> **Zero native modules** — no C++ compilation. Works on any Windows, macOS, or Linux setup out of the box.

---

## 📁 Project Structure

```
stag/
├── electron/
│   ├── main.js             # Compiled Electron main process (output)
│   └── preload.js          # Compiled secure IPC bridge (output)
├── src/
│   ├── main/
│   │   ├── main.ts         # Window creation, IPC handlers, DB, file ops
│   │   └── preload.ts      # contextBridge API exposed to renderer
│   └── renderer/
│       ├── components/
│       │   ├── AssetGrid.tsx          # Thumbnail grid with per-type renderers
│       │   ├── Inspector.tsx          # Right-panel metadata + editing
│       │   ├── LightboxModal.tsx      # Full-screen preview + 3D viewer
│       │   ├── MainContent.tsx        # Filtering logic + layout switcher
│       │   ├── SettingsPanel.tsx      # Appearance, library, AI, performance tabs
│       │   ├── Sidebar.tsx            # Folder tree + library navigation
│       │   ├── TitleBar.tsx           # Custom frameless title bar
│       │   ├── Toolbar.tsx            # Search, sort, import, view controls
│       │   └── ToastNotification.tsx  # Transient status messages
│       ├── store/
│       │   └── useStore.ts   # Zustand global state + all actions
│       ├── utils/
│       │   └── helpers.ts    # ID generation, file type utilities, demo data
│       ├── styles/
│       │   ├── global.css    # CSS variables + base theme
│       │   └── App.module.css
│       ├── thumbEngine.ts    # Background thumbnail queue (video + 3D)
│       ├── types.ts          # TypeScript interfaces (Asset, Folder, etc.)
│       ├── App.tsx           # Root component + DB bootstrap
│       ├── main.tsx          # React entry point
│       └── index.html        # HTML shell
├── public/
│   └── icon.png
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.main.json
└── setup.sh
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js 18+** — [Download here](https://nodejs.org)
- **npm** (bundled with Node.js)

Verify your setup:
```bash
node -v   # should print v18.x or higher
npm -v
```

### Quick Setup

A convenience script is provided that checks requirements and installs dependencies:

```bash
chmod +x setup.sh
./setup.sh
```

Or manually:

```bash
npm install
```

### Development

Start both the Vite dev server and Electron in one command:

```bash
npm run dev
```

This runs Vite on `http://localhost:3000` and waits for it to be ready before launching Electron.

To run them in separate terminals:

```bash
# Terminal 1 — Vite renderer
npm run dev:renderer

# Terminal 2 — Electron (after "ready" appears in Terminal 1)
npm run dev:electron
```

### Build for Production

```bash
# Build the renderer (outputs to dist/)
npm run build

# Package as Windows installer (.exe via NSIS)
npm run dist:win

# Package as macOS disk image (.dmg)
npm run dist:mac
```

Built artifacts are placed in the `release/` directory.

| Platform | Output |
|---|---|
| Windows | `release/Stag Setup.exe` (NSIS, x64) |
| macOS | `release/Stag.dmg` (x64 + arm64 universal) |
| Linux | `release/Stag.AppImage` |

---

## ⚙️ Configuration

### Settings Panel

Open via the gear icon in the title bar. Settings are grouped into four tabs:

**Appearance**
- Background color — base color for all panel layers
- Accent color — used for selections, highlights, and interactive elements
- Glass opacity — frosted glass overlay intensity
- Blur strength — backdrop blur radius in pixels

**Library**
- Library folder path — where copies of imported assets are stored
- Move library — relocate your library to a new folder

**Performance**
- Import threads — number of concurrent thumbnail generation workers (1–4)

**AI**
- Enable AI tagging — toggle Ollama-based auto-tagging
- Ollama server URL — defaults to `http://localhost:11434`
- Model — select from detected Ollama models (e.g., `llava`, `llava:13b`)

### Data Storage

Stag stores its library database and thumbnails in the platform-specific user data directory:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\stag\` |
| macOS | `~/Library/Application Support/stag/` |
| Linux | `~/.config/stag/` |

The database file is `library.json` (persisted via `sql.js`). Thumbnails are saved as individual files alongside it.

---

## 🧩 IPC API Reference

The renderer communicates with the main process exclusively through the `window.electronAPI` bridge exposed by `preload.ts`. Available methods:

| Method | Description |
|---|---|
| `minimize()` | Minimize the window |
| `maximize()` | Maximize / restore the window |
| `close()` | Close the window |
| `openFiles()` | Open a multi-file picker dialog |
| `openFolder()` | Open a folder picker dialog |
| `selectDirectory()` | Select a destination directory |
| `getFileInfo(path)` | Get file size and timestamps |
| `readDir(path)` | List directory contents |
| `fileExists(path)` | Check if a path exists |
| `copyFile(src, dest)` | Copy a file |
| `copyFilesToDest(srcs, dest)` | Batch copy files |
| `deleteFile(path)` | Delete a file |
| `readBase64(path)` | Read file as base64 |
| `openPath(path)` | Open in native application |
| `showInFolder(path)` | Reveal in Finder / Explorer |
| `startDrag(path)` | Initiate OS drag-out for one file |
| `startDragMulti(paths)` | Initiate OS drag-out for multiple files |
| `createThumb(path)` | Generate a base64 thumbnail (images only) |
| `hashFile(path)` | MD5 hash a file |
| `dbLoad()` | Load the full library from DB |
| `dbInsertAsset(asset)` | Insert a new asset record |
| `dbUpdateAsset(id, update)` | Update an asset record |
| `dbBatchUpdate(ops)` | Batch update multiple assets |
| `dbSaveThumbnail(id, data)` | Save a thumbnail and get its file URL |
| `dbHardDeleteAssets(ids)` | Permanently delete asset records |
| `dbUpsertFolder(folder)` | Create or update a folder |
| `dbDeleteFolder(id)` | Delete a folder |
| `dbUpsertSmartFolder(sf)` | Create or update a Smart Folder |
| `dbDeleteSmartFolder(id)` | Delete a Smart Folder |
| `dbAddTag(tag)` | Add a global tag |
| `dbDeleteTag(tag)` | Delete a global tag |
| `loadSettings()` | Load app settings |
| `saveSettings(settings)` | Save app settings |
| `getLibraryPath()` | Get current library folder path |
| `moveLibrary(path)` | Move the library to a new path |
| `getVersion()` | Get app version string |
| `getPlatform()` | Get OS platform string |

---

## 🗂️ Data Model

### Asset

```typescript
interface Asset {
  id: string
  name: string
  ext: string
  filePath: string
  thumbnailData?: string    // base64 data URL or file:// URL
  size: number
  width?: number
  height?: number
  duration?: number         // for video/audio
  mtime: number
  btime: number
  importTime: number
  tags: string[]
  folders: string[]
  rating: number            // 0–5
  notes: string
  url: string
  colors: ColorInfo[]       // dominant color palette
  annotation: Annotation[]
  deleted?: boolean         // soft-deleted (in Trash)
  deletedAt?: number
  aiTagged?: boolean
  aiDescription?: string
}
```

### Folder

```typescript
interface Folder {
  id: string
  name: string
  parentId: string | null
  color: string
  icon: string
  autoTags: string[]
  sortOrder: number
}
```

### Smart Folder

```typescript
interface SmartFolder {
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
```

---

## 🗺️ Roadmap

- [ ] Hover preview on thumbnails
- [ ] Spacebar fullscreen preview shortcut
- [ ] Color-based search
- [ ] Find duplicates (pHash)
- [ ] Batch rename
- [ ] Image annotations
- [ ] Password-protected folders
- [ ] Plugin system (JS / HTML)
- [ ] Browser extension for web asset capture
- [ ] Multiple library support
- [ ] Cloud sync (Dropbox / Google Drive)

---

## 📄 License

MIT © 2025 Stag
