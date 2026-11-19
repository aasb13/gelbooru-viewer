import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

function normalizeError(error) {
  if (error && typeof error === "object" && error.kind) return error;
  return { kind: "internal", detail: String(error) };
}

export async function fetchPosts({ userId, apiKey, tokens, page, limit }) {
  try {
    return await invoke("fetch_posts", {
      userId,
      apiKey,
      tags: tokens,
      page,
      limit,
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

// Custom cache protocol: served by the Rust side over gvcache://localhost.
export async function imageSrc(url) {
  const name = await invoke("download_image", { url });
  return "gvcache://localhost/" + name;
}

// Starts the download (unless cached or already running) and returns the
// cache name immediately; progress arrives via onMediaProgress.
export async function prepareMedia(url) {
  try {
    return await invoke("prepare_media", { url });
  } catch (error) {
    throw normalizeError(error);
  }
}

// Pure cache lookup — never starts a download.
export async function cachedMedia(url) {
  try {
    return await invoke("cached_media", { url });
  } catch (error) {
    throw normalizeError(error);
  }
}

export function onMediaProgress(handler) {
  return listen("media://progress", (event) => handler(event.payload));
}

export async function suggestTags({ userId, apiKey, prefix }) {
  try {
    return await invoke("suggest_tags", { userId, apiKey, prefix });
  } catch (error) {
    throw normalizeError(error);
  }
}

export async function downloadToDisk(url, dest) {
  return invoke("download_file", { url, dest });
}

export async function clearCache() {
  return invoke("clear_cache");
}

export function postUrl(post) {
  return `https://gelbooru.com/index.php?page=post&s=view&id=${post.id}`;
}
