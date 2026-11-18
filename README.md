# gelbooru-dux

A [Dux Shell](https://duxlabs.dev) (DMS) plugin that browses [Gelbooru](https://gelbooru.com). One composite plugin, several surfaces:

- **Its own window** — the viewer opens as a standard toplevel window, separate from the shell
- **Dock / taskbar** — a pill icon in the dock that opens the viewer
- **Applications browser** — an always-visible entry in the DMS launcher
- **Clock popup (dash)** — a card in the dash Overview grid plus a full gallery tab; clicking the card opens the tab
- **Control Center** — a tile that opens the gallery detail page (the closest surface to the user popup; DMS exposes no plugin hook for the user/session menu itself)

The viewer talks to the Gelbooru JSON API (`dapi`): tag search, thumbnail grid, click-to-view, rating filter.

## Features

- Tag search — any tag combination works, including meta-tags like `rating:general`
- Thumbnail grid with pagination
- Click a post to view it at full size
- Rating filter, defaulting to general (safe) content
- Configurable auto-refresh
- Settings panel integrated with Dux Shell settings, shared by every surface

## Requirements

- Dux Shell (DMS) >= 2.0.0 — the dash/dashCard surfaces and dock widget hosting landed in 2.0
- Plugin permissions: `network` for the API and images, `settings_read`/`settings_write` for settings

## Install

```bash
git clone <this repo> ~/.config/dms/plugins/gelbooru-dux
dms restart
```

Then: Settings → Plugins → **Scan for Plugins** → enable gelbooru-dux → `dms restart`.

On NixOS the same install can be declared with the `programs.dux-shell.plugins` option.

## Development

Symlink the repo into the plugin directory and live-reload while editing:

```bash
ln -sf ~/path/to/gelbooru-dux ~/.config/dms/plugins/gelbooru-dux
dms ipc call plugins reload gelbooru-dux
```

Open the gallery tab directly:

```bash
dms ipc call dash open plugin_gelbooru-dux
```

To see load errors, run the shell from a terminal: `dms kill && dms run`.

Note: brand-new QML files in an already-loaded plugin are not picked up by reload — `dms restart` after adding files.

## Layout

```
plugin.json           composite manifest (component map)
GelbooruDaemon.qml    persistent instance: owns the viewer window, the API client and shared state
GelbooruWindow.qml    the viewer window (FloatingWindow)
GelbooruPill.qml      bar/dock pill + Control Center tile (PluginComponent)
GelbooruLauncher.qml  launcher entry (QtObject)
GelbooruDashTab.qml   gallery tab in the dash (DashTabComponent)
GelbooruDashCard.qml  card in the dash Overview grid (DashCardComponent)
GelbooruSettings.qml  settings panel (PluginSettings)
```

## Configuration

| Setting | Description | Default |
|---|---|---|
| Tags | Tag query, any site-valid tags and meta-tags | `rating:general` |
| Rating filter | Which ratings the viewer may show; appended to the query | `general` |
| Refresh interval | Minutes between automatic refreshes | 10 |
| Grid columns | Thumbnails per row | 3 |

## References

- [DMS plugin development guide](https://duxlabs.dev/docs/dms/plugin-development)
- [dux-shell repo](https://github.com/duxlabs-dev/dux-shell) (reference plugins under `quickshell/PLUGINS/`)
- [Quickshell FloatingWindow](https://quickshell.org/docs/v0.3.0/types/Quickshell/FloatingWindow)
- [Gelbooru dapi help](https://gelbooru.com/index.php?page=help&topic=dapi)
