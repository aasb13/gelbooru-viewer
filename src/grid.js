import { imageSrc } from "./api.js";

const GAP = 8;

export class MasonryGrid {
  constructor(container) {
    this.container = container;
    this.columns = 3;
    this.posts = [];
    this.cells = new Map();
    this.onOpen = null;
    this.onBrowser = null;
    this.onMenu = null;
    this.inflight = new Set();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.loadThumb(entry.target.__post);
        }
      },
      { rootMargin: "120% 0px" },
    );

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.layout(), 150);
    });
  }

  setPosts(posts) {
    for (const cell of this.cells.values()) cell.el.remove();
    this.cells.clear();
    this.posts = [];
    this.container.style.height = "0px";
    this.append(posts);
  }

  append(posts) {
    for (const post of posts) {
      if (this.cells.has(post.id)) continue;
      this.posts.push(post);
      const cell = this.buildCell(post);
      this.container.appendChild(cell.el);
      this.cells.set(post.id, cell);
      this.observer.observe(cell.el);
    }
    this.layout();
  }

  buildCell(post) {
    const el = document.createElement("div");
    el.className = "cell skeleton";
    el.__post = post;

    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("click", () => this.onOpen?.(post));
    el.appendChild(img);

    const info = document.createElement("div");
    info.className = "hover-info";
    const badge = document.createElement("span");
    badge.className = "badge " + (post.rating || "x").charAt(0);
    badge.textContent = (post.rating || "?").charAt(0).toUpperCase();
    const score = document.createElement("span");
    score.textContent = formatScore(post.score);
    const dims = document.createElement("span");
    dims.textContent = `${post.width}×${post.height}`;
    info.append(score, badge, dims);
    el.appendChild(info);

    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) this.onBrowser?.(post);
    });
    el.addEventListener("click", (e) => {
      if (e.ctrlKey) this.onBrowser?.(post);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.onMenu?.(post, e.clientX, e.clientY);
    });

    const ar =
      post.width > 0 && post.height > 0 ? post.height / post.width : 0.75;
    return { el, img, post, aspect: ar, loaded: false, failed: false };
  }

  loadThumb(post) {
    const cell = this.cells.get(post.id);
    if (!cell || cell.loaded || cell.failed || this.inflight.has(post.id)) return;
    const source = post.preview_url || post.file_url;
    if (!source) {
      cell.failed = true;
      cell.el.classList.add("error");
      return;
    }
    this.inflight.add(post.id);
    imageSrc(source)
      .then((src) => {
        cell.img.src = src;
        cell.loaded = true;
        cell.el.classList.remove("skeleton");
      })
      .catch(() => {
        cell.failed = true;
        cell.el.classList.remove("skeleton");
        cell.el.classList.add("error");
      })
      .finally(() => this.inflight.delete(post.id));
  }

  layout() {
    const width = this.container.clientWidth || this.container.parentElement?.clientWidth || 0;
    if (width <= 0) return;
    const n = Math.max(2, Math.min(6, this.columns));
    const colWidth = Math.floor((width - GAP * (n - 1)) / n);
    const heights = new Array(n).fill(0);
    for (const post of this.posts) {
      const cell = this.cells.get(post.id);
      if (!cell) continue;
      let col = 0;
      for (let i = 1; i < n; i++) {
        if (heights[i] < heights[col]) col = i;
      }
      const height = Math.round(colWidth * cell.aspect);
      const x = col * (colWidth + GAP);
      const y = heights[col];
      cell.el.style.width = colWidth + "px";
      cell.el.style.height = height + "px";
      cell.el.style.transform = `translate(${x}px, ${y}px)`;
      heights[col] += height + GAP;
    }
    const tallest = Math.max(...heights, 0);
    this.container.style.height = Math.max(tallest - GAP, 0) + "px";
  }
}

function formatScore(score) {
  if (score >= 1000) return (score / 1000).toFixed(1) + "k";
  return String(score);
}
