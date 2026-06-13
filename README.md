# Stag

Stag is a local-first desktop asset manager for organizing, previewing, searching, and enriching creative files. It is built with Electron, React, TypeScript, Zustand, Vite, SQLite, and optional local AI services.

Stag keeps the library database, thumbnails, settings, downloaded runtimes, and AI indexes on the user's computer. It does not require a hosted Stag backend.

## Capabilities

- Import local files by picker or drag and drop.
- Optionally copy imported files into a managed library folder.
- Capture websites and receive files from compatible web-grab integrations.
- Generate thumbnails for images, documents, video, 3D files, fonts, and design formats.
- Preview images, video, audio, PDF, EPUB, text, fonts, websites, and 3D models.
- Organize assets with nested folders, tags, ratings, notes, colors, and annotations.
- Search names, descriptions, extensions, and tags using SQLite FTS and filters.
- Browse masonry, justified, grid, and list layouts.
- Use Trash, Recently Used, Random, Uncategorized, Untagged, and smart folders.
- Hide assets carrying configured sensitive tags.
- Run local Ollama auto-tagging.
- Run TIPSv2 text-to-image search and DINOv3 image-similarity search.
- Download Stag's private Python and media runtime during first-run onboarding.

See [Feature Guide](docs/FEATURES.md) for the complete user-facing behavior.

## Technology

| Area | Implementation |
| --- | --- |
| Desktop shell | Electron 41 |
| Renderer | React 19 + TypeScript 6 + Vite 8 |
| State | Zustand |
| Database | `better-sqlite3`, WAL mode, FTS5 |
| Images | Sharp, ImageMagick, Ghostscript, Poppler |
| Video | FFmpeg, FFprobe, Chromium, `mpegts.js` |
| 3D | Three.js loaded by the preview runtime |
| AI search | Python, PyTorch, Transformers, FAISS |
| AI tagging | Ollama HTTP API |
| Packaging | electron-builder |
| Logging | Pino with rotating files |

## Developer Setup

### Requirements

- Node.js 22 LTS or newer.
- npm.
- Git.
- Python 3 only for the repository's Python unit test. The running app downloads and uses its own private Python runtime.
- macOS or Windows for supported desktop builds.

On Windows, install Visual Studio Build Tools with the Desktop development with C++ workload if a native prebuild is unavailable. On macOS, install Xcode Command Line Tools.

### Install

```bash
git clone <repository-url>
cd "Stag App"
npm ci
```

`npm ci` is the supported install command. It uses `package-lock.json`, runs `electron-builder install-app-deps`, and aligns native modules such as `better-sqlite3` with the exact Electron ABI.

The included helper performs the same setup on macOS/Linux:

```bash
./setup.sh
```

Do not replace `npm ci` with a broad dependency upgrade. Electron and `better-sqlite3` are deliberately exact-pinned and verified together.

### Run

```bash
npm run dev
```

This starts Vite on port 3000 and launches Electron after the renderer is reachable.

For separate terminals:

```bash
npm run dev:renderer
npm run dev:electron
```

### Verify

```bash
npm test
```

The full suite runs:

- strict TypeScript and dead-code/IPC audits;
- AI contracts and task coordinator tests;
- layout contracts;
- media orientation, F4V, and recent-item tests;
- Python runtime contracts;
- native dependency and Electron SQLite tests.

Useful focused commands:

```bash
npm run test:code
npm run test:ai
npm run test:layout
npm run test:media
npm run test:python
npm run test:native
npm run electron:rebuild
```

## First Run

On a fresh install Stag shows:

1. Welcome.
2. Theme selection.
3. Dependency requirement and internet check.
4. Runtime installation.
5. The main library.

The private runtime contains Python, FFmpeg, FFprobe, ImageMagick, Ghostscript, and AI Python packages. Downloads use `.part` files and readiness markers. If installation is interrupted, the next launch returns to installation and validates the actual files before opening the library.

Runtime locations:

| Platform | Default location |
| --- | --- |
| macOS | `~/.stag/runtime` |
| macOS home path containing spaces | `/Users/Shared/StagRuntime-<uid>` |
| Windows | `%APPDATA%\Stag\runtime` |

