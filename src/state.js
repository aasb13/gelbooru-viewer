const SETTINGS_KEY = "gelbooru-viewer:settings";
const HISTORY_KEY = "gelbooru-viewer:history";

const DEFAULTS = {
  userId: "",
  apiKey: "",
  ratings: ["general"],
  columns: 3,
  theme: "dark",
  pageSize: 50,
  rememberSearch: true,
};

const VALID_RATINGS = ["general", "sensitive", "questionable", "explicit"];

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULTS, ...stored };
  if (!Array.isArray(merged.ratings)) merged.ratings = [...DEFAULTS.ratings];
  merged.ratings = merged.ratings.filter((r) => VALID_RATINGS.includes(r));
  if (merged.ratings.length === 0) merged.ratings = [...DEFAULTS.ratings];
  return merged;
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

export function pushHistory(query) {
  if (!query) return;
  const rest = loadHistory().filter((q) => q !== query);
  localStorage.setItem(HISTORY_KEY, JSON.stringify([query, ...rest].slice(0, 20)));
}

export function forgetHistoryItem(query) {
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(loadHistory().filter((q) => q !== query)),
  );
}

let currentTheme = "dark";
const systemLight = matchMedia("(prefers-color-scheme: light)");
systemLight.addEventListener("change", () => {
  if (currentTheme === "system") applyTheme("system");
});

export function applyTheme(theme) {
  currentTheme = theme;
  const resolved =
    theme === "system" ? (systemLight.matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = resolved;
}
