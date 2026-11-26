# Gelbooru Viewer

A small desktop app for browsing [Gelbooru](https://gelbooru.com): tag search, a masonry thumbnail grid, and a keyboard-friendly lightbox. It's a personal project, currently Linux-only.

> Unofficial and not affiliated with or endorsed by Gelbooru. You need your own Gelbooru account to use it, and you're responsible for complying with the site's terms.

[DESIGN.md](DESIGN.md) is the UI/UX contract — screens, interactions, and visual language.

## Features

- Tag search with any site-valid query (negations, `sort:`, meta-tags), autocomplete, and a searchable history
- Masonry grid with natural aspect thumbnails and infinite scroll
- Lightbox with sample/original toggle, zoom & pan, video playback, and tag chips
- Rating filter (General by default), always visible in the top bar
- Downloads, open-in-browser, and a clearable disk cache
- Dark/light/system theme and remembered window geometry

## Requirements

- A Gelbooru account with an API key. The API rejects anonymous requests; the app asks for your numeric user ID and key on first run.
- Linux with WebKitGTK 4.1 (on Arch: `webkit2gtk-4.1`). Other platforms haven't been tested.
- To build: Node.js `^20.19 || >=22.12`, npm, Rust 1.90+, and the [Tauri v2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

## Build

```bash
git clone <your-repo-url> gelbooru-viewer
cd gelbooru-viewer
npm install
npm run app:build
```

The release binary is `src-tauri/target/release/gelbooru-viewer`; installable bundles are written alongside it. If you build the Rust backend directly, pass the production feature:

```bash
cd src-tauri
cargo build --release --features custom-protocol
```

Without `--features custom-protocol`, the binary expects the Vite dev server on `localhost:5173` and shows a connection error instead of the UI.

## Development

```bash
npm run app:dev   # Vite dev server + window with live reload
npm run build     # bundle the frontend into dist/ only
```

## Keyboard shortcuts

Anywhere (outside a text field):

| Keys | Action |
| --- | --- |
| `/` or `Ctrl+K` | Focus and select the search field |
| `←` / `→` or `h` / `l` | Open the lightbox at the first/last post, then step through posts |
| `Alt+←` / `Alt+→` | Back / forward through browsing history |
| `Home`, `PageUp`, `PageDown` | Scroll the grid |
| `Ctrl+=` / `Ctrl+-` | Fewer / more grid columns |
| `Esc` | Close popovers and settings |

In the lightbox:

| Keys | Action |
| --- | --- |
| `←` / `k` / `h` / `PageUp` | Previous post |
| `→` / `j` / `l` / `PageDown` | Next post |
| `m` | Toggle sample / original |
| `Ctrl+O` | Open in browser |
| `Esc` | Close |

## Where things are stored

- Account credentials, settings, and the last 20 searches live in browser `localStorage` under `gelbooru-viewer:*`. Nothing is sent anywhere except Gelbooru.
- Media is cached in `~/.local/share/com.desu.gelbooruviewer/images/`. Use **Settings → Clear image cache** to empty it.
- Download and serving problems are logged to `~/.local/share/com.desu.gelbooruviewer/fetch.log`.

## How it works

Posts and tag suggestions come from Gelbooru's dapi with your credentials on every request. A single selected rating is sent to the API as a `rating:` tag; multiple ratings are filtered locally because duplicate `rating:` tags return no results. The Rust backend downloads media with the referer Gelbooru's image hosts require, validates it, and caches it on disk; the UI reads images through a local custom protocol and videos through a loopback HTTP server.

## License

[MIT](LICENSE) — do what you like, but keep the copyright notice.
