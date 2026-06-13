# Stag Feature Guide

This document describes the behavior available to users. Implementation details are in [ARCHITECTURE.md](ARCHITECTURE.md).

## First-Run Onboarding

Stag checks the private runtime before rendering the main library.

1. The welcome page introduces Stag.
2. The user chooses light or dark appearance.
3. Stag explains that local dependencies are required.
4. An internet probe must succeed before installation.
5. Python, FFmpeg, ImageMagick, Ghostscript, and AI dependencies install in sequence.
6. Each step reports a measured percentage when the source exposes byte or terminal progress.
7. A failed step shows a retry action and the installation log.

Closing before installation starts restarts onboarding at Welcome. Closing after installation starts resumes the installation page. A fully ready runtime opens the library directly without flashing onboarding.

## Library Navigation

The left sidebar provides:

- **All Assets**: all visible, non-deleted assets.
- **Uncategorized**: assets without a folder.
- **Untagged**: assets without tags.
- **Recently Used**: assets previewed during the last 48 hours.
- **Random**: a shuffled library view.
- **Trash**: soft-deleted assets.
- **Smart**: saved rule-based views.
- **Folders**: nested user organization.
- **Labels**: tag browsing and filtering.

Counts use the same visibility and deletion rules as the corresponding view. Hidden sensitive assets are not counted as visible recent items.

## Import

### Local Files

Files can be selected through the Import action or dropped into the app.

The import pipeline:

1. Resolves native filesystem paths.
2. Rejects duplicate path/size combinations already in the library.
3. Reads import settings and worker concurrency.
4. Optionally copies files into the managed import folder.
5. Creates asset records in SQLite in batches.
6. Applies default type tags.
7. Reads image dimensions where inexpensive.
8. Displays asset cards before expensive thumbnail work finishes.
9. Generates thumbnails and palettes.
10. Schedules enabled AI services independently.
11. Rebuilds filesystem watchers.

Multiple import sessions are serialized. Later sessions show a queued notification rather than racing database and thumbnail work.

### Copy On Import

When enabled, source files are copied to the configured managed folder before their database paths are saved. Filename collisions receive numeric suffixes. Copy progress is reported by file and bytes.

Disabling copy on import leaves files at their original locations and stores those paths.

### Website Assets

A URL entered into Stag becomes a website asset. Stag captures a Chromium screenshot and stores it as the website thumbnail. Importing the same URL refreshes the existing thumbnail.

### Web Grab

Stag runs local compatibility endpoints and watches the configured WebGrab folder. Supported requests can contain remote URLs or data URLs. Saved files are imported by the folder watcher, avoiding duplicate import races.

## Asset Grid

Available layouts:

- **Masonry**: variable-height columns.
- **Justified**: rows resized to fill available width.
- **Grid**: uniform cells.
- **List**: compact metadata rows.

The thumbnail-size slider is persisted. Cards can show a filename, filename extension, and extension badge according to settings. Long names wrap instead of overflowing.

The renderer uses virtualized rows and paginated SQLite queries. It keeps a bounded page cache and reloads affected pages after mutations.

## Search, Sort, And Filters

Search fields can include:

- filename;
- notes and AI description;
- extension;
- tags.

Additional controls provide:

- date, name, size, or rating sorting;
- ascending or descending order;
- minimum rating;
- extension filters;
- clear-all filters.

SQLite FTS5 indexes name, extension, notes, AI description, and tags. The renderer preserves AI relevance order and Recently Used order where normal sorting would be incorrect.

## Folders

Folders support:

- creation at the root or under another folder;
- nesting;
- rename, color, and icon metadata;
- drag/drop asset assignment;
- automatic descendant inclusion when viewing a parent;
- deletion with relation cleanup;
- optional auto-tags stored with the folder.

Default folders are seeded only when a new database has none.

## Smart Folders

Smart folders combine rules with `ALL` or `ANY` logic.

Supported rule concepts include:

- tag contains or is empty;
- filename contains;
- exact extension;
- rating greater than or equal to a value;
- rating less than or equal to a value;
- color matching where supported by the query path.

Built-in examples are High Rated and Untagged.

## Tags And Sensitive Content

Tags can be added, removed, filtered, and batch-edited. Deleting a tag removes it from all assets. Delete All Tags clears the global list and all asset relations.

Users can designate tags as sensitive. When sensitive content is hidden, matching assets are excluded from database queries, grids, and visible counts. The top-bar visibility action can temporarily show them.

## Inspector

The right inspector supports one or many selected assets.

Single selection can show or edit:

- thumbnail or preview;
- filename;
- AI status;
- palette colors;
- notes and AI description;
- tags;
- folders;
- rating;
- dimensions, size, type, import date, and modified date;
- file actions such as Show, Export, Share, and copy.

Multi-selection supports batch tags, folders, export, sharing, and common operations.

## Preview And Lightbox

Double-clicking or opening an asset records it as recently used and opens the appropriate preview.

### Images

Images support zoom, pan, fullscreen display, converted previews for formats Chromium cannot display, and cached full-resolution preview conversion.

EXIF orientation is applied before thumbnail resize so thumbnails match the source's intended orientation.

### Video

Native Chromium video formats use the native player. MPEG transport streams use `mpegts.js`. FFmpeg handles difficult formats, F4V, large files, and transient scrub frames.

The scrub strip requests frames across the duration and allows seeking by thumbnail. Hardware video decoding switches are enabled where Electron supports them.

### Audio

Audio assets use a dedicated player with standard playback controls.

### PDF

PDF files open in the bundled Mozilla PDF.js viewer. Poppler generates cover thumbnails. Printing uses the current renderer view.

