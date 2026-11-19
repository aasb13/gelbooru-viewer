import "./style.css";
import { loadSettings, saveSettings, applyTheme, loadHistory, pushHistory, forgetHistoryItem } from "./state.js";
import { fetchPosts, suggestTags, postUrl } from "./api.js";
import { MasonryGrid } from "./grid.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as lightbox from "./lightbox.js";
import * as settingsPanel from "./settings.js";

const el = {
  search: document.getElementById("search"),
  searchWrap: document.getElementById("search-wrap"),
  searchClear: document.getElementById("search-clear"),
  historyBtn: document.getElementById("history-btn"),
  historyPop: document.getElementById("history-pop"),
  suggestPop: document.getElementById("suggest-pop"),
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
let failedPage = 0;
let loadToken = 0;
let skeletons = [];
let suggestions = [];
let activeSuggestion = -1;
let suggestTimer = null;
let suggestToken = 0;
// Per-session browsing history: every visited page — a listing or an image in
// the lightbox — is an entry, traversed undo/redo style. Mouse back/forward
// walk all of it; Alt+arrows walk listings only.
let pageStack = [];
let pageIndex = -1;
let galleryCursor = -1;
let restoreToken = 0;
// Query the grid's posts actually belong to; lags `query` while a newer load
// is in flight or has failed.
let gridQuery = null;

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
  if (backoffSeconds <= 0) {
    hideBanner();
    loadPage(failedPage);
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

// A newer load supersedes an in-flight one: stale responses drop without
// touching the UI. Returns the error on failure, null otherwise.
async function loadPage(pageIndex, restoreScroll = 0) {
  if (!credentialsPresent()) {
    showSetupCard(true);
    return null;
  }
  const token = ++loadToken;
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
    if (token !== loadToken) return null;
    total = result.total;
    const filtered = filterByRatings(result.posts);
    emptyPagesStreak = filtered.length === 0 ? emptyPagesStreak + 1 : 0;
    if (pageIndex === 0) {
      clearSkeletons();
      grid.setPosts(filtered);
      el.gridScroll.scrollTop = restoreScroll;
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
    gridQuery = query;
    return null;
  } catch (error) {
    if (token !== loadToken) return null;
    clearSkeletons();
    failedPage = pageIndex;
    showError(error);
    return error;
  } finally {
    if (token === loadToken) loading = false;
  }
}

function pushPage(entry) {
  pageStack = pageStack.slice(0, pageIndex + 1);
  pageStack.push(entry);
  pageIndex = pageStack.length - 1;
}

function saveNavPosition() {
  const entry = pageStack[pageIndex];
  if (entry?.kind === "grid") entry.scrollTop = el.gridScroll.scrollTop;
}

function runSearch(text, { fromNav = false } = {}) {
  query = text.trim();
  tokens = query.split(/\s+/).filter(Boolean);
  if (!fromNav) {
    // Re-running the visible query is a reload, not a navigation: keep the
    // entry and the forward stack.
    const top = pageStack[pageIndex];
    if (top?.kind === "grid" && top.query === query) {
      top.scrollTop = 0;
    } else {
      saveNavPosition();
      pushPage({ kind: "grid", query, scrollTop: 0 });
    }
  }
  if (query) pushHistory(query);
  el.search.value = query;
  updateSearchButtons();
  total = 0;
  emptyPagesStreak = 0;
  galleryCursor = -1;
  hideBanner();
  return loadPage(0, fromNav ? pageStack[pageIndex]?.scrollTop || 0 : 0);
}

// Back/forward over the page stack. `kinds` filters entries: mouse buttons
// traverse everything, Alt+arrows skip image entries.
function navigateHistory(delta, kinds) {
  let target = pageIndex + delta;
  while (target >= 0 && target < pageStack.length && !kinds.includes(pageStack[target].kind)) {
    target += delta;
  }
  if (target < 0 || target >= pageStack.length) return;
  saveNavPosition();
  pageIndex = target;
  const entry = pageStack[pageIndex];
  if (entry.kind === "grid") {
    // Already showing this listing: keep it, scroll position included.
    if (entry.query !== query || gridQuery !== query || grid.posts.length === 0) {
      runSearch(entry.query, { fromNav: true });
    }
    el.gridScroll.scrollTop = entry.scrollTop || 0;
  } else {
    restoreLightbox(entry);
  }
}

// Reopen an image entry. If its listing is not the one on screen, load that
// listing first; a superseded or failed load leaves the listing shown.
async function restoreLightbox(entry) {
  const token = ++restoreToken;
  if (entry.query !== query) {
    const error = await runSearch(entry.query, { fromNav: true });
    if (error || token !== restoreToken) return;
  }
  const i = grid.posts.findIndex((p) => p.id === entry.postId);
  if (i < 0) return;
  openLightboxAt(i, { fromHistory: true });
}

let emptyPagesStreak = 0;

function nextPage() {
  if (emptyPagesStreak >= 2) return;
  const loaded = grid.posts.length;
  if (total > 0 && loaded < total && !loading) loadPage(page + 1);
}

/* --- search + history --- */

el.search.addEventListener("input", () => {
  el.historyPop.hidden = true;
  updateSearchButtons();
  scheduleSuggestions();
});
el.search.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && !el.suggestPop.hidden && suggestions.length > 0) {
    e.preventDefault();
    activeSuggestion = (activeSuggestion + 1) % suggestions.length;
    renderSuggestionActive();
    return;
  }
  if (e.key === "ArrowUp" && !el.suggestPop.hidden && suggestions.length > 0) {
    e.preventDefault();
    activeSuggestion =
      activeSuggestion <= 0 ? suggestions.length - 1 : activeSuggestion - 1;
    renderSuggestionActive();
    return;
  }
  if (e.key === "Tab" && !el.suggestPop.hidden && activeSuggestion >= 0) {
    e.preventDefault();
    applySuggestion(suggestions[activeSuggestion]);
    return;
  }
  if (e.key === "Enter") {
    if (!el.suggestPop.hidden && activeSuggestion >= 0) {
      e.preventDefault();
      applySuggestion(suggestions[activeSuggestion]);
      return;
    }
    hideSuggestions();
    runSearch(el.search.value);
    el.historyPop.hidden = true;
    el.search.blur();
  }
  if (e.key === "Escape") {
    hideSuggestions();
    el.search.blur();
  }
});
el.searchClear.addEventListener("click", () => {
  el.search.value = "";
  updateSearchButtons();
  hideSuggestions();
  el.search.focus();
});
el.historyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  renderHistory();
  el.historyPop.hidden = !el.historyPop.hidden;
});
el.search.addEventListener("focus", () => {
  if (loadHistory().length > 0 && el.search.value.length === 0) {
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
    forget.className = "ms muted";
    forget.textContent = "close";
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

/* --- tag suggestions --- */

// Suggest for the token currently being typed (the last space-separated word),
// and replace only that token when one is chosen.
function currentToken() {
  const value = el.search.value;
  const start = Math.max(value.lastIndexOf(" "), value.lastIndexOf("  ")) + 1;
  return { start, text: value.slice(start) };
}

function hideSuggestions() {
  el.suggestPop.hidden = true;
  suggestions = [];
  activeSuggestion = -1;
}

function scheduleSuggestions() {
  clearTimeout(suggestTimer);
  const { text } = currentToken();
  if (!text || !credentialsPresent()) {
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(loadSuggestions, 180);
}

async function loadSuggestions() {
  const { text } = currentToken();
  if (!text) return;
  const token = ++suggestToken;
  try {
    const tags = await suggestTags({
      userId: settings.userId,
      apiKey: settings.apiKey,
      prefix: text,
    });
    if (token !== suggestToken || currentToken().text !== text) return;
    suggestions = tags;
    activeSuggestion = -1;
    renderSuggestions();
  } catch {
    // Autocomplete is best-effort; a failed lookup never blocks searching.
    if (token === suggestToken) hideSuggestions();
  }
}

function renderSuggestions() {
  el.suggestPop.innerHTML = "";
  if (suggestions.length === 0) {
    hideSuggestions();
    return;
  }
  suggestions.forEach((tag, i) => {
    const row = document.createElement("button");
    row.className = "pop-item suggestion-item";
    row.dataset.index = String(i);
    const name = document.createElement("span");
    name.textContent = tag.name;
    const count = document.createElement("span");
    count.className = "s-count muted";
    count.textContent = tag.count.toLocaleString();
    row.append(name, count);
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      applySuggestion(tag);
    });
    el.suggestPop.appendChild(row);
  });
  el.suggestPop.hidden = false;
}

function renderSuggestionActive() {
  const rows = el.suggestPop.querySelectorAll(".suggestion-item");
  rows.forEach((row, i) => row.classList.toggle("active", i === activeSuggestion));
}

function applySuggestion(tag) {
  const { start, text } = currentToken();
  const quoted = /\s/.test(tag.name) ? `"${tag.name}"` : tag.name;
  el.search.value =
    el.search.value.slice(0, start) + quoted + el.search.value.slice(start + text.length);
  updateSearchButtons();
  hideSuggestions();
  el.search.focus();
}

/* --- refresh / settings / lightbox wiring --- */

el.refresh.addEventListener("click", () => runSearch(query || el.search.value));

el.settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPanel.show();
});

