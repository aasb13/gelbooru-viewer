import "./style.css";
import { loadSettings, saveSettings, applyTheme, loadHistory, pushHistory, forgetHistoryItem } from "./state.js";
import { fetchPosts, RANKS } from "./api.js";
import { MasonryGrid } from "./grid.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as lightbox from "./lightbox.js";
import * as settingsPanel from "./settings.js";

const el = {
  search: document.getElementById("search"),
  searchClear: document.getElementById("search-clear"),
  historyBtn: document.getElementById("history-btn"),
  historyPop: document.getElementById("history-pop"),
  ratingChip: document.getElementById("rating-chip"),
  ratingPop: document.getElementById("rating-pop"),
  refresh: document.getElementById("refresh-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("banner-text"),
  bannerRetry: document.getElementById("banner-retry"),
  bannerClose: document.getElementById("banner-close"),
  setupCard: document.getElementById("setup-card"),
  setupUser: document.getElementById("setup-user"),
  setupKey: document.getElementById("setup-key"),
  setupGo: document.getElementById("setup-go"),
  setupMsg: document.getElementById("setup-msg"),
  gridScroll: document.getElementById("grid-scroll"),
  grid: document.getElementById("grid"),
  sentinel: document.getElementById("sentinel"),
  empty: document.getElementById("empty"),
  pagePill: document.getElementById("page-pill"),
  backToTop: document.getElementById("back-to-top"),
  contextMenu: document.getElementById("context-menu"),
};

let settings = loadSettings();
let query = "";
let tokens = [];
let page = 0;
let total = 0;
let loading = false;
let hasCredentials = false;
let retryTimer = null;
let backoffSeconds = 0;
let skeletons = [];

const grid = new MasonryGrid(el.grid);

function credentialsPresent() {
  return Boolean(settings.userId && settings.apiKey);
}

function allowedRatings() {
  return new Set(settings.ratings);
}

function filterByRatings(posts) {
  const allowed = allowedRatings();
  return posts.filter((p) => allowed.has(p.rating));
}

function ratingTokens() {
  // One selected rating can be served server-side (exact). Multiple selected
  // ratings must be filtered client-side: duplicate rating: meta-tags AND to
  // zero results on Gelbooru.
  if (settings.ratings.length === 1) {
    return ["rating:" + settings.ratings[0]];
  }
  return [];
}

function loosestRating() {
  let loosest = "general";
  for (const r of settings.ratings) {
    if (RANKS[r] > RANKS[loosest]) loosest = r;
  }
  return loosest;
}

function updateRatingChip() {
  el.ratingChip.textContent = loosestRating().charAt(0).toUpperCase();
  el.ratingChip.title = "Ratings: " + settings.ratings.join(", ");
}

function updateSearchButtons() {
  el.searchClear.hidden = el.search.value.length === 0;
  el.historyBtn.hidden = el.search.value.length > 0;
}

function showSetupCard(show, message, ok) {
  el.setupCard.hidden = !show;
  if (message !== undefined) {
    el.setupMsg.hidden = !message;
    el.setupMsg.textContent = message || "";
    el.setupMsg.className = ok ? "ok" : "";
  }
  el.gridScroll.hidden = show;
}

function hideBanner() {
  el.banner.hidden = true;
  clearTimeout(retryTimer);
  backoffSeconds = 0;
}

function showError(error) {
  el.banner.hidden = false;
  el.bannerRetry.hidden = false;
  if (error.kind === "auth") {
    el.bannerText.textContent = error.detail;
    showSetupCard(true);
    return;
  }
  if (error.kind === "rate_limited") {
    backoffSeconds = backoffSeconds ? Math.min(backoffSeconds * 2, 120) : 30;
    tickBackoff();
    return;
  }
  el.bannerText.textContent = error.detail || "Something went wrong.";
}

function tickBackoff() {
  el.banner.hidden = false;
  el.bannerRetry.hidden = true;
  if (backoffSeconds <= 0) {
    hideBanner();
    loadPage(page);
    return;
  }
  el.bannerText.textContent = `Rate limited — retrying in ${backoffSeconds}s`;
  backoffSeconds--;
  retryTimer = setTimeout(tickBackoff, 1000);
}

function clearSkeletons() {
  for (const node of skeletons) node.remove();
  skeletons = [];
}

function addSkeletons(count) {
  const holder = document.getElementById("skeletons");
  for (let i = 0; i < count; i++) {
    const cell = document.createElement("div");
    cell.className = "cell skeleton";
    cell.style.width = "240px";
    cell.style.height = "320px";
    holder.appendChild(cell);
    skeletons.push(cell);
  }
}

async function loadPage(pageIndex) {
  if (loading) return;
  if (!credentialsPresent()) {
    showSetupCard(true);
    return;
  }
  loading = true;
  hideBanner();
  if (pageIndex === 0) addSkeletons(Math.min(settings.pageSize, 12));
  try {
    const result = await fetchPosts({
      userId: settings.userId,
      apiKey: settings.apiKey,
      tokens: [...tokens, ...ratingTokens()],
      page: pageIndex,
      limit: settings.pageSize,
    });
    total = result.total;
    const filtered = filterByRatings(result.posts);
    if (pageIndex === 0) {
      clearSkeletons();
      grid.setPosts(filtered);
      el.gridScroll.scrollTop = 0;
    } else {
      grid.append(filtered);
    }
    hasCredentials = true;
    showSetupCard(false);
    el.empty.hidden = !(pageIndex === 0 && filtered.length === 0);
    if (filtered.length > 0) {
      el.pagePill.hidden = false;
      el.pagePill.textContent = "page " + (pageIndex + 1);
      setTimeout(() => (el.pagePill.hidden = true), 1500);
    }
    page = pageIndex;
  } catch (error) {
    clearSkeletons();
    showError(error);
  } finally {
    loading = false;
  }
}

function runSearch(text) {
  query = text.trim();
  tokens = query.split(/\s+/).filter(Boolean);
  if (query) pushHistory(query);
  total = 0;
  hideBanner();
  loadPage(0);
}

function nextPage() {
  const loaded = grid.posts.length;
  if (total > 0 && loaded < total && !loading) loadPage(page + 1);
}

/* --- search + history --- */

el.search.addEventListener("input", updateSearchButtons);
el.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    runSearch(el.search.value);
    el.historyPop.hidden = true;
    el.search.blur();
  }
  if (e.key === "Escape") el.search.blur();
});
el.searchClear.addEventListener("click", () => {
  el.search.value = "";
  updateSearchButtons();
  el.search.focus();
});
el.historyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renderHistory();
  el.historyPop.hidden = !el.historyPop.hidden;
});
el.search.addEventListener("focus", () => {
  if (loadHistory().length > 0) {
    renderHistory();
    el.historyPop.hidden = false;
  }
});

