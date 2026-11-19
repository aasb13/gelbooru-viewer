import { cachedMedia, downloadToDisk, onMediaProgress, postUrl, prepareMedia } from "./api.js";
import { ratingBadge } from "./grid.js";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v)(\?|$)/i;

const el = {
  root: document.getElementById("lightbox"),
  img: document.getElementById("lb-img"),
  ghost: document.getElementById("lb-img-ghost"),
  video: document.getElementById("lb-video"),
  stage: document.getElementById("lb-stage"),
  videoNote: document.getElementById("lb-video-note"),
  spinner: document.getElementById("lb-spinner"),
  prev: document.getElementById("lb-prev"),
  next: document.getElementById("lb-next"),
  back: document.getElementById("lb-back"),
  close: document.getElementById("lb-close"),
  browser: document.getElementById("lb-browser"),
  download: document.getElementById("lb-download"),
  originalBtn: document.getElementById("lb-original"),
  metaline: document.getElementById("lb-metaline"),
  tags: document.getElementById("lb-tags"),
};

let list = [];
let index = -1;
let currentUrl = "";
let loadToken = 0;
let needMore = null;
let onClose = null;
let onStep = null;
let pan = { x: 0, y: 0 };
let showingOriginal = false;
let mediaKind = "image";
let mediaError = false;
let noteTimer = null;
// Download progress per cache name, updated by backend events; drives the
// progressive image repaint.
const progress = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isOpen() {
  return !el.root.hidden;
}

export function open(posts, start, hooks) {
  list = posts;
  index = Math.max(0, Math.min(start, posts.length - 1));
  needMore = hooks?.needMore ?? null;
  onClose = hooks?.onClose ?? null;
  onStep = hooks?.onStep ?? null;
  el.root.hidden = false;
  show(index);
}

export function close() {
  el.root.hidden = true;
  el.video.pause();
  list = [];
  index = -1;
  onClose?.();
}

function current() {
  return list[index] || null;
}

function clearMedia() {
  // Hide the previous media and reset it while the next one loads, so a
  // stale frame (and a stale GIF animation) is never shown.
  el.img.removeAttribute("src");
  el.img.hidden = true;
  el.video.pause();
  el.video.removeAttribute("src");
  el.video.load();
  el.video.hidden = true;
  el.videoNote.hidden = true;
  el.ghost.removeAttribute("src");
  el.ghost.hidden = true;
  mediaError = false;
  clearTimeout(noteTimer);
  // Invalidate any in-flight load and ignore the error event that
  // resetting the video element may emit.
  return ++loadToken;
}

function show(i) {
  index = Math.max(0, Math.min(i, list.length - 1));
  onStep?.(index);
  const post = current();
  if (!post) return;
  resetZoom();
  renderInfo(post);
  const token = clearMedia();

  const isVideo = VIDEO_RE.test(post.fileUrl || "");
  mediaKind = isVideo ? "video" : "image";
  showingOriginal = false;
  el.originalBtn.hidden = isVideo || !post.sampleUrl;
  el.originalBtn.textContent = "Original";

  const url = isVideo
    ? post.fileUrl
    : post.sampleUrl || post.fileUrl || "";
  currentUrl = url;

  if (!url) {
    el.spinner.hidden = true;
    return;
  }
  if (!isVideo) setupGhost(post, url, token);
  loadMedia(url, token, isVideo);
}

async function loadMedia(url, token, isVideo) {
  el.spinner.hidden = false;
  let prep;
  try {
    prep = await prepareMedia(url);
  } catch {
    if (token === loadToken) showLoadError(token);
    return;
  }
  if (token !== loadToken) return;
  const src = "gvcache://localhost/" + prep.name;
  if (isVideo) {
    // The protocol serves whatever prefix is on disk, so playback starts
    // while the rest is still downloading.
    el.video.src = src;
    el.video.hidden = false;
    el.spinner.hidden = true;
    el.video.play().catch(() => {});
    return;
  }
  if (prep.cached || progress.get(prep.name)?.done) {
    el.img.src = src;
    el.img.hidden = false;
    el.spinner.hidden = true;
    return;
  }
  paintProgressive(prep.name, src, token);
}

