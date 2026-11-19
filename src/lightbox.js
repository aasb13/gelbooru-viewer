import { imageSrc, downloadToDisk } from "./api.js";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

const VIDEO_RE = /\.(mp4|webm|mov|mkv)(\?|$)/i;

const el = {
  root: document.getElementById("lightbox"),
  img: document.getElementById("lb-img"),
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
let pan = { x: 0, y: 0 };

export function isOpen() {
  return !el.root.hidden;
}

export function open(posts, start, hooks) {
  list = posts;
  index = Math.max(0, Math.min(start, posts.length - 1));
  needMore = hooks?.needMore ?? null;
  onClose = hooks?.onClose ?? null;
  el.root.hidden = false;
  show(index);
}

export function close() {
  el.root.hidden = true;
  list = [];
  index = -1;
  onClose?.();
}

function current() {
  return list[index] || null;
}

function postUrl(post) {
  return `https://gelbooru.com/index.php?page=post&s=view&id=${post.id}`;
}

function show(i) {
  index = Math.max(0, Math.min(i, list.length - 1));
  const post = current();
  if (!post) return;
  resetZoom();
  renderInfo(post);

  const isVideo = VIDEO_RE.test(post.fileUrl || "");
  el.videoNote.hidden = !isVideo;
  el.img.hidden = isVideo;
  el.originalBtn.hidden = !post.sampleUrl;
  el.spinner.hidden = false;

  const url = isVideo
    ? ""
    : post.sampleUrl || post.fileUrl || "";
  const token = ++loadToken;
  currentUrl = url;

  if (!url) {
    el.spinner.hidden = true;
    return;
  }
  imageSrc(url)
    .then((src) => {
      if (token !== loadToken) return;
      el.img.src = src;
      el.spinner.hidden = true;
    })
    .catch(() => {
      if (token !== loadToken) return;
      el.spinner.hidden = true;
      el.img.hidden = true;
      el.videoNote.hidden = false;
      el.videoNote.textContent = "Image failed to load — press Retry in the gallery or navigate away.";
    });
}

function renderInfo(post) {
  el.metaline.innerHTML = "";
  const badge = document.createElement("span");
  badge.className = "badge " + (post.rating || "x").charAt(0);
  badge.textContent = (post.rating || "?").charAt(0).toUpperCase();
  const parts = [
    `★ ${post.score.toLocaleString()}`,
    post.rating || "?",
    `${post.width}×${post.height}`,
    post.createdAt,
  ];
  const text = document.createElement("span");
  text.textContent = parts.join(" · ");
  el.metaline.append(badge, text);

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

export function setPostsUpdated(posts) {
  list = posts;
  if (isOpen() && index >= list.length) index = Math.max(0, list.length - 1);
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
  if (el.img.hidden || !el.img.src) return;
  if (el.img.classList.contains("zoomed")) {
    resetZoom();
    return;
  }
  el.img.classList.add("zoomed");
  const scale = Math.max(
    1,
    el.img.naturalWidth / Math.max(el.stage.clientWidth - 120, 1),
  );
  pan = { x: 0, y: 0 };
  el.img.style.transform = `scale(${scale})`;
}

function setupEvents() {
  el.close.addEventListener("click", close);
  el.back.addEventListener("click", close);
  el.prev.addEventListener("click", () => step(-1));
  el.next.addEventListener("click", () => step(1));
  el.originalBtn.addEventListener("click", () => {
    const post = current();
    if (!post?.file_url) return;
    const token = ++loadToken;
    el.spinner.hidden = false;
    imageSrc(post.fileUrl)
      .then((src) => {
        if (token !== loadToken) return;
        resetZoom();
        el.img.src = src;
        el.spinner.hidden = true;
      })
      .catch(() => {
        el.spinner.hidden = true;
      });
  });
  el.browser.addEventListener("click", () => openInBrowser());
  el.download.addEventListener("click", async () => {
    const post = current();
    if (!post?.file_url) return;
    const ext = (post.fileUrl.match(/\.([a-z0-9]+)(\?|$)/i) || [])[1] || "jpg";
    const dest = await save({
      defaultPath: `${post.id}.${ext}`,
      filters: [{ name: "Image", extensions: [ext] }],
    });
    if (!dest) return;
    await downloadToDisk(post.fileUrl, dest);
  });
  el.img.addEventListener("dblclick", toggleZoom);
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
}

export function openInBrowser() {
  const post = current();
  if (post) openUrl(postUrl(post));
}

export function postLink(post) {
  return postUrl(post);
}

setupEvents();
