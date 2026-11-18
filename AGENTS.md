# AGENTS.md

QML plugin for Dux Shell (DMS, formerly DankMaterialShell). No build step or test suite: Quickshell interprets QML at runtime, so verification means reloading the plugin in the shell and checking it renders.

Authoritative plugin API docs: <https://duxlabs.dev/docs/dms/plugin-development>. Reference plugins live in `quickshell/PLUGINS/` in the [dux-shell repo](https://github.com/duxlabs-dev/dux-shell) — read them before using any DMS API rather than guessing signatures. The verified-in-this-repo API facts live in the sections below.

## Architecture

One `composite` plugin. The `daemon` component is the persistent instance and owns everything shared: the viewer window and the Gelbooru API client. Every other surface is thin.

**Shared state is `pluginData`** — it is reactive across all surfaces of a plugin (verified in the DashCounterExample, where a bar pill, a dash tab and a dash card share one counter through it). Writes go through `setData(key, value)` on surface components (`PluginComponent`, `DashTabComponent`, `DashCardComponent`) or `pluginService.savePluginData(pluginId, key, value)` where `setData` is unavailable (daemon, launcher). There is no other channel: no files, no direct JSON reads, no `PluginGlobalVar` unless a verified example shows it.

Keys written by surfaces (all live in `pluginData`): `viewerOpen`, `query`, `page`, `fetchTick`, plus settings keys written by the settings UI (`userId`, `apiKey`, `ratingFilter`, `refreshInterval`, `gridColumns`). Keys written only by the daemon: `posts`, `totalPages`, `loading`. The daemon is the only fetcher for **API requests** — surfaces request work by bumping `fetchTick` / changing `query` / `page`; **image downloads** go through the inline fetchers (see below).

```
plugin.json           composite manifest (component map)
GelbooruDaemon.qml    daemon: viewer window lifecycle, API client
GelbooruWindow.qml    viewer window (FloatingWindow)
GelbooruGallery.qml   gallery UI shared by the window and the dash tab; inline image fetcher
GelbooruPill.qml      bar/dock pill + Control Center tile (PluginComponent)
GelbooruLauncher.qml  launcher entry
GelbooruDashTab.qml   gallery tab in the dash (DashTabComponent)
GelbooruDashCard.qml  card in the dash Overview grid (DashCardComponent); inline image fetcher
GelbooruSettings.qml  settings panel (PluginSettings)
```

## Manifest

- `id` is `gelbooruDux`. The schema enforces `^[a-zA-Z][a-zA-Z0-9]*$` — camelCase, **no hyphens** (the repo/dir may keep `gelbooru-dux`; only the manifest id cannot). The reload command (`dms ipc call plugins reload gelbooruDux`), the dash tab id (`plugin_gelbooruDux`) and every persistence key derive from it.
- `capabilities` is required with at least one entry. Observed values in example plugins: `daemon`, `dankbar-widget`, `desktop-widget`, `control-center`, `dash-tab`, `dash-card`, `clipboard`, `command-execution`.
- `trigger` is required at top level whenever `components` includes a `launcher` key; `""` makes launcher items always visible.
- `dash.card` sizes: `w` 1–8, `h` ≥ 1; card widths clamp to the user's column count (3–8).
- `requires_dms: ">=1.7.0"` — floor for the dash surfaces and `Theme.floatingWindowSurface`. Hosting plugin widgets in docks requires 2.0.
- `permissions`: `settings_read`, `settings_write`, `network`. Request nothing else.
- Validate changed fields against `plugin-schema.json` in `quickshell/PLUGINS/` of the dux-shell repo.

## Imports and components

Verified import map:

- `QtQuick`, `Quickshell` (windows)
- `qs.Common` — `Theme`, `SessionData`
- `qs.Services` — `ToastService`
- `qs.DCommon.Widgets` — `DIcon`, `StyledText`, `DButton`, `DActionButton`, `DGridView`
- `qs.Modules.Plugins` — `PluginComponent`, `PopoutComponent`, `DashTabComponent`, `DashCardComponent`, `PluginSettings`

Do not invent `D*` component names or property signatures beyond what an example plugin or doc page shows. When no verified component fits, use QtQuick primitives (`TextInput`, `GridView`, `Flickable`, `Image`, `Rectangle`) — this repo deliberately avoids unverified wrappers.

Verified `Theme` properties in use: `floatingWindowSurface`, `hostSurface`, `chipSurface`, `onSurface`, `onSurfaceVariant`, `outline`, `primary`, `surfaceText`, `widgetIconColor`, `spacingXXS/XS/S/M/L`, `fontSizeSmall/Medium/Large`, `fontSizeDisplay`, `fontWeightMedium`, `iconSizeSmall/iconSize/iconSizeLarge`, `cornerRadiusM`, `buttonHeightM`, `fullRadius(width, height)`.

## Surfaces

**Viewer window (`GelbooruWindow.qml`).** Root is a Quickshell `FloatingWindow` (standard toplevel). The daemon declares it and binds `visible` to the `viewerOpen` plugin key; when the compositor closes it, the daemon writes `viewerOpen: false` back. DMS's plugin docs do not bless opening windows from plugin QML — this is the repo's riskiest assumption; if the shell context blocks toplevels, the fallback is the dock `attachedContent` panel. The window carries the shell's app-id, so it cannot be pinned to the dock like a `.desktop` app — dock presence is the widget pill.

