use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const API_BASE: &str = "https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1";
// Gelbooru's image hosts 302-redirect requests without this Referer to a
// hotlink-block page, so every image download must carry it.
const IMAGE_REFERER: &str = "https://gelbooru.com/";
const USER_AGENT: &str = concat!("GelbooruViewer/", env!("CARGO_PKG_VERSION"));
const HTTP_TIMEOUT_SECS: u64 = 20;
const API_LIMIT_CAP: u32 = 100;
const RATING_ORDER: [(&str, i64); 4] = [
    ("general", 0),
    ("sensitive", 1),
    ("questionable", 2),
    ("explicit", 3),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    id: u64,
    preview_url: String,
    file_url: String,
    sample_url: String,
    width: u32,
    height: u32,
    score: i64,
    rating: String,
    tags: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageResult {
    posts: Vec<Post>,
    total: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    // auth | rate_limited | network | server | blocked | internal
    kind: String,
    detail: String,
}

impl CmdError {
    fn new(kind: &str, detail: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            detail: detail.into(),
        }
    }
}

fn http_client() -> Result<reqwest::blocking::Client, CmdError> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| CmdError::new("internal", e.to_string()))
}

fn encode_token(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    for b in token.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn normalize_rating(rating: Option<serde_json::Value>) -> String {
    match rating {
        Some(serde_json::Value::String(s)) => s.to_lowercase(),
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .and_then(|i| RATING_ORDER.get(i as usize).map(|(name, _)| name.to_string()))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

#[derive(Deserialize, Default)]
struct RawPost {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default, rename = "preview_url")]
    preview_url: Option<String>,
    #[serde(default, rename = "file_url")]
    file_url: Option<String>,
    #[serde(default, rename = "sample_url")]
    sample_url: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    score: Option<i64>,
    #[serde(default)]
    rating: Option<serde_json::Value>,
    #[serde(default)]
    tags: Option<String>,
    #[serde(default, rename = "created_at")]
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct RawAttrs {
    #[serde(default)]
    count: Option<u64>,
}

#[derive(Deserialize)]
struct RawResponse {
    #[serde(rename = "@attributes", default)]
    attributes: Option<RawAttrs>,
    #[serde(default)]
    post: Option<serde_json::Value>,
}

fn parse_page(text: &str) -> Result<PageResult, CmdError> {
    let parsed: RawResponse = serde_json::from_str(text)
        .map_err(|e| CmdError::new("server", format!("Malformed response: {e}")))?;
    let total = parsed.attributes.and_then(|a| a.count).unwrap_or(0);
    // "post" is an array normally, a single object when exactly one post matches,
    // and absent when there are no results.
    let raw: Vec<serde_json::Value> = match parsed.post {
        Some(serde_json::Value::Array(items)) => items,
        Some(item @ serde_json::Value::Object(_)) => vec![item],
        _ => Vec::new(),
    };
    let mut posts = Vec::with_capacity(raw.len());
    for item in raw {
        let rp: RawPost = serde_json::from_value(item)
            .map_err(|e| CmdError::new("server", format!("Malformed post: {e}")))?;
        posts.push(Post {
            id: rp.id.unwrap_or(0),
            preview_url: rp.preview_url.unwrap_or_default(),
            file_url: rp.file_url.unwrap_or_default(),
            sample_url: rp.sample_url.unwrap_or_default(),
            width: rp.width.unwrap_or(0),
            height: rp.height.unwrap_or(0),
            score: rp.score.unwrap_or(0),
            rating: normalize_rating(rp.rating),
            tags: rp.tags.unwrap_or_default(),
            created_at: rp.created_at.unwrap_or_default(),
        });
    }
    Ok(PageResult { posts, total })
}

fn fetch_posts_blocking(
    user_id: &str,
    api_key: &str,
    tags: &[String],
    page: u32,
    limit: u32,
) -> Result<PageResult, CmdError> {
    if user_id.trim().is_empty() || api_key.trim().is_empty() {
        return Err(CmdError::new(
            "auth",
            "A Gelbooru user ID and API key are required.",
        ));
    }
    // Build the query string manually: Url::parse_with_params would re-encode
    // the already-escaped tags (">%25"), turning rating:general into a literal
    // tag that matches nothing.
    let mut url = format!(
        "{API_BASE}&pid={page}&limit={}",
        limit.min(API_LIMIT_CAP)
    );
    if !tags.is_empty() {
        let encoded: Vec<String> = tags.iter().map(|t| encode_token(t.trim())).collect();
        url.push_str("&tags=");
        url.push_str(&encoded.join("+"));
    }
    url.push_str("&user_id=");
    url.push_str(&encode_token(user_id.trim()));
    url.push_str("&api_key=");
    url.push_str(&encode_token(api_key.trim()));
    let url =
        url::Url::parse(&url).map_err(|e| CmdError::new("internal", e.to_string()))?;

    let response = http_client()?
        .get(url)
        .send()
        .map_err(|_| CmdError::new("network", "Could not reach Gelbooru — check your connection."))?;
    let status = response.status();
    match status.as_u16() {
        401 => return Err(CmdError::new("auth", "Gelbooru rejected the API credentials.")),
        429 => return Err(CmdError::new(
            "rate_limited",
            "Gelbooru rate limited the request.",
        )),
        s if !(200..300).contains(&s) => {
            return Err(CmdError::new("server", format!("Gelbooru replied with HTTP {s}.")))
        }
        _ => {}
    }
    let text = response
        .text()
        .map_err(|e| CmdError::new("network", e.to_string()))?;
    parse_page(&text)
}

#[tauri::command]
async fn fetch_posts(
    user_id: String,
    api_key: String,
    tags: Vec<String>,
    page: u32,
    limit: u32,
) -> Result<PageResult, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_posts_blocking(&user_id, &api_key, &tags, page, limit)
    })
    .await
    .map_err(|e| CmdError::new("internal", e.to_string()))?
}

