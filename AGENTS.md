# AGENTS.md

QML plugin for Dux Shell (DMS, formerly DankMaterialShell). No build step or test suite: Quickshell interprets QML at runtime, so verification means reloading the plugin in the shell and checking it renders.

Authoritative plugin API docs: <https://duxlabs.dev/docs/dms/plugin-development>. Consult them before using any DMS API (`PluginService`, `Theme`, `ToastService`, `PluginSettings`, `PluginGlobalVar`) rather than guessing signatures. Reference plugins live in `quickshell/PLUGINS/` in the [dux-shell repo](https://github.com/duxlabs-dev/dux-shell).

## Architecture

One `composite` plugin. The `daemon` component is the persistent instance and owns everything shared: the viewer window, the Gelbooru API client, and cross-surface state. Every other surface is thin — it reads plugin globals and asks the daemon to show the viewer. Do not duplicate state or API logic in a surface.

```
plugin.json           manifest with the component map
GelbooruDaemon.qml    daemon: viewer window lifecycle, API client, state
GelbooruWindow.qml    viewer window (FloatingWindow)
GelbooruPill.qml      bar/dock pill + Control Center tile (PluginComponent)
GelbooruLauncher.qml  launcher entry (QtObject)
GelbooruDashTab.qml   gallery tab in the dash (DashTabComponent)
GelbooruDashCard.qml  card in the dash Overview grid (DashCardComponent)
GelbooruSettings.qml  settings panel (PluginSettings)
```

Shared state between surfaces goes through `getGlobalVar` / `setGlobalVar` and reactive `PluginGlobalVar` bindings — never through files, globals outside the plugin, or per-surface copies.

## Manifest

- `id` is `gelbooru-dux`. The reload command (`dms ipc call plugins reload gelbooru-dux`), the dash tab id (`plugin_gelbooru-dux`) and every persistence key derive from it — never change it without updating all references.
- `type: "composite"` with a `components` map (`daemon`, `widget`, `launcher`, `dash`, `dashCard`), one shared `settings` QML.
- `requires_dms: ">=2.0.0"` — dash/dashCard surfaces and dock widget hosting (`surfaceContext`, `attachedContent`) are new in 2.0.
- `permissions`: `settings_read`, `settings_write`, `network`. Request nothing else.
- Validate changed fields against `plugin-schema.json` in the dms-plugin-registry repo.

## Surfaces

**Viewer window.** A Quickshell `FloatingWindow` (standard toplevel) instantiated from plugin QML. DMS's plugin docs do not bless opening windows — treat the first spike (daemon creates a visible FloatingWindow) as the riskiest assumption and prove it before building on it; if the shell context blocks toplevels, the fallback is the dock `attachedContent` panel or a `PopupWindow` anchored to the dash. The window carries the shell's app-id, so it will not map to a `.desktop` entry for dock pinning — dock presence is the widget pill, not the window.

**Bar/dock pill (`GelbooruPill.qml`).** Must define both `horizontalBarPill` and `verticalBarPill` (docks sit on any edge). Size with `root.iconSize` / `root.textSize`; gate timers on `surfaceLive`; use `widgetInstanceId` — multiple instances exist. Clicking the pill toggles the viewer window via the daemon. The same `PluginComponent` declares the Control Center tile: `ccWidgetIcon`, `ccWidgetPrimaryText`, `ccWidgetSecondaryText`, `ccWidgetIsActive`, `onCcWidgetToggled`, with `ccDetailContent` as the gallery detail page (tiles default to 4×1 cells).

**Launcher (`GelbooruLauncher.qml`).** Root is a `QtObject`, not an Item. `trigger: ""` makes the entry always visible in the launcher; `getItems(query)` returns `{name, icon ("material:…"), comment, action ("custom:open")}`; `executeItem(item)` opens the viewer. Call `pluginService.requestLauncherUpdate(pluginId)` after any async change.

**Dash (`GelbooruDashTab.qml` + `GelbooruDashCard.qml`).** The dash is the popup opened by the bar clock (`dms ipc call dash open plugin_gelbooru-dux`). The tab is a `DashTabComponent` with the full gallery; the card is a `DashCardComponent` in the Overview grid (6-column grid, 96 px rows, size via the `dash.card` manifest block). Clicking the card opens the tab automatically; if the tab is hidden from the tab bar it opens as a detail page.

## Widget contract (shared)

- Read `pluginData` with `??` fallbacks — surfaces render before settings load.
- Persisted settings via `pluginService.savePluginData` / `loadPluginData`; runtime-only state via `savePluginState` / `loadPluginState` (atomic, debounced, needs no permission). Never read or write the settings/state JSON files directly.

## QML conventions

- Colors, fonts and sizes come from the `Theme` singleton — no hardcoded values; the viewer must track the user's theme.
- Errors surface through `ToastService.showError(...)`: a short human sentence, no raw responses in the UI.
- Settings are declared with `ToggleSetting`/`SliderSetting`/`StringSetting`/`SelectionSetting`, each with `settingKey`, `label`, `defaultValue`.

## Gelbooru API

- Endpoint: `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1` with `tags`, `limit`, `pid`. The documented parameters work anonymously; `limit` is hard-capped at 100.
- Keep request frequency low: refresh on the configured interval only, never per interaction. The API client lives in the daemon so all surfaces share one request stream.
- Use `preview_url` for grid thumbnails and `file_url` for full-size view.
- Ratings are the meta-tags `rating:general`, `rating:sensitive`, `rating:questionable`, `rating:explicit`. The rating-filter setting is appended to the tag query, default `general`: surfaces render on the desktop without prior interaction, so defaults must never show anything above the filter — including in the viewer window and full-size view.

## Verification

- Live reload: `dms ipc call plugins reload gelbooru-dux`; list loaded plugins with `dms ipc call plugins list`; open the dash tab with `dms ipc call dash open plugin_gelbooru-dux`.
- Load failures: run `dms kill && dms run` from a terminal; check the component paths in `plugin.json` first.
- Brand-new QML files in an already-loaded plugin directory are not picked up by reload — `dms restart` instead of debugging reload.
- There is no headless check for QML rendering; a change is not done until every touched surface renders: the window, the pill in bar and dock (both orientations), the launcher entry, the dash card and tab, the Control Center tile.