function renderHistory() {
  el.historyPop.innerHTML = "";
  const items = loadHistory();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pop-empty";
    empty.textContent = "No recent searches";
    el.historyPop.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("button");
    row.className = "pop-item";
    const label = document.createElement("span");
    label.textContent = item;
    const forget = document.createElement("span");
    forget.className = "muted";
    forget.textContent = "✕";
    forget.title = "Forget";
    forget.addEventListener("click", (e) => {
      e.stopPropagation();
      forgetHistoryItem(item);
      renderHistory();
    });
    row.append(label, forget);
    row.addEventListener("click", () => {
      el.search.value = item;
      updateSearchButtons();
      runSearch(item);
      el.historyPop.hidden = true;
    });
    el.historyPop.appendChild(row);
  }
}

/* --- rating chip --- */

function renderRatingPop() {
  el.ratingPop.innerHTML = "";
  const head = document.createElement("div");
  head.className = "pop-head";
  head.textContent = "Show these ratings";
  el.ratingPop.appendChild(head);
  for (const rating of ["general", "sensitive", "questionable", "explicit"]) {
    const label = document.createElement("label");
    label.className = "pop-item";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = settings.ratings.includes(rating);
    box.addEventListener("change", () => {
      const checked = [...el.ratingPop.querySelectorAll("input:checked")].map((b) => b.value);
      settings.ratings = checked.length > 0 ? checked : ["general"];
      saveSettings(settings);
      updateRatingChip();
      runSearch(query || el.search.value);
    });
    const text = document.createElement("span");
    text.textContent = rating.charAt(0).toUpperCase() + rating.slice(1);
    label.append(text, box);
    el.ratingPop.appendChild(label);
  }
}

el.ratingChip.addEventListener("click", (e) => {
  e.stopPropagation();
  renderRatingPop();
  el.ratingPop.hidden = !el.ratingPop.hidden;
});

/* --- refresh / settings / lightbox wiring --- */

el.refresh.addEventListener("click", () => runSearch(query || el.search.value));

el.settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPanel.show();
});

settingsPanel.initSettings((updated) => {
  settings = updated;
  hasCredentials = credentialsPresent();
  grid.columns = settings.columns;
  grid.layout();
  if (!hasCredentials) {
    showSetupCard(true);
  } else if (el.setupCard.hidden === false) {
    showSetupCard(false);
    runSearch(query || el.search.value.trim());
  }
});

