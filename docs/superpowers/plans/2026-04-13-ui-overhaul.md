# UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Stag's UI into a professional dark glassmorphism app with neutral near-black background, frosted glass panels, compact sidebar, and slimmed two-row toolbar — zero functional changes.

**Architecture:** CSS-only changes where possible (global token rewrite propagates to all panels); targeted TSX restructuring only for toolbar row split and sidebar brand header. Each task is self-contained and visually testable.

**Tech Stack:** React + CSS Modules, Electron, Vite, DM Sans font, existing Zustand store (untouched).

**Spec:** `docs/superpowers/specs/2026-04-13-ui-overhaul-design.md`

---

## File Map

| File | Change |
|---|---|
| `src/renderer/styles/global.css` | Token rewrite + root gradient + scrollbars |
| `src/renderer/components/TitleBar.module.css` | Add backdrop-filter glass recipe |
| `src/renderer/components/Toolbar.module.css` | Full glass + two-row layout CSS |
| `src/renderer/components/Toolbar.tsx` | Split controls into primary/secondary rows |
| `src/renderer/components/Sidebar.module.css` | Compact sizes + remove section dividers |
| `src/renderer/components/AssetGrid.module.css` | Card default/hover/selected states |
| `src/renderer/components/Inspector.module.css` | Update border + notes + prop rows |
| `src/renderer/components/MainContent.module.css` | Empty state icon, drop overlay |
| `src/renderer/styles/App.module.css` | Drop overlay glass |

---

### Task 1: Global Color Tokens

**Files:**
- Modify: `src/renderer/styles/global.css`

- [ ] **Step 1: Update `:root` token block**

Replace the entire `:root { ... }` block (lines 5–50) with:

```css
:root {
  --glass-opacity:  0.06;
  --blur-strength:  24px;

  --bg-base:       #0e0e10;
  --bg-app:        #0e0e10;
  --bg-primary:    rgba(14, 14, 16, 0.99);
  --bg-secondary:  rgba(30, 30, 33, 0.78);
  --bg-tertiary:   rgba(38, 38, 46, 0.80);
  --bg-card:       rgba(22, 22, 28, 0.92);
  --bg-hover:      rgba(255,255,255,0.044);
  --bg-active:     rgba(255,255,255,0.07);
  --glass:         rgba(255,255,255,var(--glass-opacity));
  --glass-border:  rgba(255,255,255,0.07);
  --border:        rgba(255,255,255,0.068);
  --border-light:  rgba(255,255,255,0.11);

  --text-primary:  #e9ebf1;
  --text-secondary:#8c94a1;
  --text-muted:    #505a68;
  --text-dim:      #303640;

  --accent:        #4a9eff;
  --accent-hover:  #69b4ff;
  --accent-dim:    rgba(74,158,255,0.13);
  --accent-glow:   rgba(74,158,255,0.32);

  --tag-bg:        rgba(255,255,255,0.065);
  --tag-text:      #b6bcc8;
  --star-color:    #f5a623;
  --danger:        #e05252;
  --danger-dim:    rgba(224,82,82,0.12);
  --success:       #52c078;

  --radius-xs:3px;--radius-sm:5px;--radius-md:8px;
  --radius-lg:8px;--radius-xl:18px;--radius-2xl:24px;

  --shadow-sm:0 1px 4px rgba(0,0,0,0.6);
  --shadow-md:0 4px 20px rgba(0,0,0,0.65);
  --shadow-lg:0 8px 40px rgba(0,0,0,0.78);
  --shadow-xl:0 24px 72px rgba(0,0,0,0.90);

  --titlebar-height:40px;
  --sidebar-width:222px;
  --inspector-width:266px;
}
```

- [ ] **Step 2: Update `#root` gradient**

Replace the `#root` rule's background with:

```css
#root {
  position:relative;
  background:
    radial-gradient(ellipse 60% 30% at 50% 0%, rgba(74,158,255,0.035) 0%, transparent 50%),
    var(--bg-app);
}
```

- [ ] **Step 3: Update scrollbar thumb hover**

Change `.scrollbar-thumb:hover` from `rgba(255,255,255,0.16)` to `rgba(255,255,255,0.15)` and width/height from `5px` to `4px`:

```css
::-webkit-scrollbar{width:4px;height:4px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.07);border-radius:4px;}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.15);}
```

- [ ] **Step 4: Verify visually**

Run `npm run dev`. App background should be neutral near-black `#0e0e10` — no blue/purple cast. Sidebar and inspector panels should appear noticeably lighter than the main content area (glass effect via semi-transparent `--bg-secondary`).

---

### Task 2: Titlebar Glass Recipe

**Files:**
- Modify: `src/renderer/components/TitleBar.module.css`

The titlebar already uses `var(--bg-secondary)` for background, so the token change in Task 1 gives it the glass color. This task adds the missing `backdrop-filter`.

- [ ] **Step 1: Add backdrop-filter to `.titlebar`**

Replace the `.titlebar` rule:

```css
.titlebar {
  height: var(--titlebar-height);
  background: var(--bg-secondary);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-bottom: 1px solid rgba(255,255,255,0.055);
  box-shadow: 0 1px 0 rgba(0,0,0,0.4);
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  flex-shrink: 0;
  position: relative;
  -webkit-app-region: drag;
  gap: 0;
}
```

- [ ] **Step 2: Update `.appName` and `.appIcon` opacity**

Replace the existing `.appTitle`, `.appIcon`, `.appName` rules:

```css
.appTitle {
  display: flex; align-items: center; gap: 7px;
  pointer-events: none;
  user-select: none;
}
.appIcon { color: var(--text-muted); opacity: 0.5; display: flex; align-items: center; }
.appName {
  font-size: 10px; font-weight: 700;
  color: var(--text-muted); opacity: 0.45;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
```

- [ ] **Step 3: Verify visually**

Titlebar should show frosted glass effect — visibly distinct from the raw `#0e0e10` background behind it. Wordmark should be very quiet (low opacity).

---

### Task 3: Toolbar CSS — Two-Row Layout + Glass

**Files:**
- Modify: `src/renderer/components/Toolbar.module.css`

- [ ] **Step 1: Add backdrop-filter to `.toolbar` and resize primary row**

Replace the `.toolbar` and `.toolbarMain` rules:

```css
.toolbar {
  flex-shrink: 0;
  background: var(--bg-secondary);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-bottom: 1px solid rgba(255,255,255,0.055);
  box-shadow: 0 1px 0 rgba(0,0,0,0.4);
  display: flex; flex-direction: column;
  position: relative;
}
.toolbarMain {
  height: 40px;
  display: flex; align-items: center;
  gap: 8px; padding: 0 12px;
}
```

- [ ] **Step 2: Add `.toolbarSecondary` row styles**

Add after `.toolbarMain`:

```css
.toolbarSecondary {
  height: 28px;
  display: flex; align-items: center;
  gap: 6px; padding: 0 10px;
  background: rgba(0,0,0,0.15);
  border-top: 1px solid rgba(255,255,255,0.04);
}
.toolbarSecondary .sizeSlider,
.toolbarSecondary .iconBtn,
.toolbarSecondary .sortSelect,
.toolbarSecondary .filterWrap {
  opacity: 0.7;
  font-size: 11px;
}
.toolbarSecondary .sizeSlider:hover,
.toolbarSecondary .iconBtn:hover,
.toolbarSecondary .sortSelect:hover,
.toolbarSecondary .filterWrap:hover {
  opacity: 1;
}
```

- [ ] **Step 3: Update import button to pill shape**

Replace the `.importBtn` rule:

```css
.importBtn {
  display: flex; align-items: center; gap: 5px;
  background: var(--accent); color: #fff;
  border: none; border-radius: var(--radius-xl);
  font-size: 12px; font-family: inherit; font-weight: 600;
  padding: 5px 14px; cursor: pointer; white-space: nowrap;
  transition: background 0.12s, box-shadow 0.15s;
  box-shadow: 0 2px 10px rgba(74,158,255,0.32);
}
.importBtn:hover {
  background: var(--accent-hover);
  box-shadow: 0 4px 16px rgba(74,158,255,0.42);
}
.importBtn:disabled { opacity: 0.5; cursor: not-allowed; }
```

- [ ] **Step 4: Update search box**

Replace `.searchBox` and `.searchBox:focus-within`:

```css
.searchBox {
  display: flex; align-items: center; gap: 5px;
  background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08);
  border-radius: var(--radius-md); padding: 0 10px; height: 28px;
  min-width: 190px; transition: border-color 0.15s, box-shadow 0.15s;
}
.searchBox:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
```

- [ ] **Step 5: Verify CSS compiles**

Run `npm run dev`. Toolbar should render (even with controls in the wrong row for now — TSX split happens in Task 4). No CSS errors in console.

---

### Task 4: Toolbar TSX — Split Into Two Rows

**Files:**
- Modify: `src/renderer/components/Toolbar.tsx`

- [ ] **Step 1: Restructure JSX return**

Replace the entire `return (...)` block (lines 112–218) with:

```tsx
  return (
    <div className={styles.toolbar}>
      {/* ── Primary row: title + search + import + selection actions ── */}
      <div className={styles.toolbarMain}>
        <div className={styles.left}>
          <h2 className={styles.title}>{folderName}</h2>
          <span className={styles.count}>{count}</span>
        </div>

        <div className={styles.right}>
          <div className={styles.searchBox}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={styles.searchIcon}>
              <circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            <input ref={searchRef} className={styles.searchInput} placeholder="Search name, tags…"
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            {searchQuery && <button className={styles.searchClear} onClick={() => setSearchQuery('')}>×</button>}
          </div>

          <button className={styles.importBtn} onClick={handleImport} disabled={isLoading}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v7M3 6l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M1 10h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Import
          </button>

          {/* ── Selection actions — shown when items selected ── */}
          {hasSelection && (
            <>
              <div className={styles.selectionDivider} />
              <span className={styles.selectionCount}>{selectedCount} selected</span>
              {inTrash ? (
                <>
                  <button className={styles.selectionBtn} onClick={onRestore}>Restore</button>
                  <button className={`${styles.selectionBtn} ${styles.selectionDanger}`} onClick={onPermanentDelete}>
                    Delete permanently
                  </button>
                </>
              ) : (
                <button className={`${styles.selectionBtn} ${styles.selectionDanger}`} onClick={onDelete}>
                  Trash{selectedCount > 1 ? ` (${selectedCount})` : ''}
                </button>
              )}
              {!inTrash && onReAiTag && (
                <button className={styles.selectionBtn} onClick={onReAiTag} title="Re-run AI captioning and tagging">
                  Re-tag
                </button>
              )}
              <button className={styles.selectionBtnGhost} onClick={onDeselect}>✕</button>
            </>
          )}
        </div>
      </div>

      {/* ── Secondary row: size slider + sort + filter ── */}
      <div className={styles.toolbarSecondary}>
        <div className={styles.sizeSlider}>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" style={{ color: 'var(--text-muted)' }}>
            <rect x="0" y="3.5" width="4" height="4" rx="0.5"/>
            <rect x="6" y="1" width="5" height="9" rx="0.5" opacity="0.5"/>
          </svg>
          <input type="range" min="80" max="320" value={thumbnailSize}
            onChange={e => setThumbnailSize(Number(e.target.value))}
            className={styles.slider} />
        </div>

        <button className={styles.iconBtn} onClick={toggleSortDir} title="Toggle sort direction">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            {sortDir === 'desc'
              ? <path d="M2 3h9M2 6.5h6M2 10h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              : <path d="M2 10h9M2 6.5h6M2 3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>}
          </svg>
        </button>

        <select className={styles.sortSelect} value={sortBy}
          onChange={e => setSortBy(e.target.value as any)}>
          <option value="date">Date added</option>
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="rating">Rating</option>
        </select>

        <div className={styles.filterWrap}>
          <button className={`${styles.iconBtn} ${hasFilters ? styles.activeBtn : ''}`}
            onClick={() => setShowFilter(!showFilter)} title="Filters">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M1.5 3h10L8 7.5v4L5 10V7.5L1.5 3z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
                fill={hasFilters ? 'currentColor' : 'none'} fillOpacity="0.2"/>
            </svg>
            {hasFilters && <span className={styles.filterDot} />}
          </button>
          {showFilter && <FilterPanel onClose={() => setShowFilter(false)} />}
        </div>
      </div>

      {/* Progress — own row below secondary row */}
      {isLoading && importProgress && (
        <div className={styles.progressWrap}>
          <div className={styles.progressTrack}>
            <div className={styles.progressBar} style={{ width: `${pct}%` }} />
          </div>
          <span className={styles.progressText}>
            Importing {importProgress.current}/{importProgress.total} — {importProgress.currentName}
          </span>
        </div>
      )}
    </div>
  )
```

