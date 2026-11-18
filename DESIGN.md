# Gelbooru Viewer — UI/UX Design

Standalone desktop app (Tauri v2: Rust backend + web frontend) for browsing Gelbooru. This document is the implementation contract: screens, interactions, visual language, states, and the data behavior the UI depends on. v1 scope only — see Deferred.

## 1. Goals

1. **Browsing-first.** The grid is the app. Chrome stays out of the way; one screen does the work.
2. **Fast to a picture.** Search is always one keystroke away (`/`), thumbnails stream in lazily, the layout never shifts while they load.
3. **Safe by default.** The rating filter defaults to *General* and its state is always visible in the top bar — no surprises on a desktop that others can see.
4. **Native desktop citizen.** Own window, remembered geometry, `.desktop` entry (taskbar + applications browser), respects Wayland tiling.
5. **Keyboard-complete.** Everything reachable without the mouse.

## 2. Information architecture

Deliberately shallow — one screen and two overlays:

```
Gallery (the app)
├── Lightbox (overlay: full image + post info)
├── Settings (slide-over panel)
└── First-run setup card (replaces the grid content until the account is connected)
```

No routing, no pages to navigate between; the back gesture means "close the overlay" or "restore previous search".

## 3. Screens

### 3.1 Gallery

```
┌────────────────────────────────────────────────────────────────────┐
│ [ 🔍 search: touhou -explicit            ▾ ]  [G ▾]  ↻   ⚙       │ top bar, 48px
├────────────────────────────────────────────────────────────────────┤
│ ┌────┐ ┌──────────┐ ┌────┐  ┌────────┐ ┌───┐                      │
│ │    │ │          │ │    │  │        │ │   │                      │
│ │img │ │   img    │ │img │  │  img   │ │img│   masonry, natural   │
│ │    │ └──────────┘ └────┘  │        │ └───┘   aspect, 2–6 cols  │
│ └────┘  1.2k (Q)  87 (S)    └────────┘  23 (G)                    │
│   12 (G)                     4.2k (G)                              │
│ ┌──────────┐ ┌────┐  ┌────┐  ┌───┐                                 │
│ │ skeleton │ │img │  │img │  │img │   ← shimmer cells at known   │
│ └──────────┘ └────┘  └────┘  └───┘     aspect while loading      │
│                                                                    │
│                                                        ┌───┐      │
│                                                        │ ↑ │      │ floating "back
│                                                        └───┘      │ to top" after
│  · · · page 3 · · ·                                                │ 3+ screens
└────────────────────────────────────────────────────────────────────┘
```

**Top bar** (fixed, 48px, same background as page):
- **Search field** — takes any site-valid query verbatim (tags, `-negate`, `sort:`, meta-tags). Left icon; clear (✕) when non-empty; **▾** opens search history (last 20 queries, most recent first, persisted; click to re-run, ✕ per row to forget).
- **Rating chip `[G ▾]`** — always visible, shows the *loosest* currently allowed rating. Opens a popover with four checkboxes (General / Sensitive / Questionable / Explicit); default only General. Multi-select is allowed; the mechanism that keeps it correct is in §7.
- **Refresh** — re-fetches the current page(s) from page 0 of the current query.
- **Settings** — opens the slide-over (§3.3).

**Grid** — masonry columns, natural aspect ratio per cell (2–6 columns, slider in settings, default 3). Cells:
- Thumbnail = `preview_url` at native size, `border-radius: 8px`, 8px gutters.
- Aspect ratio is reserved from post metadata (`preview_width/height`, falling back to full `width/height`) so images fill pre-sized boxes — **zero layout shift**.
- **Hover overlay** (bottom gradient): score (e.g. `1.2k`), rating badge letter, resolution (`1600×1200`). Hidden when not hovered — the grid stays clean.
- **Click** → lightbox. **Middle-click / Ctrl+click** → open the post on gelbooru.com in the browser. **Right-click** → context menu: Open in browser / Copy post URL / Copy image URL.