grid.onOpen = (post) => {
  lightbox.open(grid.posts, grid.posts.indexOf(post), { needMore: nextPage });
};
grid.onBrowser = (post) => {
  openUrl(`https://gelbooru.com/index.php?page=post&s=view&id=${post.id}`);
};
grid.onMenu = (post, x, y) => {
  el.contextMenu.innerHTML = "";
  const items = [
    ["Open in browser", () => grid.onBrowser(post)],
    ["Copy post URL", () => navigator.clipboard.writeText(
      `https://gelbooru.com/index.php?page=post&s=view&id=${post.id}`)],
    ["Copy image URL", () => navigator.clipboard.writeText(post.file_url || post.preview_url)],
  ];
  for (const [label, action] of items) {
    const btn = document.createElement("button");
    btn.className = "pop-item";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      action();
      el.contextMenu.hidden = true;
    });
    el.contextMenu.appendChild(btn);
  }
  el.contextMenu.hidden = false;
  el.contextMenu.style.left = Math.min(x, innerWidth - 190) + "px";
  el.contextMenu.style.top = Math.min(y, innerHeight - 120) + "px";
};

lightbox.setTagHandler((e, tag) => {
  if (e.shiftKey) {
    el.search.value = (tokens.filter((t) => t !== "-" + tag).join(" ") + " -" + tag).trim();
  } else if (e.ctrlKey) {
    el.search.value = [...tokens, tag].join(" ");
  } else {
    el.search.value = tag;
  }
  updateSearchButtons();
  runSearch(el.search.value);
  lightbox.close();
});

/* --- global listeners --- */

document.addEventListener("click", (e) => {
  if (!el.historyPop.hidden && !el.historyPop.contains(e.target) && e.target !== el.historyBtn) {
    el.historyPop.hidden = true;
  }
  if (!el.ratingPop.hidden && !el.ratingPop.contains(e.target) && e.target !== el.ratingChip) {
    el.ratingPop.hidden = true;
  }
  if (!el.contextMenu.hidden && !el.contextMenu.contains(e.target)) {
    el.contextMenu.hidden = true;
  }
});

document.addEventListener("keydown", (e) => {
  if (lightbox.isOpen()) {
    if (e.key === "ArrowLeft" || e.key === "j") lightbox.step(-1);
    if (e.key === "ArrowRight" || e.key === "k") lightbox.step(1);
    if (e.key === "m") lightbox.toggleZoom();
    if (e.key === "o" && e.ctrlKey) {
      e.preventDefault();
      lightbox.openInBrowser();
    }
    if (e.key === "Escape") lightbox.close();
    return;
  }
  if (e.key === "/" && document.activeElement !== el.search) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  }
  if (e.key === "Escape") {
    el.historyPop.hidden = true;
    el.ratingPop.hidden = true;
    el.contextMenu.hidden = true;
    settingsPanel.hide();
  }
  if (e.key === "Home") {
    el.gridScroll.scrollTo({ top: 0 });
  }
});

el.gridScroll.addEventListener("scroll", () => {
  el.backToTop.hidden = el.gridScroll.scrollTop < el.gridScroll.clientHeight * 3;
});

el.backToTop.addEventListener("click", () => {
  el.gridScroll.scrollTo({ top: 0 });
});

new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && hasCredentials) nextPage();
    }
  },
  { root: el.gridScroll, rootMargin: "200% 0px" },
).observe(el.sentinel);

/* --- setup card --- */

el.setupGo.addEventListener("click", async () => {
  settings.userId = el.setupUser.value.trim();
  settings.apiKey = el.setupKey.value.trim();
  saveSettings(settings);
  hasCredentials = credentialsPresent();
  el.setupGo.disabled = true;
  el.setupMsg.hidden = false;
  el.setupMsg.className = "";
  el.setupMsg.textContent = "Checking…";
  try {
    await loadPage(0);
    el.setupMsg.hidden = true;
  } catch (error) {
    el.setupMsg.className = "";
    el.setupMsg.textContent = error.detail || "Connection failed.";
  }
  el.setupGo.disabled = false;
});

/* --- boot --- */

applyTheme(settings.theme);
grid.columns = settings.columns;
updateRatingChip();
updateSearchButtons();
hasCredentials = credentialsPresent();

if (settings.rememberSearch) {
  el.search.value = el.search.value || localStorage.getItem("gelbooru-viewer:last-query") || "";
}
window.addEventListener("beforeunload", () => {
  localStorage.setItem("gelbooru-viewer:last-query", el.search.value);
});

if (hasCredentials) {
  showSetupCard(false);
  runSearch(el.search.value.trim());
} else {
  showSetupCard(true);
}
