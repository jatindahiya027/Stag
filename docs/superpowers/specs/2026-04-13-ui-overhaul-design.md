# Stag — Complete UI Overhaul Design Spec
**Date:** 2026-04-13  
**Status:** Approved  
**Scope:** Visual + targeted component changes (Approach B)

---

## Goal

Transform the current UI into a professional, polished dark application with:
- Neutral near-black background (no color cast)
- Frosted glass panels (sidebar, inspector, toolbar, titlebar)
- Compact restructured sidebar
- Slimmed two-row toolbar
- Consistent design system throughout

Zero functional changes. All existing features preserved exactly.

---

## 1. Color System

### Base Tokens (`global.css` `:root`)

| Token | Value | Purpose |
|---|---|---|
| `--bg-app` | `#0e0e10` | Root background — neutral near-black |
| `--bg-base` | `#0e0e10` | Same (JS writes this) |
| `--bg-primary` | `rgba(14, 14, 16, 0.99)` | Main content area |
| `--bg-secondary` | `rgba(30, 30, 33, 0.78)` | Glass panels (sidebar, inspector, toolbar) |
| `--bg-tertiary` | `rgba(38, 38, 46, 0.80)` | Inputs, hover backgrounds |
| `--bg-card` | `rgba(22, 22, 28, 0.92)` | Asset cards |
| `--bg-hover` | `rgba(255,255,255,0.044)` | Item hover overlays |
| `--bg-active` | `rgba(255,255,255,0.07)` | Active/pressed states |
| `--border` | `rgba(255,255,255,0.068)` | Default borders |
| `--border-light` | `rgba(255,255,255,0.11)` | Highlighted borders |
| `--glass-border` | `rgba(255,255,255,0.07)` | Panel facing-edge borders |
| `--blur-strength` | `24px` | Backdrop blur amount |
| `--glass-opacity` | `0.06` | Glass overlay opacity |

### Root Gradient (`#root`)
Single barely-visible accent glow at top edge only:
```css
radial-gradient(ellipse 60% 30% at 50% 0%, rgba(74,158,255,0.035) 0%, transparent 50%)
```
No side gradients. No blue flood.

### Panel Glass Recipe
Applied to: sidebar, inspector, titlebar, toolbar, context menus, filter panel, settings panel.
```css
background: rgba(30, 30, 33, 0.78);
backdrop-filter: blur(24px) saturate(180%);
-webkit-backdrop-filter: blur(24px) saturate(180%);
border: 1px solid rgba(255, 255, 255, 0.07);  /* content-facing edge only */
```

### Radius & Shadow Tokens
| Token | Value |
|---|---|
| `--radius-md` | `8px` |
| `--radius-lg` | `12px` |
| `--radius-xl` | `18px` |
| `--shadow-sm` | `0 1px 4px rgba(0,0,0,0.6)` |
| `--shadow-md` | `0 4px 20px rgba(0,0,0,0.65)` |
| `--shadow-lg` | `0 8px 40px rgba(0,0,0,0.78)` |
| `--shadow-xl` | `0 24px 72px rgba(0,0,0,0.90)` |

---

## 2. Compact Sidebar

### Changes to `Sidebar.module.css`

**Brand header** — remove dedicated `brandHeader` section. Replace with a single slim line:
- Height: `32px`
- Padding: `0 14px`
- Content: tiny antler SVG (`opacity: 0.35`) + "STAG" wordmark (`9px`, `letter-spacing: 0.14em`, `opacity: 0.35`)
- Border-bottom: `1px solid var(--border)`
- This is purely decorative / wayfinding — visually very quiet

**Nav items** (Library section):
- Height: `28px` (was ~34px)
- Padding: `4px 10px 4px 12px`
- Font: `12px`, weight `450`
- Icon: `12px` SVG, `opacity: 0.65`
- Count badge: `10px`, smaller pill

**Section collapse headers:**
- Height: `26px`
- Padding: `5px 10px 5px 12px`
- Label: `9px`, `font-weight: 700`, `letter-spacing: 0.12em`, `opacity: 0.45`
- Chevron: `7px` SVG, `opacity: 0.5`
- No heavy section divider borders — just `6px` vertical gap between sections

**Folder rows:**
- Padding: `3px 8px 3px 8px`
- Indent per depth: `10px` (was `14px`)
- Font: `12px`

**Tag rows:**
- Padding: `3px 8px 3px 16px`
- Font: `12px`
- Tag dot: `5px` diameter

**Filter section:**
- Rating buttons: `10px` font, `3px 6px` padding
- Ext chips: `9px` font, `2px 5px` padding

**Visual:**
- Full glass recipe applied to `.sidebar`
- Active nav item: accent-dim background + `box-shadow: inset 2px 0 0 var(--accent)`
- Active folder row: same treatment
- Section dividers removed — breathing room via padding only

---

## 3. Slim Two-Row Toolbar

### Structure (`Toolbar.tsx` + `Toolbar.module.css`)

**Primary row** — `40px` tall, full visual weight:
```
[Folder title]  [count badge]          [search box]  [import button]
```
- Left: `h2.title` + `.count` badge (keep existing logic)
- Right: search box + import button only
- Selection actions appear here conditionally (same as now)

**Secondary row** — `28px` tall, subdued styling:
```
[size slider]  [sort select]  [sort direction]  [filter button]
```
- Background: `rgba(0,0,0,0.15)` overlay on the glass panel — slightly darker than primary row
- Font/icon size: `11px` / `11px` — everything 1 step smaller
- Opacity of controls: `0.7` default, `1.0` on hover
- Divider between rows: `1px solid rgba(255,255,255,0.04)`