settingsPanel.initSettings((updated) => {
  const ratingsChanged =
    updated.ratings.length !== settings.ratings.length ||
    updated.ratings.some((r) => !settings.ratings.includes(r));
  settings = updated;
  hasCredentials = credentialsPresent();
  grid.columns = settings.columns;
  grid.layout();
  if (!hasCredentials) {
    showSetupCard(true);
  } else if (el.setupCard.hidden === false) {
    showSetupCard(false);
    runSearch(query || el.search.value.trim());
  } else if (ratingsChanged) {
    runSearch(query);
  }
});

function openLightboxAt(index, { fromHistory = false } = {}) {
  galleryCursor = index;
  if (!fromHistory) {
    saveNavPosition();
    pushPage({ kind: "lightbox", query, postId: grid.posts[index].id });
  }
  lightbox.open(grid.posts, index, {
    needMore: nextPage,
    onClose: () => {
      galleryCursor = -1;
      // The listing the lightbox returns to is a visited page too — unless
      // the close rode along with a search, which pushed its own entry.
      if (pageStack[pageIndex]?.kind === "lightbox") {
        pushPage({ kind: "grid", query, scrollTop: el.gridScroll.scrollTop });
      }
    },
    onStep: (i) => { galleryCursor = i; },
    onUserStep: (post) => pushPage({ kind: "lightbox", query, postId: post.id }),
  });
}

