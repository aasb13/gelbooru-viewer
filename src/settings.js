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
  columnsDown: document.getElementById("set-columns-down"),
  columnsUp: document.getElementById("set-columns-up"),
  columnsVal: document.getElementById("set-columns-val"),
  theme: document.getElementById("set-theme"),
  pageSize: document.getElementById("set-pagesize"),
  remember: document.getElementById("set-remember"),
  clearCacheBtn: document.getElementById("clear-cache"),
};

const COLUMN_MIN = 2;
const COLUMN_MAX = 6;

let onChanged = null;
let settings = loadSettings();

function setSegmented(group, value) {
  for (const button of group.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.value === value);
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
}

function syncInputs() {
  el.user.value = settings.userId;
  el.key.value = settings.apiKey;
  el.columnsVal.textContent = settings.columns;
  for (const chip of el.ratings.querySelectorAll(".toggle-chip")) {
    const active = settings.ratings.includes(chip.dataset.value);
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  }
  setSegmented(el.theme, settings.theme);
  setSegmented(el.pageSize, String(settings.pageSize));
  el.remember.classList.toggle("on", settings.rememberSearch);
  el.remember.setAttribute("aria-checked", String(settings.rememberSearch));
}

function persist() {
  saveSettings(settings);
  applyTheme(settings.theme);
  onChanged?.(settings);
}

function setColumns(value) {
  settings.columns = Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, value));
  el.columnsVal.textContent = settings.columns;
  persist();
}

export function stepColumns(delta) {
  setColumns(settings.columns + delta);
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

  for (const chip of el.ratings.querySelectorAll(".toggle-chip")) {
    chip.addEventListener("click", () => {
      const value = chip.dataset.value;
      const index = settings.ratings.indexOf(value);
      if (index >= 0) {
        // The last remaining rating cannot be removed — the grid needs one.
        if (settings.ratings.length === 1) return;
        settings.ratings.splice(index, 1);
      } else {
        settings.ratings.push(value);
      }
      syncInputs();
      persist();
    });
  }

  el.columnsDown.addEventListener("click", () => setColumns(settings.columns - 1));
  el.columnsUp.addEventListener("click", () => setColumns(settings.columns + 1));

  for (const group of [el.theme, el.pageSize]) {
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (group === el.theme) settings.theme = button.dataset.value;
      else settings.pageSize = Number(button.dataset.value);
      setSegmented(group, button.dataset.value);
      persist();
    });
  }

  el.remember.addEventListener("click", () => {
    settings.rememberSearch = !settings.rememberSearch;
    el.remember.classList.toggle("on", settings.rememberSearch);
    el.remember.setAttribute("aria-checked", String(settings.rememberSearch));
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
    const label = el.clearCacheBtn.textContent;
    try {
      const count = await clearCache();
      el.clearCacheBtn.textContent = `Cleared ${count} file${count === 1 ? "" : "s"}`;
    } catch {
      el.clearCacheBtn.textContent = "Couldn't clear the cache";
    } finally {
      setTimeout(() => {
        el.clearCacheBtn.textContent = label;
        el.clearCacheBtn.disabled = false;
      }, 2000);
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
