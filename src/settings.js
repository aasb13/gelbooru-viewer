import { loadSettings, saveSettings, applyTheme } from "./state.js";
import { fetchPosts, clearCache } from "./api.js";

const el = {
  panel: document.getElementById("settings-panel"),
  close: document.getElementById("settings-close"),
  user: document.getElementById("set-user"),
  key: document.getElementById("set-key"),
  check: document.getElementById("check-conn"),
  checkResult: document.getElementById("check-result"),
  ratings: document.getElementById("set-ratings"),
  columns: document.getElementById("set-columns"),
  columnsVal: document.getElementById("set-columns-val"),
  theme: document.getElementById("set-theme"),
  pageSize: document.getElementById("set-pagesize"),
  remember: document.getElementById("set-remember"),
  clearCacheBtn: document.getElementById("clear-cache"),
};

let onChanged = null;
let settings = loadSettings();

function syncInputs() {
  el.user.value = settings.userId;
  el.key.value = settings.apiKey;
  el.columns.value = settings.columns;
  el.columnsVal.textContent = settings.columns;
  el.theme.value = settings.theme;
  el.pageSize.value = String(settings.pageSize);
  el.remember.checked = settings.rememberSearch;
  for (const box of el.ratings.querySelectorAll("input")) {
    box.checked = settings.ratings.includes(box.value);
  }
}

function persist() {
  saveSettings(settings);
  applyTheme(settings.theme);
  onChanged?.(settings);
}

export function initSettings(handler) {
  onChanged = handler;
  syncInputs();

  el.user.addEventListener("change", () => {
    settings.userId = el.user.value.trim();
    persist();
  });
  el.key.addEventListener("change", () => {
    settings.apiKey = el.key.value.trim();
    persist();
  });
  for (const box of el.ratings.querySelectorAll("input")) {
    box.addEventListener("change", () => {
      const selected = [...el.ratings.querySelectorAll("input:checked")].map(
        (b) => b.value,
      );
      settings.ratings = selected.length > 0 ? selected : ["general"];
      persist();
    });
  }
  el.columns.addEventListener("input", () => {
    settings.columns = Number(el.columns.value);
    el.columnsVal.textContent = el.columns.value;
    persist();
  });
  el.theme.addEventListener("change", () => {
    settings.theme = el.theme.value;
    persist();
  });
  el.pageSize.addEventListener("change", () => {
    settings.pageSize = Number(el.pageSize.value);
    persist();
  });
  el.remember.addEventListener("change", () => {
    settings.rememberSearch = el.remember.checked;
    persist();
  });
  el.check.addEventListener("click", async () => {
    el.check.disabled = true;
    el.checkResult.className = "";
    el.checkResult.textContent = "Checking…";
    try {
      const result = await fetchPosts({
        userId: settings.userId,
        apiKey: settings.apiKey,
        tokens: [],
        page: 0,
        limit: 1,
      });
      el.checkResult.className = "ok";
      el.checkResult.textContent = `ok — ${result.total.toLocaleString()} posts accessible`;
    } catch (error) {
      el.checkResult.className = "fail";
      el.checkResult.textContent = error.detail || error.kind;
    }
    el.check.disabled = false;
  });
  el.clearCacheBtn.addEventListener("click", async () => {
    el.clearCacheBtn.disabled = true;
    try {
      const count = await clearCache();
      el.clearCacheBtn.textContent = `Cleared ${count} file${count === 1 ? "" : "s"}`;
    } finally {
      el.clearCacheBtn.disabled = false;
    }
  });
  el.close.addEventListener("click", hide);

  document.addEventListener("click", (e) => {
    if (!el.panel.hidden && !el.panel.contains(e.target) && e.target.id !== "settings-btn") {
      hide();
    }
  });
}

export function show() {
  settings = loadSettings();
  syncInputs();
  el.panel.hidden = false;
}

export function hide() {
  el.panel.hidden = true;
}

export function isOpen() {
  return !el.panel.hidden;
}
