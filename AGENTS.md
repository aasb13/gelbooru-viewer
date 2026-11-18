# AGENTS.md

Tauri v2 desktop app (Rust backend + vanilla JS web frontend) for browsing Gelbooru. [DESIGN.md](DESIGN.md) is the UI/UX contract — screens, interactions, states and visual language live there; keep implementation and design in sync, and update DESIGN.md when a behavior changes.

## Commands

- `npm run build` — bundle the frontend (vite, output `dist/`)
- `npm run app:build` — release build of the whole app (binary: `src-tauri/target/release/gelbooru-viewer`)
- `npm run app:dev` — run with live reload (needs a display; spawns vite + the shell window)
- `cargo build` inside `src-tauri/` — compile the backend only
- Lint the frontend with `npx eslint` if configured — there is no linter config in this repo; verification is the builds plus manual UI testing

## Architecture

```
src-tauri/src/lib.rs    all backend logic: API client, image fetcher, cache protocol
src/main.js             app wiring: search, rating filter, banners, backoff, keyboard map
src/grid.js             MasonryGrid: absolute-positioned masonry, IntersectionObserver thumbs
src/lightbox.js         full-window overlay: sample/original, zoom/pan, tags, download
src/settings.js         slide-over panel: account, content, view, behavior
src/state.js            settings + search history in localStorage, theme resolution
src/api.js              invoke wrappers; gvcache:// URL builder
```

Backend commands (invoked from JS): `fetch_posts`, `download_image`, `download_file`, `clear_cache`. Errors are `{kind, detail}` objects — kinds: `auth`, `rate_limited`, `network`, `server`, `blocked`, `internal`. The UI maps `auth` → setup card, `rate_limited` → auto-backoff banner (30s doubling to 120s), everything else → inline banner.

## Gelbooru facts (verified 2026-11-19)

- API: `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1` with `pid` (0-based), `limit` (hard cap 100), `tags` (space-separated → encode each token, join with `+`), plus `user_id` + `api_key` on **every** request — anonymous requests get HTTP 401.
- The `post` field is an array normally, a single object when exactly one post matches, absent when empty. `@attributes.count` drives the "load more" end condition.
- Image hosts (`img*.gelbooru.com`) 302-redirect requests without `Referer: https://gelbooru.com/` to a hotlink-block page. **Qt/QML could never send this header; the Rust fetcher can** — every image download goes through `fetch_image_bytes` (Referer + UA + magic-byte validation so an HTML block page can never masquerade as an image).
- Ratings: `general`/`sensitive`/`questionable`/`explicit` (rank 0–3); old numeric ratings are normalized in `normalize_rating`.
- The rating filter: single selection → appended server-side as `rating:x`; multiple → fetched unfiltered and filtered client-side, because duplicate `rating:` meta-tags AND to zero results. Default must stay `general` — the grid renders without prior interaction.

## Conventions

- The UI never fetches images itself: it renders `gvcache://localhost/<name>` URLs produced by `download_image`. The custom protocol serves the app-data cache dir (`~/.local/share/com.desu.gelbooruviewer/images/`) and sanitizes file names — keep that sanitization.
- Settings and search history live in localStorage (`gelbooru-viewer:*` keys); nothing is written outside the app-data dir.
- Window geometry is persisted by `tauri-plugin-window-state`; capabilities in `src-tauri/capabilities/default.json` must list every plugin permission the frontend uses.
- Rust commands do blocking HTTP inside `spawn_blocking`; never block the main thread.
- Keep dependencies minimal: vanilla JS, no frontend framework.