- [ ] **Step 2: Verify toolbar renders correctly**

Run `npm run dev`. Toolbar should show:
- Top row (40px): folder title + count on left, search box + import button on right
- Bottom row (28px, slightly darker): size slider + sort direction + sort select + filter button
- Secondary row controls should be slightly dimmed (opacity 0.7) and brighten on hover

---

### Task 5: Sidebar CSS — Compact Layout

**Files:**
- Modify: `src/renderer/components/Sidebar.module.css`

- [ ] **Step 1: Update `.sidebar` glass recipe**

Replace the `.sidebar` rule:

```css
.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  background: var(--bg-secondary);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-right: 1px solid rgba(255,255,255,0.07);
  box-shadow: 1px 0 0 rgba(0,0,0,0.3);
  display: flex; flex-direction: column;
  overflow-y: auto; overflow-x: hidden;
  flex-shrink: 0;
}
```

- [ ] **Step 2: Shrink brand header**

Replace `.brandHeader` and `.brandName`:

```css
.brandHeader {
  display: flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.brandName {
  font-size: 9px; font-weight: 700;
  color: var(--text-muted);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.35;
}
```

- [ ] **Step 3: Remove section border dividers, compact nav items**

Replace `.section`, `.sectionHeader`, `.navItem`, `.navLabel`, `.navCount`:

```css
.section { padding: 4px 0 6px; }

.sectionHeader {
  font-size: 9px; font-weight: 700;
  color: var(--text-muted); text-transform: uppercase;
  letter-spacing: 0.12em; opacity: 0.45;
  padding: 5px 14px 3px;
}

.navItem {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 10px 4px 12px;
  height: 28px;
  border-radius: var(--radius-md);
  margin: 1px 6px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, box-shadow 0.12s;
  color: var(--text-secondary);
}
.navItem:hover { background: var(--bg-hover); color: var(--text-primary); }
.navActive {
  background: var(--accent-dim) !important;
  color: var(--accent) !important;
  box-shadow: inset 2px 0 0 var(--accent);
}
.navIcon { opacity: 0.65; flex-shrink: 0; display: flex; align-items: center; color: inherit; }
.sectionIcon { opacity: 0.6; flex-shrink: 0; display: flex; align-items: center; color: var(--text-muted); margin-right: -2px; }
.navLabel { flex: 1; font-size: 12px; font-weight: 450; }
.navCount {
  font-size: 10px; color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 0 5px; border-radius: 8px; min-width: 18px;
  text-align: center;
}
```

- [ ] **Step 4: Compact collapse headers, remove dividers**

Replace `.collapseSection`, `.collapseHeader`, `.collapseArrow`, `.collapseLabel`:

```css
.collapseSection { margin-top: 6px; }

.collapseHeader {
  display: flex; align-items: center; gap: 6px;
  height: 26px; padding: 5px 10px 5px 12px;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
  color: var(--text-muted);
}
.collapseHeader:hover { background: var(--bg-hover); color: var(--text-secondary); }

.collapseArrow {
  font-size: 7px; color: var(--text-muted); opacity: 0.5;
  display: inline-block; transition: transform 0.15s;
  flex-shrink: 0;
}
.collapseLabel {
  flex: 1; font-size: 9px; font-weight: 700;
  color: var(--text-muted); text-transform: uppercase;
  letter-spacing: 0.12em; opacity: 0.45;
}
```

- [ ] **Step 5: Compact folder rows and tag rows**

Replace `.folderRow`, `.folderName`, `.folderCount`, `.tagRow`, `.tagDot`, `.tagName`:

```css
.folderRow {
  display: flex; align-items: center; gap: 5px;
  padding: 3px 8px 3px 8px;
  margin: 1px 4px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.1s;
  color: var(--text-secondary);
  position: relative;
}
.folderRow:hover { background: var(--bg-hover); color: var(--text-primary); }
.folderRow.active {
  background: var(--accent-dim) !important;
  color: var(--accent) !important;
  box-shadow: inset 2px 0 0 var(--accent);
}

.folderIcon { font-size: 13px; flex-shrink: 0; }
.folderName { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folderCount { font-size: 10px; color: var(--text-muted); }

.tagRow {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 8px 3px 16px;
  cursor: pointer; transition: background 0.1s;
  border-radius: var(--radius-md); margin: 1px 4px;
  color: var(--text-secondary);
  position: relative;
}
.tagRow:hover { background: var(--bg-hover); color: var(--text-primary); }

.tagDot {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--accent); flex-shrink: 0;
}
.tagName { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tagCount { font-size: 10px; color: var(--text-muted); }
```

- [ ] **Step 6: Compact filter section chips**

Replace `.ratingBtn` and `.extChip` in the sidebar filter section:

```css
.ratingBtn {
  background: var(--bg-tertiary); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text-muted);
  font-size: 10px; font-family: inherit; padding: 3px 6px; cursor: pointer;
  transition: all 0.1s;
}
.extChip {
  background: var(--bg-tertiary); border: 1px solid var(--border);
  border-radius: 3px; color: var(--text-muted);
  font-size: 9px; font-family: inherit; padding: 2px 5px;
  cursor: pointer; text-transform: uppercase; letter-spacing: 0.04em; transition: all 0.1s;
}
```

- [ ] **Step 7: Verify sidebar visually**

Sidebar should be noticeably more compact — more nav items visible in same height. Brand header is a single slim line. Section divider borders gone (just spacing).

---

### Task 6: Sidebar TSX — Depth Indent Update

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

The folder rows use `paddingLeft: depth * 14` inline style for indent. Spec calls for `depth * 10`.

- [ ] **Step 1: Find and update depth indent**

Search for `depth * 14` in Sidebar.tsx. Replace with `depth * 10`:

```tsx
// Before:
style={{ paddingLeft: depth * 14 }}

// After:
style={{ paddingLeft: depth * 10 }}
```

Also update the brand header icon opacity from `opacity: 0.5` to `opacity: 0.35` if the SVG antler is rendered inline:

```tsx
// Before (in brandHeader JSX):
<svg ... style={{ opacity: 0.5 }} ...>

// After:
<svg ... style={{ opacity: 0.35 }} ...>
```

- [ ] **Step 2: Verify folder nesting looks correct**

Nested folders should indent slightly but not excessively. Deep nesting (3–4 levels) should still fit within the 222px sidebar width.

---

### Task 7: Asset Card Styling

**Files:**
- Modify: `src/renderer/components/AssetGrid.module.css`

- [ ] **Step 1: Update card default, hover, and selection states**

Replace the `.card`, `.card:hover`, and any `.cardSelected` rule (check bottom of file):

```css
.card {
  position: relative; border-radius: var(--radius-lg);
  cursor: pointer; display: block;
  outline: 2px solid transparent;
  outline-offset: -1px;
  transition: outline-color 0.15s, box-shadow 0.18s, transform 0.22s cubic-bezier(0.34,1.46,0.64,1), z-index 0s;
  user-select: none;
  contain: layout style;
  background: var(--bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.04);
  animation: cardIn 0.25s ease-out both;
  will-change: transform;
}
.card:hover {
  outline-color: rgba(255,255,255,0.10);
  box-shadow: 0 10px 34px rgba(0,0,0,0.6), 0 3px 10px rgba(0,0,0,0.38), inset 0 0 0 1px rgba(255,255,255,0.09);
  transform: scale(1.022);
  z-index: 3;
}
```

- [ ] **Step 2: Find `.cardSelected` or `.selected` rule at bottom of file and update**

Read the full AssetGrid.module.css to find the selected state (likely near bottom). Replace with:

```css
.cardSelected {
  outline: 2px solid var(--accent) !important;
  outline-offset: -1px;
  box-shadow: 0 0 0 1px rgba(74,158,255,0.45), 0 0 20px rgba(74,158,255,0.20), 0 6px 22px rgba(0,0,0,0.5) !important;
}
```

(Match the exact class name used in the file — could be `.selected`, `.cardSelected`, etc.)

- [ ] **Step 3: Verify card interactions**

Cards should have a very subtle lift on hover (scale 1.022, deeper shadow). Selected cards should show a clear blue outline glow.