The tools are not added permanently to the user's system `PATH`. Stag supplies private executable paths and a process-local environment whenever it invokes them.

## Data Locations

The default library is inside Electron's user-data directory:

| Platform | Default library |
| --- | --- |
| macOS | `~/Library/Application Support/Stag/stag-library` |
| Windows | `%APPDATA%\Stag\stag-library` |

Important contents:

```text
stag-library/
|-- library.db
|-- library.db-wal
|-- library.db-shm
|-- startup-cache.json
|-- thumbs/
`-- ai-index/
```

Settings and logs live in Electron's Stag user-data folder. The default managed import folders are `Pictures/Stag/LocalGrab` and `Pictures/Stag/WebGrab`.

Uninstalling the application binary does not automatically delete the library or private runtime. This protects user data across upgrades and reinstalls.

## Build

Build the renderer:

```bash
npm run build
```

Create platform installers:

```bash
npm run dist:mac:arm64
npm run dist:mac:x64
npm run dist:win:x64
npm run dist:win:arm64
```

Each distribution command:

1. prepares native dependencies for the requested Electron target;
2. prepares the matching Poppler runtime;
3. builds the renderer;
4. packages with electron-builder;
5. validates packaged native binaries after packing.

Every release must use a new semantic version. Windows installers use
electron-builder's standard NSIS extraction flow and its supported
always-recreate desktop shortcut option. The ARM64 include replaces only the
unreliable 32-bit NSIS host-architecture probe before electron-builder defines
its payload-selection macros. The replacement reads the machine architecture
from the system registry because Parallels may omit processor environment
variables from x86 processes. It must not perform post-install path checks or
duplicate shortcut creation.

Windows NSIS payloads use ZIP extraction with differential packaging disabled.
This extracts directly to the destination; the default 7z flow copies through
an NSIS temporary folder and can omit root ARM64 executable files under
Windows-on-ARM virtualization.

Windows ARM64 uses native ARM64 Electron and native modules where available, with an x64 private Python/AI runtime under Windows emulation because the required PyTorch and FAISS wheels are not published for Windows ARM64.

Build and smoke-test installers on their target operating system. Cross-building can create artifacts, but it cannot prove target runtime behavior, signing, installer behavior, or native loading.

## Project Map

```text
AI-index/                 Python embedding and similarity-search entry points
build/                    Application and installer icons
docs/                     Feature, architecture, IPC, and function documentation
electron/                 Main process, preload bridge, workers, runtime managers
resources/poppler/        Per-target Poppler runtime files
scripts/                  Build preparation, validation, and contract audits
src/renderer/             React renderer, store, components, styles, helpers
```

Key entry points:

- `electron/main.js`: application lifecycle, SQLite, thumbnails, previews, IPC, watchers, web grab, and AI orchestration.
- `electron/preload.js`: the context-isolated `window.electronAPI` bridge.
- `src/renderer/main.tsx`: renderer bootstrap.
- `src/renderer/components/RuntimeBootstrap.tsx`: onboarding and dependency installation.
- `src/renderer/App.tsx`: main application shell and startup hydration.
- `src/renderer/store/useStore.ts`: renderer state and mutations.
- `src/renderer/thumbEngine.ts`: renderer-assisted video and 3D thumbnail work.

## Documentation

- [Feature Guide](docs/FEATURES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Function Reference](docs/FUNCTION_REFERENCE.md)
- [IPC Reference](docs/IPC_REFERENCE.md)
- [Production Hardening Plan](docs/production-hardening-plan.md)

## Native Dependency Rule

`better-sqlite3` is a native C++ addon. It must match Electron's ABI and the target CPU architecture. The repository enforces this with:

- exact Electron and `better-sqlite3` versions;
- `postinstall` native dependency alignment;
- `@electron/rebuild`;
- per-target native preparation;
- electron-builder `npmRebuild`;
- packaged binary validation;
- an Electron smoke test that opens SQLite.

If native loading fails, run:

```bash
npm ci
npm run electron:rebuild
npm run test:native
```

## Logs

Application logs are written under the Stag user-data directory in `logs/`. Runtime installation uses a separate `install.log` inside the private runtime directory. Packaged users can open the installation log from the failure screen.

## License

See [LICENSE](LICENSE).