grid.onOpen = (post) => {
  openLightboxAt(grid.posts.indexOf(post));
};
grid.onBrowser = (post) => {
  openUrl(postUrl(post));
};
grid.onMenu = (post, x, y) => {
  el.contextMenu.innerHTML = "";
  const items = [
    ["Open in browser", () => grid.onBrowser(post)],
    ["Copy post URL", () => navigator.clipboard.writeText(postUrl(post))],
    ["Copy image URL", () => navigator.clipboard.writeText(post.fileUrl || post.previewUrl)],
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
  if (
    !el.historyPop.hidden &&
    !el.historyPop.contains(e.target) &&
    !el.searchWrap.contains(e.target)
  ) {
    el.historyPop.hidden = true;
  }
  if (!el.suggestPop.hidden && !el.suggestPop.contains(e.target) && e.target !== el.search) {
    hideSuggestions();
  }
  if (!el.contextMenu.hidden && !el.contextMenu.contains(e.target)) {
    el.contextMenu.hidden = true;
  }
});

document.addEventListener("mousedown", (e) => {
  if (e.button === 3) {
    e.preventDefault();
    navigateHistory(-1, ["grid", "lightbox"]);
  } else if (e.button === 4) {
    e.preventDefault();
    navigateHistory(1, ["grid", "lightbox"]);
  }
});

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    navigateHistory(-1, ["grid"]);
    return;
  }
  if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    navigateHistory(1, ["grid"]);
    return;
  }
  if (e.ctrlKey && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    settingsPanel.stepColumns(-1);
    return;
  }
  if (e.ctrlKey && e.key === "-") {
    e.preventDefault();
    settingsPanel.stepColumns(1);
    return;
  }
  if (lightbox.isOpen()) {
    if (e.key === "ArrowLeft" || e.key === "k" || e.key === "h" || e.key === "PageUp") lightbox.step(-1);
    if (e.key === "ArrowRight" || e.key === "j" || e.key === "l" || e.key === "PageDown") lightbox.step(1);
    if (e.key === "m") lightbox.toggleOriginal();
    if (e.key === "o" && e.ctrlKey) {
      e.preventDefault();
      lightbox.openInBrowser();
    }
    if (e.key === "Escape") lightbox.close();
    return;
  }
  if ((e.key === "/" || (e.ctrlKey && e.key.toLowerCase() === "k")) && !typing) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  }
  if (["ArrowLeft", "ArrowRight", "h", "l"].includes(e.key) && !typing) {
    e.preventDefault();
    const posts = grid.posts;
    if (posts.length === 0) return;
    const forward = e.key === "ArrowRight" || e.key === "l";
    const start = galleryCursor < 0
      ? (forward ? 0 : posts.length - 1)
      : Math.max(0, Math.min(posts.length - 1, galleryCursor + (forward ? 1 : -1)));
    openLightboxAt(start);
  }
  if (e.key === "Escape") {
    el.historyPop.hidden = true;
    el.contextMenu.hidden = true;
    hideSuggestions();
    settingsPanel.hide();
  }
  if (!typing && e.key === "Home") {
    e.preventDefault();
    el.gridScroll.scrollTo({ top: 0 });
  }
  if (!typing && e.key === "PageDown") {
    e.preventDefault();
    el.gridScroll.scrollBy({ top: el.gridScroll.clientHeight * 0.9, behavior: "smooth" });
  }
  if (!typing && e.key === "PageUp") {
    e.preventDefault();
    el.gridScroll.scrollBy({ top: -el.gridScroll.clientHeight * 0.9, behavior: "smooth" });
  }
});