### EPUB

EPUB files render with EPUB.js and support previous/next page, font-size controls, print, and fullscreen. Cover extraction feeds thumbnails and AI tagging.

### Text And Code

Text-like files are read with a byte limit and display truncation state. Editable text can be written back, with SQLite size and modification metadata updated.

### Fonts

Font files are loaded into a temporary `FontFace` and displayed with a sample character set.

### 3D

Three.js renders supported models with orbit controls, lighting, environment mapping, and model-specific loaders. Thumbnail rendering uses an offscreen scene.

### Websites

Website assets show a captured thumbnail and can open their URL externally.

## File Actions

Depending on the asset and platform, Stag supports:

- open with the default application;
- choose an application on macOS or use the system chooser;
- show in Finder or Explorer;
- duplicate and rename;
- export original;
- export images to another format and dimensions;
- copy the file or thumbnail to the clipboard;
- share through platform facilities;
- Google Lens image search;
- generate and export contact sheets;
- drag one or many files out of Stag.

## Trash And Deletion

Moving to Trash only marks the asset as deleted.

From Trash, users can:

- restore assets;
- remove database records while keeping source files;
- delete both records and source files;
- cancel a permanent-delete prompt.

Website records are database-only and do not have a source file. Thumbnail, relation, FTS, and AI-index records are cleaned during hard deletion.

## Thumbnail System

Stag stores WebP thumbnails on disk, not inside SQLite.

- Full thumbnail: up to the configured maximum dimension.
- Variants: small, medium, and large widths.
- Selection: the grid chooses the closest suitable variant for display size and device pixel ratio.
- Recovery: startup reconciles database flags with actual files and queues missing work.
- Maintenance: legacy thumbnails, orientation fixes, quality refreshes, and variant backfills run as delayed migrations.
- Unsupported or failed formats remain retryable rather than being permanently marked complete.

Image tools are selected in this order where appropriate: Sharp, Chromium, ImageMagick/Ghostscript, Poppler, FFmpeg, and format-specific parsing.

## AI Auto-Tagging

AI tagging requires:

- an enabled tagging setting;
- a reachable Ollama server;
- the configured vision model installed in Ollama;
- a taggable source or generated thumbnail.

Native JPEG, PNG, and WebP files can be sent directly. Other images, video, 3D assets, PDF, and EPUB use their generated thumbnail or cover.

The queue:

1. reads untagged assets from SQLite;
2. waits for taggable thumbnails where needed;
3. acquires the shared AI task coordinator;
4. sends one item to Ollama;
5. stores description and merged tags transactionally;
6. updates FTS and renderer state;
7. skips already-tagged assets;
8. stops the session after a fatal connection failure.

Tagging cannot be enabled from the top bar when Ollama or the selected model is unavailable.

## TIPSv2 Text Search

TIPSv2 creates an embedding index used for text-to-image semantic search.

- Model installation and feature enablement are separate.
- Indexing only starts when enabled.
- Images and generated asset thumbnails are staged into normalized files.
- Preparation completes before Python indexing starts.
- SQLite `aiEmbedded` flags and index contents are reconciled.
- New local and web imports schedule indexing when enabled.
- Delete Index removes index data and resets database flags.
- Reindex All clears state, enables the feature, and starts a full rebuild.
- The search worker stays warm while semantic search is active.

## DINOv3 Image Search

DINOv3 creates a separate visual-similarity index.

- Downloading the model does not automatically enable indexing.
- Enabled imports schedule incremental indexing.
- Search accepts a query image and ranks visually similar library assets.
- Delete Index and Reindex All are available in settings.
- A disabled feature cancels active work and removes its progress item.

## AI Task Coordination

Only one expensive AI task runs at a time across:

- TIPSv2 embedding;
- DINOv3 indexing;
- Ollama tagging.

The main process coordinator grants tokens to queued tasks. Renderer and Python work release tokens in `finally` paths so an error does not permanently block later jobs.

The process dock stacks active work vertically and removes completed, failed, or cancelled tasks.

## Settings

### Appearance

- light or dark theme;
- accent color;
- persisted view mode and thumbnail size;
- thumbnail label and extension visibility.

### Library

- move the library database and thumbnail directory;
- configure managed local-import and WebGrab folders;
- copy-on-import behavior;
- sensitive tags and visibility.

### Performance

- worker thread count;
- runtime status;
- reinstall private Python and media/AI dependencies;
- tool availability.

### AI Tagging

- Ollama URL;
- installed-model refresh;
- selected model;
- enable state guarded by live availability.

### AI Text Search

- model status and download;
- enable/disable;
- index status;
- delete index;
- reindex all.

### AI Image Search

- DINOv3 model status and download;
- enable/disable;
- index location and status;
- delete index;
- reindex all.

### Shortcuts

The settings view documents keyboard shortcuts used for selection, preview, deletion, sidebar/inspector controls, and navigation.

## Background Behavior

- A single-instance lock restores the existing app instead of opening a duplicate process.
- Closing the window hides Stag to the system tray unless the user explicitly quits.
- Parent-directory watchers detect removed files and soft-delete missing assets.
- Managed import folders are scanned after startup.
- FTS, thumbnail, orientation, and variant maintenance are delayed to keep first paint responsive.
- AI auto-start jobs respect their saved enable states.

## Updates And Reinstalls

Installing a newer Stag version replaces the application files but reuses settings, library data, thumbnails, private runtime, and AI indexes. Schema and thumbnail migrations run on existing data. Runtime version markers trigger dependency upgrades only when Stag's required runtime version changes.