**Bar/dock pill (`GelbooruPill.qml`).** One `PluginComponent` must define both `horizontalBarPill` and `verticalBarPill` (docks sit on any edge). Size with `root.iconSize` / `root.textSize`; gate timers on `surfaceLive`; multiple instances exist (`widgetInstanceId`). Click handling is `pillClickAction: (x, y, width, section, screen) => ...` (and `pillRightClickAction`). The same component declares the Control Center tile: `ccWidgetIcon`, `ccWidgetPrimaryText`, `ccWidgetSecondaryText`, `ccWidgetIsActive`, `ccWidgetIsToggle`, `onCcWidgetToggled` — action tiles set `ccWidgetIsToggle: false`. Declare `property var popoutService: null` only when actually calling it: the host injects by property name and assignment to a missing property errors.

**Launcher (`GelbooruLauncher.qml`).** Root is an `Item` (per LauncherExample, not a QtObject) with an injected `pluginService` and a declared `trigger` property; signals: `itemsChanged()`. `getItems(query)` returns `{name, icon ("material:…"), comment, action, categories}`; `executeItem(item)` parses the action string (`"custom:…"` for our own actions).

**Dash (`GelbooruDashTab.qml` + `GelbooruDashCard.qml`).** The dash is the popup opened by the bar clock (`dms ipc call dash open plugin_gelbooruDux`). A tab is a `DashTabComponent` that sizes itself through `implicitHeight`. A card is a `DashCardComponent` with `clickable: true`; it provides `accentColor`/`contentColor` and opens the plugin tab when clicked.

**Settings (`GelbooruSettings.qml`).** `PluginSettings` root with `pluginId: "gelbooruDux"`. Components: `StringSetting` (label/description/placeholder/defaultValue), `SelectionSetting` (options as `{label, value}`), `SliderSetting` (minimum/maximum/unit/startIcon/endIcon), `ToggleSetting`. Read settings anywhere via `pluginData.<settingKey> ?? default`.

## Widget contract (shared)

- Read `pluginData` with `??` fallbacks — surfaces render before settings load.
- Persisted settings and shared keys via `pluginService.savePluginData` / `loadPluginData`; runtime-only state via `savePluginState` / `loadPluginState` (atomic, debounced, needs no permission). Never read or write the settings/state JSON files directly.
- Errors surface through `ToastService.showError(title, message)`: a short human sentence, no raw responses in the UI.
- Colors, fonts and sizes come from the `Theme` singleton — no hardcoded values.

## Gelbooru API

- Endpoint: `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1` with `tags`, `pid`, optional `limit`. `pid` is 0-based. `limit` is hard-capped at 100 posts per request (documented).
- gelbooru.com requires credentials on every request: `&user_id=<numeric id>&api_key=<key>`. Anonymous requests return HTTP 401 (verified 2026-11-19). Both values are plugin settings (`userId`, `apiKey`); the daemon refuses to fetch without them. Never log or echo them.
- `safebooru.org` serves the same dapi anonymously, but returns a bare JSON array instead of `{"@attributes", "post"}` — the parser accepts both shapes.
- With `json=1` on gelbooru.com, when exactly one post matches, `post` is a single object, not an array — normalize before use. `@attributes.count` (total matches) drives the page count.
- Post fields used: `preview_url` (grid thumbnails), `file_url` (full-size view), `width`, `height`, `score`, `rating`, `tags` (space-separated).
- The image hosts (`img*.gelbooru.com`) 302-redirect every request lacking `Referer: https://gelbooru.com/` to a hotlink-block page (verified 2026-11-19). QML `Image` cannot set request headers, so **all image loading goes through the inline fetchers** in `GelbooruGallery.qml` and `GelbooruDashCard.qml`: XHR with the Referer header, `responseType: "arraybuffer"`, converted to a `data:image/jpeg;base64,…` data URL for `Image.source`. Never bind an `Image` straight to a gelbooru URL.
- Keep that logic **inline in the QML** — do not split it into a `.pragma library` JS file: external script imports from plugin QML failed in the running shell with `File name case mismatch` (observed 2026-11-19, plugin reload path). Full-size `file_url` fetches pass `cacheable = false`; video files (mp4/webm/…) cannot render in `Image` — the detail view shows a placeholder instead.
- Tags are space-separated in the query string: encode each tag with `encodeURIComponent` and join with `+`.
- Ratings are the meta-tags `rating:general`, `rating:sensitive`, `rating:questionable`, `rating:explicit` with rank order 0–3. The `ratingFilter` setting is appended to the query, default `general`, **and** enforced again client-side by rank — surfaces render on the desktop without prior interaction, so nothing above the filter may render anywhere, including the viewer window.

## Verification

- Live reload: `dms ipc call plugins reload gelbooruDux`; list loaded plugins with `dms ipc call plugins list`; open the dash tab with `dms ipc call dash open plugin_gelbooruDux`.
- Syntax check with `/usr/lib/qt6/bin/qmllint` (6.x). The plain `qmllint` on PATH is Qt 5.15 and dies silently (exit 255, no output) on `?.` optional chaining — every surface file uses it. Unresolved `qs.*` import warnings are expected outside the shell runtime; only exit code and syntax errors matter.
- Load failures: run `dms kill && dms run` from a terminal; check the component paths in `plugin.json` first.
- Brand-new QML files in an already-loaded plugin directory are not picked up by reload — `dms restart` instead of debugging reload.
- There is no headless check for QML rendering; a change is not done until every touched surface renders: the window, the pill in bar and dock (both orientations), the launcher entry, the dash card and tab, the Control Center tile.