el.gridScroll.addEventListener("scroll", () => {
  el.backToTop.hidden = el.gridScroll.scrollTop < el.gridScroll.clientHeight * 3;
});

el.backToTop.addEventListener("click", () => {
  el.gridScroll.scrollTo({ top: 0 });
});

el.bannerRetry.addEventListener("click", () => {
  hideBanner();
  loadPage(failedPage);
});
el.bannerClose.addEventListener("click", hideBanner);

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
  el.setupMsg.hidden = false;
  el.setupMsg.className = "";
  if (!hasCredentials) {
    el.setupMsg.textContent = "Enter your user ID and API key.";
    return;
  }
  el.setupGo.disabled = true;
  el.setupMsg.textContent = "Checking…";
  const error = await loadPage(0);
  if (error) {
    el.setupMsg.textContent = error.detail || "Connection failed.";
  } else {
    el.setupMsg.hidden = true;
    pushPage({ kind: "grid", query, scrollTop: 0 });
  }
  el.setupGo.disabled = false;
});

/* --- boot --- */

applyTheme(settings.theme);
grid.columns = settings.columns;
updateSearchButtons();
hasCredentials = credentialsPresent();

if (settings.rememberSearch) {
  el.search.value = el.search.value || localStorage.getItem("gelbooru-viewer:last-query") || "";
}
window.addEventListener("beforeunload", () => {
  if (settings.rememberSearch) {
    localStorage.setItem("gelbooru-viewer:last-query", el.search.value);
  }
});

if (hasCredentials) {
  showSetupCard(false);
  runSearch(el.search.value.trim());
} else {
  showSetupCard(true);
}