**Glass treatment:**
- `.toolbar` gets full glass recipe
- Bottom border: `1px solid rgba(255,255,255,0.055)` + `box-shadow: 0 1px 0 rgba(0,0,0,0.4)`

**Import button:**
- Pill shape: `border-radius: var(--radius-xl)`
- Padding: `5px 14px`
- Font weight: `600`
- Box shadow: `0 2px 10px rgba(74,158,255,0.32)`

**Search box:**
- Height: `28px`
- Background: `rgba(0,0,0,0.25)` — slightly deeper inset feel inside the glass panel
- Border: `1px solid rgba(255,255,255,0.08)`
- Focus: accent border + `box-shadow: 0 0 0 3px var(--accent-dim)`

---

## 4. Asset Cards

**Default state:**
- Background: `var(--bg-card)`
- Box-shadow: `0 1px 3px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.04)`
- Border-radius: `var(--radius-lg)` (12px)

**Hover state:**
- Scale: `1.022`
- Box-shadow: `0 10px 34px rgba(0,0,0,0.6), 0 3px 10px rgba(0,0,0,0.38), inset 0 0 0 1px rgba(255,255,255,0.09)`
- Outline: `rgba(255,255,255,0.10)`
- Transition: `0.22s cubic-bezier(0.34, 1.46, 0.64, 1)`

**Selected state:**
- Outline: `2px solid var(--accent)`
- Box-shadow: `0 0 0 1px rgba(74,158,255,0.45), 0 0 20px rgba(74,158,255,0.20), 0 6px 22px rgba(0,0,0,0.5)`

**Ext badge:**
- Opacity: `0.75`
- Font: `9px`

**Masonry grid:**
- No changes — already fills container width correctly (full-width fix already shipped)
- Gap: stays `8px`

---

## 5. Inspector Panel

- Full glass recipe applied to `.panel`
- Left border: `1px solid rgba(255,255,255,0.07)` + `box-shadow: -1px 0 0 rgba(0,0,0,0.3)`
- Section labels (`.secLabel`): `9px`, `letter-spacing: 0.12em`, `opacity: 0.5`
- Tag chips: `border-radius: var(--radius-md)`, background `rgba(255,255,255,0.065)`, border `rgba(255,255,255,0.10)`
- Property rows: alternating very subtle bg `rgba(255,255,255,0.018)` on odd rows
- Notes textarea: background `rgba(0,0,0,0.25)`, border `rgba(255,255,255,0.08)`
- Footer buttons: same glass treatment, subtle hover

---

## 6. Titlebar

- Full glass recipe applied to `.titlebar`
- Bottom border: `1px solid rgba(255,255,255,0.055)` + `box-shadow: 0 1px 0 rgba(0,0,0,0.4)`
- App wordmark: antler SVG `opacity: 0.5` + "STAG" `opacity: 0.45`, `font-size: 10px`, `letter-spacing: 0.08em`
- AI toggle button: same styling as now, glass-consistent
- Window controls: macOS circles — keep exactly as-is

---

## 7. Typography

| Element | Size | Weight | Color |
|---|---|---|---|
| Folder title (toolbar) | `13px` | `600` | `--text-primary` |
| Nav item label | `12px` | `450` | `--text-secondary` |
| Sidebar section header | `9px` | `700` | `--text-muted` (opacity 0.45) |
| Card ext badge | `9px` | `800` | white |
| Inspector prop key | `11px` | `400` | `--text-muted` |
| Inspector prop value | `11px` | `400` | `--text-secondary` |
| Count badges | `10px` | `500` | `--text-muted` |

Font family: keep DM Sans (already loaded).

---

## 8. Shared Components (Context Menus, Toast, Filter Panel)

- Context menus: glass recipe + `border-radius: 14px` + `--shadow-lg`
- Toast notifications: glass recipe + accent/danger/success left border `3px`
- Filter panel dropdown: glass recipe + `border-radius: var(--radius-xl)`
- Settings panel: glass recipe + consistent section headers
- Lightbox modal overlay: `rgba(0,0,0,0.88)` — deeper black

---

## 9. Scrollbars

```css
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.07); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
```

---

## 10. Files to Modify

| File | Changes |
|---|---|
| `src/renderer/styles/global.css` | Full `:root` token rewrite, `#root` gradient, scrollbars |
| `src/renderer/components/TitleBar.module.css` | Glass recipe, wordmark styling |
| `src/renderer/components/Sidebar.module.css` | Full compact restructure + glass |
| `src/renderer/components/Sidebar.tsx` | Brand header → slim wordmark, tighten padding values |
| `src/renderer/components/Toolbar.module.css` | Two-row layout, glass recipe, button restyling |
| `src/renderer/components/Toolbar.tsx` | Split controls into primary/secondary rows |
| `src/renderer/components/AssetGrid.module.css` | Card default/hover/selected states |
| `src/renderer/components/Inspector.module.css` | Glass recipe, section labels, chips, notes |
| `src/renderer/components/MainContent.module.css` | Minor skeleton/empty state updates |
| `src/renderer/components/LightboxModal.module.css` | Deeper overlay |
| `src/renderer/styles/App.module.css` | Drop overlay styling update |

**No changes to:** store logic, IPC handlers, thumbnail engine, AI tagging, data model, lightbox functionality, drag-drop logic, keyboard navigation.

---

## 11. Success Criteria

- Background reads as neutral near-black — no blue, purple, or warm cast visible
- Sidebar, inspector, and toolbar panels are visibly distinct from the main bg via frosted glass
- All existing features work identically after the overhaul
- No whitespace issues in the masonry grid (already fixed)
- Sidebar fits more content in the same width — compact but readable
- Primary toolbar actions (search, import) are immediately visible without hunting