**Scrolling** — infinite scroll; the next API page is fetched when the last rendered row comes within ~2 viewport heights. A small `page N` pill fades in for a moment whenever a new page lands. After 3+ screens of scrolling, a floating **↑** button appears (bottom-right).

**States** (§8 matrix): skeletons while the first page loads; "No posts for this search" empty state with a hint to loosen the query or rating filter; inline error banner with Retry; if no API credentials are configured, the grid area is replaced by the setup card (§3.4).

### 3.2 Lightbox (post detail)

```
┌────────────────────────────────────────────────────────────────────┐
│ ←                                                        ↗   ⭳  ✕ │
│                                                                    │
│ │                        image, fit to window                     ││
│ │←                                       (hover zones)           →││
│ │                                                                  ││
├────────────────────────────────────────────────────────────────────┤
│ ★ 4,231 · (E) explicit · 2400×3200 · 2026-01-05        [Original] │
│ character_tag  artist_tag  copyright_tag  general_tag  …           │
└────────────────────────────────────────────────────────────────────┘
```

- Opens as a full-window overlay over the grid; the grid keeps its scroll position underneath.
- **Image**: the `sample_url` when the post has one, else `file_url` — fit to window. **Original** button swaps in `file_url` (full size); double-click toggles 100% zoom with drag-to-pan; mouse wheel scrolls normally when fit, zooms when at 100%.
- **Header row**: ← back (ESC), open in browser (↗), download (⭳ — save dialog, writes the original file), close (✕).
- **Navigation**: ‹ › hover zones on the edges + `←`/`→`/`j`/`k` step through the current result list; the info line updates in place. Reaching the end of the loaded list fetches the next page automatically.
- **Info line**: score, rating badge, dimensions, date; **[Original]** toggle when a sample exists.
- **Tags** as chips (flat list; the API provides no type grouping). **Click** = search that tag; **Ctrl+click** = append to the current query; **Shift+click** = append negated (`-tag`).
- Video posts (`mp4/webm/mov`): image area shows "Video — open in browser" with the ↗ action; no playback in v1.

### 3.3 Settings (slide-over, right side, 360px)

```
                              ┌──────────────────────────┐
                              │ Settings              ✕  │
                              │ ── Account ─────────────│
                              │ User ID   [ 12345     ] │
                              │ API key   [ •••••••••• ]│
                              │ [Check connection] ✓ ok │
                              │ ── Content ─────────────│
                              │ Ratings  ☑G ☐S ☐Q ☐E    │
                              │ ── View ────────────────│
                              │ Columns      [──●──] 3  │
                              │ Theme      [system ▾]   │
                              │ ── Behavior ────────────│
                              │ Page size  [50 ▾]       │
                              │ Remember last search ✓  │
                              └──────────────────────────┘
```

Changes apply live; everything persists locally. "Check connection" runs a 1-post API request and shows ✓ ok / the error inline. Theme: dark (default) / light / follow system.

### 3.4 First-run setup card

Until valid credentials exist, the grid area shows one card instead of the app chrome being locked behind a modal:

```
┌──────────────────────────────────────────────────┐
│  Connect your Gelbooru account                   │
│                                                  │
│  The Gelbooru API rejects anonymous requests.    │
│  1. Log in at gelbooru.com → Settings → API      │
│  2. Create an API key, copy it and your user ID. │
│                                                  │
│  User ID  [                    ]                 │
│  API key  [                    ]                 │
│                                                  │
│  [ Check & start browsing ]                      │
└──────────────────────────────────────────────────┘
```

Success → card collapses and the grid loads with the default query. Failure (401/429/network) → inline message under the button, values kept. The card also reappears by itself if a later request comes back 401 (key revoked).

## 4. Interaction & keyboard map

| Input | Context | Action |
|---|---|---|
| `/` or `Ctrl+K` | anywhere | focus search field |
| `Enter` | search field | run search (page 0) |
| `ESC` | lightbox / settings / popover | close it |
| `←` `→` or `j` `k` | lightbox | previous / next post |
| `m` | lightbox | toggle original / sample |
| `Ctrl+O` | lightbox | open post in browser |
| Middle-click / `Ctrl+click` | grid cell | open post in browser |
| Click / `Ctrl+click` / `Shift+click` | tag chip | search tag / append / append negated |
| `↑` button / `Home` | grid | back to top |
| Mouse back | lightbox | close (returns to grid) |