// Cached smaller variant shown under the loading full-size image; the
// growing prefix paints over it as bytes arrive.
async function setupGhost(post, primaryUrl, token) {
  for (const candidate of [post.sampleUrl, post.previewUrl]) {
    if (!candidate || candidate === primaryUrl) continue;
    const name = await cachedMedia(candidate).catch(() => null);
    if (token !== loadToken) return;
    if (name) {
      el.ghost.src = "gvcache://localhost/" + name;
      el.ghost.hidden = false;
      el.spinner.hidden = true;
      return;
    }
  }
}

const REPAINT_MIN_BYTES = 64 * 1024;

// Repaints the full-size image from its growing on-disk prefix: ranged
// fetches plus a decode test. A prefix that does not decode yet (PNG/WebP
// mid-stream) keeps the placeholder until enough has arrived; a decodable
// one (JPEG) reveals top-down as it grows.
async function paintProgressive(name, finalSrc, token) {
  let blobUrl = null;
  const parts = [];
  let painted = 0;
  for (;;) {
    await delay(120);
    if (token !== loadToken) break;
    const p = progress.get(name);
    if (!p) continue;
    if (p.failed) {
      showLoadError(token);
      break;
    }
    if (p.done) {
      el.img.src = finalSrc;
      el.img.hidden = false;
      el.spinner.hidden = true;
      break;
    }
    const step = Math.max(REPAINT_MIN_BYTES, (p.total || 0) / 50);
    if (p.received - painted < step) continue;
    const res = await fetch(`gvcache://localhost/${name}`, {
      headers: { Range: `bytes=${painted}-` },
    }).catch(() => null);
    if (token !== loadToken) break;
    if (!res) continue;
    if (res.status === 404) {
      showLoadError(token);
      break;
    }
    if (!res.ok && res.status !== 206) continue;
    const buf = await res.arrayBuffer();
    if (token !== loadToken) break;
    if (buf.byteLength === 0) continue;
    painted += buf.byteLength;
    parts.push(buf);
    if (typeof createImageBitmap !== "function") continue;
    const blob = new Blob(parts);
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
    } catch {
      continue;
    }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);
    el.img.src = blobUrl;
    el.img.hidden = false;
    el.spinner.hidden = true;
  }
  if (blobUrl) URL.revokeObjectURL(blobUrl);
}

function showLoadError(token) {
  if (token !== loadToken) return;
  mediaError = true;
  el.spinner.hidden = true;
  el.img.hidden = true;
  el.video.hidden = true;
  el.videoNote.replaceChildren();
  const label = document.createElement("span");
  label.textContent = "Media failed to load.";
  const retry = document.createElement("button");
  retry.className = "btn";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => show(index));
  el.videoNote.append(label, retry);
  el.videoNote.hidden = false;
}

// Transient status (download failures); never clobbers a media error note.
function flashNote(text) {
  if (mediaError) return;
  clearTimeout(noteTimer);
  el.videoNote.textContent = text;
  el.videoNote.hidden = false;
  noteTimer = setTimeout(() => {
    el.videoNote.hidden = true;
  }, 3000);
}

function renderInfo(post) {
  el.metaline.innerHTML = "";
  const badge = ratingBadge(post);
  const star = document.createElement("span");
  star.className = "ms star-icon";
  star.textContent = "star";
  const parts = [
    `${post.score.toLocaleString()}`,
    post.rating || "?",
    `${post.width}×${post.height}`,
    post.createdAt,
  ];
  const text = document.createElement("span");
  text.textContent = parts.join(" · ");
  el.metaline.append(badge, star, text);

  el.tags.innerHTML = "";
  for (const tag of (post.tags || "").split(/\s+/).filter(Boolean)) {
    const chip = document.createElement("button");
    chip.className = "tag-chip";
    chip.textContent = tag;
    chip.addEventListener("click", (e) => onTagClick?.(e, tag));
    el.tags.appendChild(chip);
  }
}

let onTagClick = null;
export function setTagHandler(handler) {
  onTagClick = handler;
}

export function step(delta) {
  const target = index + delta;
  if (target < 0) return;
  if (target >= list.length) {
    needMore?.();
    return;
  }
  show(target);
}

function resetZoom() {
  pan = { x: 0, y: 0 };
  el.img.classList.remove("zoomed", "grabbing");
  el.img.style.transform = "";
}

