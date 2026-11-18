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

export async function downloadToDisk(url, dest) {
  return invoke("download_file", { url, dest });
}

export async function clearCache() {
  return invoke("clear_cache");
}

export const RANKS = {
  general: 0,
  sensitive: 1,
  questionable: 2,
  explicit: 3,
};
