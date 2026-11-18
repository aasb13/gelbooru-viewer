# Gelbooru Viewer

A native desktop app for browsing [Gelbooru](https://gelbooru.com) — tag search, masonry thumbnail grid, lightbox viewing, rating filter. Built with [Tauri v2](https://tauri.app): Rust backend, web frontend.

- [DESIGN.md](DESIGN.md) is the UI/UX contract (screens, interactions, visual language).

## Features

- Tag search with any site-valid query (negations, `sort:`, meta-tags) plus a searchable history
- Masonry grid with natural aspect thumbnails and infinite scroll
- Lightbox with sample/original toggle, zoom & pan, keyboard navigation (`←`/`→`/`j`/`k`), tag chips
- Rating filter (defaults to General), always visible in the top bar
- Image downloads, open-in-browser, clearable disk cache
- Dark/light/system theme, remembered window geometry

## Requirements

- A Gelbooru account: the API rejects anonymous requests, so the app asks for your numeric user ID and API key on first run (account settings → API on gelbooru.com)
- Linux with WebKitGTK (the runtime Tauri uses; on Arch: `webkit2gtk-4.1`)

## Build & install

```bash
npm install
npm run app:build        # release build + bundles in src-tauri/target/release
```

The release binary is `src-tauri/target/release/gelbooru-viewer`. For development with live reload:

```bash
npm run app:dev
```

## How it talks to Gelbooru

- API: `page=dapi&s=post&q=index&json=1` with `user_id` + `api_key` on every request (anonymous requests get HTTP 401)
- Images: gelbooru's image hosts require `Referer: https://gelbooru.com/` — the Rust backend downloads with that header into a disk cache (`~/.local/share/com.desu.gelbooruviewer/images/`), served to the UI over a custom `gvcache://` protocol
- The rating filter is appended as a `rating:` tag for a single selection, and filtered client-side for multiple selections (duplicate `rating:` meta-tags AND to zero results)