fn images_dir(app: &AppHandle) -> Result<PathBuf, CmdError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::new("internal", e.to_string()))?
        .join("images");
    fs::create_dir_all(&dir).map_err(|e| CmdError::new("internal", e.to_string()))?;
    Ok(dir)
}

fn cache_file_name(parsed: &url::Url) -> Result<String, CmdError> {
    let segment = parsed
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    let sanitized: String = segment
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        return Err(CmdError::new("internal", "Image URL has no file name."));
    }
    Ok(sanitized)
}

fn is_supported_image(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    let jpeg = bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
    let png = bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47;
    let gif = &bytes[0..4] == b"GIF8";
    let webp = &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
    jpeg || png || gif || webp
}

fn fetch_image_bytes(url: &url::Url) -> Result<Vec<u8>, CmdError> {
    let mut response = http_client()?
        .get(url.clone())
        .header(reqwest::header::REFERER, IMAGE_REFERER)
        .send()
        .map_err(|_| CmdError::new("network", "Image download failed — check your connection."))?;
    let status = response.status();
    if !(200..300).contains(&status.as_u16()) {
        return Err(CmdError::new(
            "server",
            format!("The image server replied with HTTP {status}."),
        ));
    }
    let mut bytes: Vec<u8> = Vec::new();
    response
        .copy_to(&mut bytes)
        .map_err(|e| CmdError::new("network", e.to_string()))?;
    // A 200 response with HTML is the hotlink-block page; reject it so the UI
    // shows an error tile instead of an undecodable "image".
    if !is_supported_image(&bytes) {
        return Err(CmdError::new(
            "blocked",
            "The image host returned a non-image response.",
        ));
    }
    Ok(bytes)
}

fn store_image(app: &AppHandle, url: &str) -> Result<String, CmdError> {
    let parsed = url::Url::parse(url).map_err(|_| CmdError::new("internal", "Invalid image URL."))?;
    let host_ok = parsed
        .host_str()
        .map(|h| h.ends_with("gelbooru.com"))
        .unwrap_or(false);
    if !host_ok {
        return Err(CmdError::new("internal", "Unexpected image host."));
    }
    let name = cache_file_name(&parsed)?;
    let path = images_dir(app)?.join(&name);
    if !path.exists() {
        let bytes = fetch_image_bytes(&parsed)?;
        let tmp = path.with_extension("part");
        fs::write(&tmp, &bytes).map_err(|e| CmdError::new("internal", e.to_string()))?;
        fs::rename(&tmp, &path).map_err(|e| CmdError::new("internal", e.to_string()))?;
    }
    Ok(name)
}

#[tauri::command]
async fn download_image(app: AppHandle, url: String) -> Result<String, CmdError> {
    tauri::async_runtime::spawn_blocking(move || store_image(&app, &url))
        .await
        .map_err(|e| CmdError::new("internal", e.to_string()))?
}

#[tauri::command]
async fn download_file(url: String, dest: String) -> Result<String, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed =
            url::Url::parse(&url).map_err(|_| CmdError::new("internal", "Invalid image URL."))?;
        let bytes = fetch_image_bytes(&parsed)?;
        fs::write(&dest, &bytes).map_err(|e| CmdError::new("internal", e.to_string()))?;
        Ok(dest)
    })
    .await
    .map_err(|e| CmdError::new("internal", e.to_string()))?
}

#[tauri::command]
async fn clear_cache(app: AppHandle) -> Result<u32, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = images_dir(&app)?;
        let mut count = 0u32;
        for entry in fs::read_dir(&dir).map_err(|e| CmdError::new("internal", e.to_string()))? {
            let entry = entry.map_err(|e| CmdError::new("internal", e.to_string()))?;
            if entry.path().is_file() {
                let _ = fs::remove_file(entry.path());
                count += 1;
            }
        }
        Ok(count)
    })
    .await
    .map_err(|e| CmdError::new("internal", e.to_string()))?
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_for(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".mp4") {
        "video/mp4"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else {
        "image/jpeg"
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_posts,
            download_image,
            download_file,
            clear_cache
        ])
        .register_uri_scheme_protocol("gvcache", |ctx, request| {
            let decoded = percent_decode(request.uri().path().trim_start_matches('/'));
            let sanitized: String = decoded
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let dir = images_dir(ctx.app_handle()).unwrap_or_default();
            let (status, mime, body) = match fs::read(dir.join(&sanitized)) {
                Ok(bytes) => (200, mime_for(&sanitized).to_string(), bytes),
                Err(_) => (404, "text/plain".to_string(), b"not found".to_vec()),
            };
            match tauri::http::Response::builder()
                .status(status)
                .header("Content-Type", mime)
                .body(body)
            {
                Ok(response) => response,
                Err(_) => tauri::http::Response::new(b"error".to_vec()),
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