---

### Task 8: Inspector Panel Styling

**Files:**
- Modify: `src/renderer/components/Inspector.module.css`

- [ ] **Step 1: Update `.panel` border**

The panel already has `backdrop-filter` (from current code). Update its border and shadow values:

```css
.panel {
  width: var(--inspector-width); min-width: var(--inspector-width);
  background: var(--bg-secondary);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-left: 1px solid rgba(255,255,255,0.07);
  box-shadow: -1px 0 0 rgba(0,0,0,0.3);
  display: flex; flex-direction: column; overflow: hidden;
  animation: slideInRight 0.15s ease-out;
}
```

- [ ] **Step 2: Update section label, chips, notes, prop rows**

Replace `.secLabel`, `.chip`, `.notes`, `.propK`, `.propV`:

```css
.secLabel {
  font-size: 9px; font-weight: 700;
  color: var(--text-muted); text-transform: uppercase;
  letter-spacing: 0.12em; opacity: 0.5;
  margin-bottom: 6px;
}

.chip {
  display: inline-flex; align-items: center; gap: 3px;
  background: rgba(255,255,255,0.065); color: var(--tag-text);
  border-radius: var(--radius-md); padding: 3px 6px 3px 8px;
  font-size: 11px; border: 1px solid rgba(255,255,255,0.10);
  transition: background 0.1s, border-color 0.1s;
}
.chip:hover { background: var(--bg-hover); border-color: var(--border-light); }
.fchip { background: var(--accent-dim); color: var(--accent); border-color: rgba(74,158,255,0.2); }

.notes {
  width: 100%; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08);
  border-radius: var(--radius-md); color: var(--text-secondary);
  font-size: 12px; font-family: inherit; padding: 6px 8px;
  resize: none; min-height: 60px; height: 60px; flex-shrink: 0; outline: none; transition: border-color 0.12s;
}
.notes:focus { border-color: var(--accent); color: var(--text-primary); }
.notes::placeholder { color: var(--text-muted); }

.propK { font-size: 11px; color: var(--text-muted); white-space: nowrap; flex-shrink: 0; }
.propV { font-size: 11px; color: var(--text-secondary); text-align: right; word-break: break-all; }
```

- [ ] **Step 3: Add alternating prop row bg**

Replace `.propRow`:

```css
.propRow { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.props .propRow:nth-child(odd) { background: rgba(255,255,255,0.018); border-radius: 3px; padding: 1px 3px; }
```

- [ ] **Step 4: Verify inspector**

Inspector panel should show frosted glass. Section labels are tiny and dim. Property rows have very subtle alternating background.

---

### Task 9: Supporting Styles

**Files:**
- Modify: `src/renderer/components/MainContent.module.css`
- Modify: `src/renderer/styles/App.module.css`

- [ ] **Step 1: Update drop overlay in App.module.css**

Replace `.dropOverlay` and `.dropBox`:

```css
.dropOverlay {
  position: absolute; inset: 0; z-index: 999;
  background: rgba(74,158,255,0.05);
  display: flex; align-items: center; justify-content: center;
  pointer-events: none; animation: fadeIn 0.1s ease-out;
}
.dropBox {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  background: rgba(30,30,33,0.78);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border: 2px dashed var(--accent);
  border-radius: var(--radius-xl); padding: 48px 72px; box-shadow: var(--shadow-xl);
}
```

- [ ] **Step 2: Update empty state icon in MainContent.module.css**

Replace `.emptyIcon`:

```css
.emptyIcon { font-size: 52px; opacity: 0.15; }
```

- [ ] **Step 3: Final visual pass**

Run `npm run dev`. Check:
- [ ] Background is neutral dark, no blue/purple cast
- [ ] Sidebar, titlebar, toolbar, inspector all show frosted glass (visibly lighter than content area)
- [ ] Toolbar has two distinct rows — primary (40px) and secondary (28px)
- [ ] Sidebar is compact — more nav items visible per screen height
- [ ] Import button is pill-shaped
- [ ] Card hover lifts with shadow (scale 1.022)
- [ ] Selected cards show blue glow
- [ ] No layout regressions — masonry grid still fills full width
- [ ] All existing features work (import, search, sort, filter, AI toggle, selection, trash, tags, folders)