export function toggleZoom() {
  if (mediaKind !== "image" || el.img.hidden || !el.img.src) return;
  if (el.img.classList.contains("zoomed")) {
    resetZoom();
    return;
  }
  if (!el.img.naturalWidth || !el.img.naturalHeight) return;
  el.img.classList.add("zoomed");
  // object-fit letterboxes the element box, so 1:1 must be computed against
  // the rendered image width, not the box width.
  const aspect = el.img.naturalWidth / el.img.naturalHeight;
  const renderedWidth = Math.min(
    el.img.clientWidth,
    el.img.clientHeight * aspect,
  );
  const scale = Math.max(1, el.img.naturalWidth / Math.max(renderedWidth, 1));
  pan = { x: 0, y: 0 };
  el.img.style.transform = `scale(${scale})`;
}

export function toggleOriginal() {
  const post = current();
  if (!post?.sampleUrl) return;
  showingOriginal = !showingOriginal;
  el.originalBtn.textContent = showingOriginal ? "Sample" : "Original";
  resetZoom();
  const token = clearMedia();
  const url = showingOriginal ? post.fileUrl : post.sampleUrl;
  setupGhost(post, url, token);
  loadMedia(url, token, false);
}

function setupEvents() {
  el.close.addEventListener("click", close);
  el.back.addEventListener("click", close);
  el.prev.addEventListener("click", () => step(-1));
  el.next.addEventListener("click", () => step(1));
  el.originalBtn.addEventListener("click", toggleOriginal);
  el.browser.addEventListener("click", () => openInBrowser());
  el.download.addEventListener("click", async () => {
    const post = current();
    if (!post?.fileUrl) return;
    const ext = (post.fileUrl.match(/\.([a-z0-9]+)(\?|$)/i) || [])[1] || "jpg";
    try {
      const dest = await save({
        defaultPath: `${post.id}.${ext}`,
        filters: [{ name: "Image", extensions: [ext] }],
      });
      if (!dest) return;
      await downloadToDisk(post.fileUrl, dest);
    } catch {
      flashNote("Download failed — try again.");
    }
  });
  el.img.addEventListener("dblclick", toggleZoom);
  el.ghost.addEventListener("error", () => {
    el.ghost.removeAttribute("src");
    el.ghost.hidden = true;
  });
  // The placeholder hides once the finished file has painted.
  el.img.addEventListener("load", () => {
    if (!el.img.getAttribute("src")?.startsWith("blob:")) el.ghost.hidden = true;
  });
  el.img.addEventListener("wheel", (e) => {
    if (!el.img.classList.contains("zoomed")) return;
    e.preventDefault();
    const matrix = /scale\(([\d.]+)\)/.exec(el.img.style.transform);
    const currentScale = matrix ? parseFloat(matrix[1]) : 1;
    const scale = Math.max(1, currentScale * (e.deltaY < 0 ? 1.15 : 0.87));
    el.img.style.transform =
      scale === 1 ? "" : `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
  }, { passive: false });
  let dragging = null;
  el.img.addEventListener("pointerdown", (e) => {
    if (!el.img.classList.contains("zoomed")) return;
    dragging = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    el.img.classList.add("grabbing");
    el.img.setPointerCapture(e.pointerId);
  });
  el.img.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    pan = { x: e.clientX - dragging.x, y: e.clientY - dragging.y };
    const matrix = /scale\(([\d.]+)\)/.exec(el.img.style.transform);
    const scale = matrix ? parseFloat(matrix[1]) : 1;
    el.img.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
  });
  const endDrag = () => {
    dragging = null;
    el.img.classList.remove("grabbing");
  };
  el.img.addEventListener("pointerup", endDrag);
  el.img.addEventListener("pointercancel", endDrag);
  el.video.addEventListener("error", () => {
    if (el.video.currentSrc) showLoadError(loadToken);
  });
  el.video.addEventListener("waiting", () => {
    if (el.video.currentSrc) el.spinner.hidden = false;
  });
  el.video.addEventListener("playing", () => { el.spinner.hidden = true; });
  el.video.addEventListener("canplay", () => { el.spinner.hidden = true; });
}

export function openInBrowser() {
  const post = current();
  if (post) openUrl(postUrl(post));
}

onMediaProgress((p) => progress.set(p.name, p));
setupEvents();