## 5. Visual language

- **Theme**: dark by default; surfaces `#101014` (page) / `#1a1a20` (cards, top bar); text `#e7e7ea` primary, `#9a9aa2` secondary; hairline borders `#2a2a31`. Light theme mirrors with neutral grays. System accent avoided — one restrained blue accent `#7c9cff` for focus rings, active states, links.
- **Rating badges** (industry convention, instantly readable): G = `#22c55e`, S = `#3b82f6`, Q = `#f59e0b`, E = `#ef4444`. Rendered as a single letter on hover overlays and always in the lightbox info line.
- **Type**: system UI font stack; 14px base, 13px metadata, 12px chips/badges. No decorative typography.
- **Shape & motion**: 8px radius on cells and cards, 48px top bar, 8px gutters. Motion kept minimal: overlay fade 120ms, skeleton shimmer; `prefers-reduced-motion` disables shimmer and transitions.
- **No filler**: no placeholder art, emoji decoration, or empty-flavor copy. Empty/error states state the fact and the next action.

## 6. Components inventory

`TopBar` · `SearchField` (with history popover) · `RatingChip` + popover · `MasonryGrid` · `PostCell` (thumbnail + hover overlay + context menu) · `SkeletonCell` · `Lightbox` · `InfoLine` · `TagChips` · `SettingsPanel` · `SetupCard` · `Banner` (error/rate-limit, inline, dismissible) · `PagePill` · `BackToTop`.

## 7. Data behavior the UI depends on

- **Pages**: dapi `page=dapi&s=post&q=index&json=1`, `limit` = page size (25/50/100, default 50, hard cap 100), `pid` = 0-based page index. Infinite scroll appends pages.
- **Credentials**: `user_id` + `api_key` params on every request; 401 surfaces the setup card, never a silent failure.
- **Rating filter**: one rating selected → appended as a `rating:` tag (server-side, exact). Multiple selected → requested **without** rating tags and filtered client-side by rating rank (general < sensitive < questionable < explicit), because duplicate `rating:` meta-tags AND to zero results.
- **Images**: all gelbooru image hosts require `Referer: https://gelbooru.com/`; the Rust backend downloads with that header into a disk cache keyed by the URL's file name (`~/.local/state/gelbooru-viewer/cache/`), and the webview loads cached files through the asset protocol. Thumbnails (`preview_url`) are fetched eagerly per rendered row; full-size (`sample_url`/`file_url`) on demand. Failed downloads show an error tile, never a broken `<img>` icon.
- **Cache**: served-if-present, else download. No auto-pruning in v1; a "Clear image cache" entry lives at the bottom of Settings.
- **429 / rate limit**: banner "Rate limited — retrying in Ns" with automatic exponential backoff; manual Retry always available.

## 8. State matrix

| Surface | Loading | Empty | Error |
|---|---|---|---|
| Grid | skeleton cells at known aspect | "No posts for this search" + hint | inline banner + Retry |
| Credentials missing | — | setup card replaces grid | card shows the failure inline |
| Lightbox image | spinner over reserved aspect box | — (post exists) | banner + Retry |
| Any API call | — | — | 401 → setup card; 429 → backoff banner; other → banner |

## 9. Window & integration

- App name **Gelbooru Viewer**; default window 1100×720, minimum 720×480; geometry persisted; dark titlebar.
- `.desktop` entry (`gelbooru-viewer`) → window, taskbar/dock, applications browser.
- The DMS clock-popup/Control Center widgets from the plugin experiment are out of scope for the app; a tiny companion DMS plugin (overview card that just launches this app) can be added later if wanted.

## 10. Deferred (not v1)

Tag autocomplete (dapi `s=tag`), favorites/voting (account write API), blacklists, slideshow, safebooru.org as an alternate board, video playback, hover-play previews, download-all, per-tag saved searches. Named here so they're consciously out, not forgotten.
