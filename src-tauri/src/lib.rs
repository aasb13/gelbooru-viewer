use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const API_BASE: &str = "https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1";
const TAG_API_BASE: &str = "https://gelbooru.com/index.php?page=dapi&s=tag&q=index&json=1";
// Gelbooru's image hosts 302-redirect requests without this Referer to a
// hotlink-block page, so every image download must carry it.
const IMAGE_REFERER: &str = "https://gelbooru.com/";
const USER_AGENT: &str = concat!("GelbooruViewer/", env!("CARGO_PKG_VERSION"));
const HTTP_TIMEOUT_SECS: u64 = 20;
// Media downloads stream to disk progressively; these bound how long a
// protocol request may wait for bytes to arrive and how often progress is
// emitted to the UI.
const DOWNLOAD_WAIT_SECS: u64 = 600;
const RANGE_WAIT_SECS: u64 = 90;
// Videos: the MP4 metadata box (moov) sits at the end of the file, so the
// tail is fetched up front into the sparse part file — without it, playback
// cannot start until the whole sequential download has finished.
const TAIL_FETCH_BYTES: u64 = 2 * 1024 * 1024;
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);
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

// One client per runtime kind, reused for every request: a fresh client
// drops the connection pool and pays a new TLS handshake per image.
static HTTP_BLOCKING: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
static HTTP_ASYNC: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn http_client() -> Result<reqwest::blocking::Client, CmdError> {
    HTTP_BLOCKING
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
                .build()
                .map_err(|e| e.to_string())
        })
        .clone()
        .map_err(|e| CmdError::new("internal", e.clone()))
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

fn diag_log(app: &AppHandle, line: &str) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("fetch.log");
    let mut line = line.to_string();
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 256 * 1024 {
            line.insert(0, '\n');
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    line.insert_str(0, &format!("[{stamp}] "));
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

fn fetch_posts_blocking(
    app: &AppHandle,
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

    // Diagnostics — credentials are masked, never logged.
    let masked = url
        .as_str()
        .replace(api_key.trim(), "«key»")
        .replace(user_id.trim(), "«id»");
    diag_log(app, &format!("GET {masked}"));

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
    let parsed = parse_page(&text)?;
    diag_log(
        app,
        &format!(
            "status={} body_bytes={} total={} posts={}",
            status,
            text.len(),
            parsed.total,
            parsed.posts.len()
        ),
    );
    if parsed.posts.is_empty() {
        let head: String = text.chars().take(300).collect();
        diag_log(app, &format!("body head: {head}"));
    }
    Ok(parsed)
}

#[tauri::command]
async fn fetch_posts(
    app: AppHandle,
    user_id: String,
    api_key: String,
    tags: Vec<String>,
    page: u32,
    limit: u32,
) -> Result<PageResult, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_posts_blocking(&app, &user_id, &api_key, &tags, page, limit)
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

fn is_supported_media(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    let jpeg = bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
    let png = bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47;
    let gif = &bytes[0..4] == b"GIF8";
    let webp = &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
    // MP4/MOV carry their brand at bytes 4..8; WebM/MKV start with EBML.
    let mp4 = &bytes[4..8] == b"ftyp";
    let matroska = &bytes[0..4] == &[0x1A, 0x45, 0xDF, 0xA3];
    jpeg || png || gif || webp || mp4 || matroska
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
    if !is_supported_media(&bytes) {
        return Err(CmdError::new(
            "blocked",
            "The image host returned a non-image response.",
        ));
    }
    Ok(bytes)
}

fn validate_image_url(url: &str) -> Result<url::Url, CmdError> {
    let parsed = url::Url::parse(url).map_err(|_| CmdError::new("internal", "Invalid image URL."))?;
    let host_ok = parsed
        .host_str()
        .map(|h| h.ends_with("gelbooru.com"))
        .unwrap_or(false);
    if !host_ok {
        return Err(CmdError::new("internal", "Unexpected image host."));
    }
    Ok(parsed)
}

// Media client: no total timeout (large videos), but connection and
// idle-read limits so a stalled host surfaces as a network error.
fn media_client() -> Result<reqwest::Client, CmdError> {
    HTTP_ASYNC
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .connect_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
                .read_timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
                .build()
                .map_err(|e| e.to_string())
        })
        .clone()
        .map_err(|e| CmdError::new("internal", e.clone()))
}

#[derive(Clone, Debug)]
enum TaskStatus {
    Running,
    Done,
    Failed(String, String), // error kind, detail
}

struct TaskInner {
    status: TaskStatus,
    total: Option<u64>,
    // Contiguous prefix [0, received) written by the sequential download.
    received: u64,
    // The tail range [tail_start, total) is fetched in parallel; tail_done
    // means those bytes are on disk. Everything else beyond `received` is a
    // hole and must never be served.
    tail_start: Option<u64>,
    tail_done: bool,
    tail_failed: bool,
}

struct TaskShared {
    inner: Mutex<TaskInner>,
    cond: Condvar,
}

impl TaskShared {
    fn new() -> Self {
        Self {
            inner: Mutex::new(TaskInner {
                status: TaskStatus::Running,
                total: None,
                received: 0,
                tail_start: None,
                tail_done: false,
                tail_failed: false,
            }),
            cond: Condvar::new(),
        }
    }
}

// One entry per in-flight-or-done download, keyed by cache file name;
// concurrent requests for the same URL share the task.
#[derive(Default)]
struct MediaTasks {
    tasks: Mutex<HashMap<String, Arc<TaskShared>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaProgress {
    name: String,
    received: u64,
    total: Option<u64>,
    done: bool,
    failed: bool,
}

fn emit_progress(app: &AppHandle, name: &str, shared: &TaskShared) {
    let progress = {
        let inner = shared.inner.lock().unwrap();
        MediaProgress {
            name: name.to_string(),
            received: inner.received,
            total: inner.total,
            done: matches!(inner.status, TaskStatus::Done),
            failed: matches!(inner.status, TaskStatus::Failed(_, _)),
        }
    };
    let _ = app.emit("media://progress", progress);
}

fn partial_name(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, _)) => format!("{stem}.part"),
        None => format!("{name}.part"),
    }
}

fn prepare_sync(
    app: &AppHandle,
    url: &str,
) -> Result<(String, Option<Arc<TaskShared>>, bool), CmdError> {
    let parsed = validate_image_url(url)?;
    let name = cache_file_name(&parsed)?;
    let dir = images_dir(app)?;
    if dir.join(&name).exists() {
        return Ok((name, None, true));
    }
    let tasks = app.state::<MediaTasks>();
    let mut map = tasks.tasks.lock().unwrap();
    if let Some(existing) = map.get(&name) {
        let reusable = !matches!(
            existing.inner.lock().unwrap().status,
            TaskStatus::Failed(_, _)
        );
        if reusable {
            return Ok((name, Some(existing.clone()), false));
        }
    }
    let shared = Arc::new(TaskShared::new());
    map.insert(name.clone(), shared.clone());
    drop(map);
    let app2 = app.clone();
    let parsed2 = parsed.clone();
    let name2 = name.clone();
    let task = shared.clone();
    tauri::async_runtime::spawn(async move {
        download_task(app2, parsed2, name2, task).await;
    });
    Ok((name, Some(shared), false))
}

async fn download_task(
    app: AppHandle,
    parsed: url::Url,
    name: String,
    shared: Arc<TaskShared>,
) {
    let dir = match images_dir(&app) {
        Ok(dir) => dir,
        Err(e) => {
            finish_task(&app, &name, &shared, Err((e.kind, e.detail)));
            return;
        }
    };
    let final_path = dir.join(&name);
    let part_path = dir.join(partial_name(&name));
    let outcome = stream_download(&app, &parsed, &name, &part_path, &shared).await;
    if let Err(_) = &outcome {
        let _ = fs::remove_file(&part_path);
    } else if let Err(e) = fs::rename(&part_path, &final_path) {
        finish_task(
            &app,
            &name,
            &shared,
            Err(("internal".to_string(), e.to_string())),
        );
        return;
    }
    finish_task(&app, &name, &shared, outcome);
}

fn finish_task(
    app: &AppHandle,
    name: &str,
    shared: &TaskShared,
    outcome: Result<(), (String, String)>,
) {
    {
        let mut inner = shared.inner.lock().unwrap();
        inner.status = match &outcome {
            Ok(()) => TaskStatus::Done,
            Err((kind, detail)) => TaskStatus::Failed(kind.clone(), detail.clone()),
        };
    }
    shared.cond.notify_all();
    emit_progress(app, name, shared);
    if let Err((kind, detail)) = &outcome {
        diag_log(app, &format!("download \"{name}\": {kind} — {detail}"));
    }
}

async fn stream_download(
    app: &AppHandle,
    parsed: &url::Url,
    name: &str,
    part_path: &Path,
    shared: &Arc<TaskShared>,
) -> Result<(), (String, String)> {
    let client =
        media_client().map_err(|e| (e.kind.clone(), e.detail.clone()))?;
    let mut response = client
        .get(parsed.clone())
        .header(reqwest::header::REFERER, IMAGE_REFERER)
        .send()
        .await
        .map_err(|_| {
            (
                "network".to_string(),
                "Image download failed — check your connection.".to_string(),
            )
        })?;
    let status = response.status();
    if !(200..300).contains(&status.as_u16()) {
        return Err((
            "server".to_string(),
            format!("The image server replied with HTTP {status}."),
        ));
    }
    {
        let mut inner = shared.inner.lock().unwrap();
        inner.total = response.content_length();
    }
    shared.cond.notify_all();

    let mut file = fs::File::create(part_path)
        .map_err(|e| ("internal".to_string(), e.to_string()))?;
    if let Some(total) = response.content_length() {
        // Pre-size the part file so the parallel tail fetch can write at its
        // offsets while the sequential pass is still filling the front.
        file.set_len(total)
            .map_err(|e| ("internal".to_string(), e.to_string()))?;
    }
    if let Some(total) = response.content_length() {
        if is_video_name(name) && total > TAIL_FETCH_BYTES * 2 {
            let tail_start = total - TAIL_FETCH_BYTES;
            {
                let mut inner = shared.inner.lock().unwrap();
                inner.tail_start = Some(tail_start);
            }
            let tail_shared = Arc::clone(shared);
            let tail_part = part_path.to_path_buf();
            let tail_parsed = parsed.clone();
            tauri::async_runtime::spawn(async move {
                fetch_tail(tail_parsed, tail_part, tail_start, total, tail_shared).await;
            });
        }
    }
    // The magic-byte check gates every write: nothing lands on disk (or gets
    // served) until the head proves it is not the hotlink-block page.
    let mut head: Vec<u8> = Vec::with_capacity(16);
    let mut head_flushed = false;
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    loop {
        let chunk = response.chunk().await.map_err(|_| {
            (
                "network".to_string(),
                "Image download failed — check your connection.".to_string(),
            )
        })?;
        let Some(bytes) = chunk else {
            break;
        };
        let mut pending: &[u8] = &bytes;
        if !head_flushed {
            let need = 12 - head.len();
            let take = need.min(pending.len());
            head.extend_from_slice(&pending[..take]);
            pending = &pending[take..];
            if head.len() >= 12 {
                if !is_supported_media(&head) {
                    return Err((
                        "blocked".to_string(),
                        "The image host returned a non-image response.".to_string(),
                    ));
                }
                file.write_all(&head)
                    .map_err(|e| ("internal".to_string(), e.to_string()))?;
                received += head.len() as u64;
                head_flushed = true;
            }
        }
        if !pending.is_empty() {
            file.write_all(pending)
                .map_err(|e| ("internal".to_string(), e.to_string()))?;
            received += pending.len() as u64;
        }
        {
            let mut inner = shared.inner.lock().unwrap();
            inner.received = received;
        }
        shared.cond.notify_all();
        if last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
            last_emit = Instant::now();
            emit_progress(app, name, shared);
        }
    }
    if !head_flushed {
        return Err((
            "blocked".to_string(),
            "The image host returned a non-image response.".to_string(),
        ));
    }
    file.flush()
        .map_err(|e| ("internal".to_string(), e.to_string()))?;
    Ok(())
}

fn is_video_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".mp4", ".webm", ".mkv", ".mov", ".m4v"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

// Fetch the file's tail into the sparse part file up front. A failed or
// partial tail fetch only delays playback until the sequential pass covers
// the same bytes; the waiting tail branch is woken either way.
async fn fetch_tail(
    parsed: url::Url,
    part_path: PathBuf,
    tail_start: u64,
    total: u64,
    shared: Arc<TaskShared>,
) {
    let result: Result<(), ()> = async {
        let client = media_client().map_err(|_| ())?;
        let mut response = client
            .get(parsed)
            .header(reqwest::header::REFERER, IMAGE_REFERER)
            .header(reqwest::header::RANGE, format!("bytes={tail_start}-"))
            .send()
            .await
            .map_err(|_| ())?;
        // A 200 means the host ignored the range; writing it at tail_start
        // would put the wrong bytes in the file, so abort and let the
        // sequential pass fill the tail instead.
        if response.status().as_u16() != 206 {
            return Err(());
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(&part_path)
            .map_err(|_| ())?;
        file.seek(SeekFrom::Start(tail_start)).map_err(|_| ())?;
        let mut offset = tail_start;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    file.write_all(&chunk).map_err(|_| ())?;
                    offset += chunk.len() as u64;
                }
                Ok(None) => break,
                Err(_) => return Err(()),
            }
        }
        if offset < total {
            return Err(());
        }
        Ok(())
    }
    .await;
    {
        let mut inner = shared.inner.lock().unwrap();
        match result {
            Ok(()) => inner.tail_done = true,
            Err(()) => inner.tail_failed = true,
        }
        shared.cond.notify_all();
    }
}

fn wait_for_task(shared: &Arc<TaskShared>, cap_secs: u64) -> Result<TaskStatus, ()> {
    let deadline = Instant::now() + Duration::from_secs(cap_secs);
    let mut inner = shared.inner.lock().unwrap();
    loop {
        if !matches!(inner.status, TaskStatus::Running) {
            return Ok(inner.status.clone());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(());
        }
        let (guard, _) = shared
            .cond
            .wait_timeout_while(inner, deadline.saturating_duration_since(now), |g| {
                matches!(g.status, TaskStatus::Running)
            })
            .unwrap();
        inner = guard;
    }
}

// Wait until at least `min_received` bytes are on disk, or the task ends.
fn wait_for_bytes(
    shared: &Arc<TaskShared>,
    min_received: u64,
    cap_secs: u64,
) -> Result<TaskStatus, ()> {
    let deadline = Instant::now() + Duration::from_secs(cap_secs);
    let mut inner = shared.inner.lock().unwrap();
    loop {
        if !matches!(inner.status, TaskStatus::Running) || inner.received >= min_received {
            return Ok(inner.status.clone());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(());
        }
        let (guard, _) = shared
            .cond
            .wait_timeout_while(inner, deadline.saturating_duration_since(now), |g| {
                matches!(g.status, TaskStatus::Running) && g.received < min_received
            })
            .unwrap();
        inner = guard;
    }
}

// Wait until the parallel tail fetch finishes (or fails) — without waiting
// for the sequential download, which reaches the tail region last.
fn wait_for_tail(shared: &Arc<TaskShared>, cap_secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(cap_secs);
    let mut inner = shared.inner.lock().unwrap();
    loop {
        if inner.tail_done || inner.tail_failed || !matches!(inner.status, TaskStatus::Running) {
            return inner.tail_done;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let (guard, _) = shared
            .cond
            .wait_timeout_while(inner, deadline.saturating_duration_since(now), |g| {
                !g.tail_done && !g.tail_failed && matches!(g.status, TaskStatus::Running)
            })
            .unwrap();
        inner = guard;
    }
}

// Wait until the total size is known (from Content-Length) or the task ends.
fn wait_for_total(
    shared: &Arc<TaskShared>,
    cap_secs: u64,
) -> Result<(TaskStatus, Option<u64>), ()> {
    let deadline = Instant::now() + Duration::from_secs(cap_secs);
    let mut inner = shared.inner.lock().unwrap();
    loop {
        if !matches!(inner.status, TaskStatus::Running) || inner.total.is_some() {
            return Ok((inner.status.clone(), inner.total));
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(());
        }
        let (guard, _) = shared
            .cond
            .wait_timeout_while(inner, deadline.saturating_duration_since(now), |g| {
                matches!(g.status, TaskStatus::Running) && g.total.is_none()
            })
            .unwrap();
        inner = guard;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareResult {
    name: String,
    cached: bool,
}

// Starts the download (unless cached or already running) and returns
// immediately so the UI can begin progressive display.
#[tauri::command]
async fn prepare_media(app: AppHandle, url: String) -> Result<PrepareResult, CmdError> {
    let (name, _, cached) =
        tauri::async_runtime::spawn_blocking(move || prepare_sync(&app, &url))
            .await
            .map_err(|e| CmdError::new("internal", e.to_string()))??;
    Ok(PrepareResult { name, cached })
}

// Pure cache lookup; never starts a download.
#[tauri::command]
async fn cached_media(app: AppHandle, url: String) -> Result<Option<String>, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = validate_image_url(&url)?;
        let name = cache_file_name(&parsed)?;
        let dir = images_dir(&app)?;
        Ok(if dir.join(&name).exists() { Some(name) } else { None })
    })
    .await
    .map_err(|e| CmdError::new("internal", e.to_string()))?
}

// Resolves only once the file is fully cached.
#[tauri::command]
async fn download_image(app: AppHandle, url: String) -> Result<String, CmdError> {
    let (name, task, cached) =
        tauri::async_runtime::spawn_blocking(move || prepare_sync(&app, &url))
            .await
            .map_err(|e| CmdError::new("internal", e.to_string()))??;
    if cached {
        return Ok(name);
    }
    let shared =
        task.ok_or_else(|| CmdError::new("internal", "Download task missing."))?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        wait_for_task(&shared, DOWNLOAD_WAIT_SECS)
    })
    .await
    .map_err(|e| CmdError::new("internal", e.to_string()))?;
    match result {
        Ok(TaskStatus::Done) => Ok(name),
        Ok(TaskStatus::Failed(kind, detail)) => Err(CmdError { kind, detail }),
        _ => Err(CmdError::new(
            "network",
            "Download timed out — check your connection.",
        )),
    }
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSuggestion {
    name: String,
    count: u64,
}

#[derive(Deserialize, Default)]
struct RawTag {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    count: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawTagResponse {
    #[serde(default)]
    tag: Option<serde_json::Value>,
}

#[tauri::command]
async fn suggest_tags(
    app: AppHandle,
    user_id: String,
    api_key: String,
    prefix: String,
) -> Result<Vec<TagSuggestion>, CmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        let prefix = prefix.trim().to_string();
        if prefix.is_empty() || user_id.trim().is_empty() || api_key.trim().is_empty() {
            return Ok(Vec::new());
        }
        // `name` is an exact lookup; autocomplete needs the LIKE wildcard
        // `name_pattern` (trailing % = starts-with), highest-count tags first.
        let pattern = format!("{}%", prefix);
        let url = format!(
            "{TAG_API_BASE}&name_pattern={}&limit=10&orderby=count&order=DESC&user_id={}&api_key={}",
            encode_token(&pattern),
            encode_token(user_id.trim()),
            encode_token(api_key.trim())
        );
        let url =
            url::Url::parse(&url).map_err(|e| CmdError::new("internal", e.to_string()))?;
        let response = http_client()?
            .get(url)
            .send()
            .map_err(|_| CmdError::new("network", "Could not reach Gelbooru — check your connection."))?;
        let status = response.status();
        if !(200..300).contains(&status.as_u16()) {
            return Err(CmdError::new(
                "server",
                format!("Gelbooru replied with HTTP {status}."),
            ));
        }
        let text = response
            .text()
            .map_err(|e| CmdError::new("network", e.to_string()))?;
        let parsed: RawTagResponse = serde_json::from_str(&text)
            .map_err(|e| CmdError::new("server", format!("Malformed response: {e}")))?;
        let raw = match parsed.tag {
            Some(serde_json::Value::Array(items)) => items,
            Some(item @ serde_json::Value::Object(_)) => vec![item],
            _ => Vec::new(),
        };
        let mut out = Vec::new();
        for item in raw {
            let t: RawTag = serde_json::from_value(item)
                .map_err(|e| CmdError::new("server", format!("Malformed tag: {e}")))?;
            let name = t.name.unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let count = match t.count {
                Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
                Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0),
                _ => 0,
            };
            out.push(TagSuggestion { name, count });
        }
        diag_log(&app, &format!("suggest \"{prefix}\" -> {} tags", out.len()));
        Ok(out)
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

#[derive(Debug, Clone, Copy)]
enum ByteRange {
    // "bytes=start-" or "bytes=start-end"
    From { start: usize, end: Option<usize> },
    // "bytes=-suffix" — the final N bytes (media stacks use this for
    // end-of-file indexes in WebM/MKV)
    Last(usize),
}

fn parse_byte_range(value: &str) -> Option<ByteRange> {
    let value = value.strip_prefix("bytes=")?;
    let (first, second) = value.split_once('-')?;
    if first.is_empty() {
        let n: usize = second.parse().ok()?;
        return Some(ByteRange::Last(n));
    }
    let start: usize = first.parse().ok()?;
    let end = if second.is_empty() {
        None
    } else {
        Some(second.parse::<usize>().ok()?)
    };
    if let Some(e) = end {
        if e < start {
            return None;
        }
    }
    Some(ByteRange::From { start, end })
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
    } else if lower.ends_with(".webm") || lower.ends_with(".mkv") {
        "video/webm"
    } else if lower.ends_with(".mov") {
        "video/quicktime"
    } else {
        "image/jpeg"
    }
}

fn cache_response(
    status: u16,
    mime: &str,
    body: Vec<u8>,
    content_range: Option<String>,
) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        // The webview fetches partial prefixes for progressive image paint.
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Length", body.len());
    if let Some(range) = content_range {
        builder = builder.header("Content-Range", range);
    }
    match builder.body(body) {
        Ok(response) => response,
        Err(_) => tauri::http::Response::new(b"error".to_vec()),
    }
}

fn not_found() -> tauri::http::Response<Vec<u8>> {
    cache_response(404, "text/plain", b"not found".to_vec(), None)
}

fn request_timeout() -> tauri::http::Response<Vec<u8>> {
    cache_response(408, "text/plain", b"download still in progress".to_vec(), None)
}

fn read_slice(path: &Path, start: usize, len: usize) -> Option<Vec<u8>> {
    if len == 0 {
        return Some(Vec::new());
    }
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(start as u64)).ok()?;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn serve_file(path: &Path, name: &str, range: Option<ByteRange>) -> tauri::http::Response<Vec<u8>> {
    let total = fs::metadata(path).map(|m| m.len() as usize).unwrap_or(0);
    let mime = mime_for(name);
    match range {
        None => match fs::read(path) {
            Ok(bytes) => cache_response(200, mime, bytes, None),
            Err(_) => not_found(),
        },
        Some(ByteRange::From { start, end }) => {
            if total == 0 || start >= total {
                return cache_response(
                    416,
                    "text/plain",
                    b"range not satisfiable".to_vec(),
                    Some(format!("bytes */{total}")),
                );
            }
            let end = end.unwrap_or(total - 1).min(total - 1).max(start);
            match read_slice(path, start, end - start + 1) {
                Some(slice) => cache_response(
                    206,
                    mime,
                    slice,
                    Some(format!("bytes {start}-{end}/{total}")),
                ),
                None => not_found(),
            }
        }
        Some(ByteRange::Last(n)) => {
            if total == 0 {
                return not_found();
            }
            let n = n.min(total);
            let start = total - n;
            match read_slice(path, start, n) {
                Some(slice) => cache_response(
                    206,
                    mime,
                    slice,
                    Some(format!("bytes {start}-{}/{total}", total - 1)),
                ),
                None => not_found(),
            }
        }
    }
}

// File not complete yet: answer from the in-flight download. Open-ended ranges
// get whatever prefix exists (the media stack re-requests as it consumes);
// reads beyond the frontier wait for the bytes to land.
async fn serve_live(
    app: &AppHandle,
    name: &str,
    final_path: &Path,
    part_path: &Path,
    shared: Arc<TaskShared>,
    range: Option<ByteRange>,
) -> tauri::http::Response<Vec<u8>> {
    // Serving-side failures never reach the download log; record them so a
    // client-visible "failed" is always explainable from fetch.log.
    let reject = |code: u16| {
        diag_log(app, &format!("serve {code} \"{name}\" range={range:?}"));
        if code == 404 {
            not_found()
        } else {
            request_timeout()
        }
    };
    match range {
        // Plain loads cannot paint a partial image, so hold until whole.
        None => {
            let waiter = shared.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                wait_for_task(&waiter, RANGE_WAIT_SECS)
            })
            .await
            .unwrap_or(Err(()))
            {
                Ok(TaskStatus::Done) => serve_file(final_path, name, None),
                Ok(TaskStatus::Failed(_, _)) => reject(404),
                _ => reject(408),
            }
        }
        Some(ByteRange::From { start, end }) => {
            let waiter = shared.clone();
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                wait_for_bytes(&waiter, start as u64 + 1, RANGE_WAIT_SECS)
            })
            .await
            .unwrap_or(Err(()));
            match outcome {
                Err(()) => reject(408),
                Ok(TaskStatus::Failed(_, _)) => reject(404),
                Ok(TaskStatus::Done) => serve_file(final_path, name, range),
                Ok(TaskStatus::Running) => {
                    let received = shared.inner.lock().unwrap().received as usize;
                    let served_end = end.unwrap_or(usize::MAX).min(received - 1).max(start);
                    let total = shared
                        .inner
                        .lock()
                        .unwrap()
                        .total
                        .map(|t| t.to_string())
                        .unwrap_or_else(|| "*".to_string());
                    match read_slice(part_path, start, served_end - start + 1) {
                        Some(slice) => cache_response(
                            206,
                            mime_for(name),
                            slice,
                            Some(format!("bytes {start}-{served_end}/{total}")),
                        ),
                        None => reject(404),
                    }
                }
            }
        }
        Some(ByteRange::Last(n)) => {
            let waiter = shared.clone();
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                wait_for_total(&waiter, RANGE_WAIT_SECS)
            })
            .await
            .unwrap_or(Err(()));
            let (status, total) = match outcome {
                Ok(pair) => pair,
                Err(()) => return reject(408),
            };
            if matches!(status, TaskStatus::Failed(_, _)) {
                return reject(404);
            }
            let total = match total {
                Some(t) => t as usize,
                None => {
                    // Unknown length: only the finished file can answer.
                    let waiter = shared.clone();
                    match tauri::async_runtime::spawn_blocking(move || {
                        wait_for_task(&waiter, RANGE_WAIT_SECS)
                    })
                    .await
                    .unwrap_or(Err(()))
                    {
                        Ok(TaskStatus::Done) => return serve_file(final_path, name, range),
                        Ok(TaskStatus::Failed(_, _)) => return reject(404),
                        _ => return reject(408),
                    }
                }
            };
            if matches!(status, TaskStatus::Done) {
                return serve_file(final_path, name, range);
            }
            let n = n.min(total);
            let start = total - n;
            let waiter = shared.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                wait_for_bytes(&waiter, start as u64 + 1, RANGE_WAIT_SECS)
            })
            .await
            .unwrap_or(Err(()))
            {
                Ok(TaskStatus::Done) => serve_file(final_path, name, range),
                Ok(TaskStatus::Failed(_, _)) => reject(404),
                Ok(TaskStatus::Running) => match read_slice(part_path, start, n) {
                    Some(slice) => cache_response(
                        206,
                        mime_for(name),
                        slice,
                        Some(format!("bytes {start}-{}/{total}", total - 1)),
                    ),
                    None => reject(404),
                },
                Err(()) => reject(408),
            }
        }
    }
}

async fn serve_cache_request(
    app: AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
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
    let range = request
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_byte_range);

    let dir = images_dir(&app).unwrap_or_default();
    let final_path = dir.join(&sanitized);
    if final_path.exists() {
        return serve_file(&final_path, &sanitized, range);
    }
    let shared = app
        .state::<MediaTasks>()
        .tasks
        .lock()
        .unwrap()
        .get(&sanitized)
        .cloned();
    match shared {
        Some(shared) => {
            let part_path = dir.join(partial_name(&sanitized));
            serve_live(&app, &sanitized, &final_path, &part_path, shared, range).await
        }
        None => {
            diag_log(&app, &format!("serve 404 \"{}\" range={range:?} (no task)", sanitized));
            not_found()
        }
    }
}

// Loopback server for media the webview cannot fetch over gvcache://: the
// WebKitGTK media stack bypasses custom URI scheme handlers entirely (webkit
// bug 146351), so <video> loads go to http://127.0.0.1/<token>/<name> instead.
// The random per-session token keeps other local processes out of the cache.
struct MediaServer {
    base_url: String,
}

fn start_media_server(app: AppHandle) -> Result<MediaServer, CmdError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| CmdError::new("internal", e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| CmdError::new("internal", e.to_string()))?
        .port();
    let mut token_bytes = [0u8; 16];
    getrandom::fill(&mut token_bytes).map_err(|e| CmdError::new("internal", e.to_string()))?;
    let token: String = token_bytes.iter().map(|b| format!("{b:02x}")).collect();
    let base_url = format!("http://127.0.0.1:{port}/{token}");
    let accept_app = app.clone();
    let accept_token = token;
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = accept_app.clone();
            let token = accept_token.clone();
            std::thread::spawn(move || handle_media_conn(stream, app, &token));
        }
    });
    Ok(MediaServer { base_url })
}

fn handle_media_conn(mut stream: TcpStream, app: AppHandle, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_half).take(16 * 1024);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    // "GET /<token>/<name> HTTP/1.1"
    let target = request_line.split_whitespace().nth(1).unwrap_or_default();
    let name = match target.strip_prefix(&format!("/{token}/")) {
        Some(name) if !name.is_empty() && !name.contains('/') => name.to_string(),
        _ => {
            let _ = write_http_head(&stream, 404, "text/plain", 9, None);
            let _ = stream.write_all(b"not found");
            return;
        }
    };
    let mut range = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("range:") {
            range = parse_byte_range(value.trim());
        }
    }

    let dir = match images_dir(&app) {
        Ok(dir) => dir,
        Err(_) => {
            let _ = write_http_head(&stream, 404, "text/plain", 9, None);
            let _ = stream.write_all(b"not found");
            return;
        }
    };
    let final_path = dir.join(&name);
    if final_path.exists() {
        serve_media_file(&stream, &final_path, &name, range);
        return;
    }
    let shared = app
        .state::<MediaTasks>()
        .tasks
        .lock()
        .unwrap()
        .get(&name)
        .cloned();
    match shared {
        Some(shared) => serve_media_partial(&stream, &app, &dir, &name, range, shared),
        None => {
            let _ = write_http_head(&stream, 404, "text/plain", 9, None);
            let _ = stream.write_all(b"not found");
        }
    }
}

fn write_http_head(
    mut stream: &TcpStream,
    status: u16,
    mime: &str,
    len: u64,
    content_range: Option<String>,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        206 => "Partial Content",
        404 => "Not Found",
        408 => "Request Timeout",
        416 => "Range Not Satisfiable",
        _ => "Unknown",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nAccept-Ranges: bytes\r\nContent-Length: {len}\r\n"
    );
    if let Some(range) = content_range {
        head.push_str(&format!("Content-Range: {range}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())
}

// Stream a byte range of a file straight off disk — a multi-gigabyte video
// must never be buffered into memory just to answer one request.
fn stream_file_range(
    mut stream: &TcpStream,
    path: &Path,
    offset: u64,
    len: u64,
) -> std::io::Result<()> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut remaining = len;
    let mut buf = vec![0u8; 256 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        stream.write_all(&buf[..n])?;
        remaining -= n as u64;
    }
    Ok(())
}

// A fully cached file: answer any range by streaming it.
fn serve_media_file(mut stream: &TcpStream, path: &Path, name: &str, range: Option<ByteRange>) {
    let total = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if total == 0 {
        let _ = write_http_head(stream, 404, "text/plain", 9, None);
        let _ = stream.write_all(b"not found");
        return;
    }
    let mime = mime_for(name);
    let (offset, len, status, content_range) = match range {
        None => (0, total, 200u16, None),
        Some(ByteRange::From { start, end }) => {
            let start = start as u64;
            let end = end.map(|e| e as u64);
            if start >= total {
                let _ = write_http_head(
                    stream,
                    416,
                    "text/plain",
                    21,
                    Some(format!("bytes */{total}")),
                );
                let _ = stream.write_all(b"range not satisfiable");
                return;
            }
            let end = end.unwrap_or(total - 1).min(total - 1).max(start);
            (
                start,
                end - start + 1,
                206u16,
                Some(format!("bytes {start}-{end}/{total}")),
            )
        }
        Some(ByteRange::Last(n)) => {
            let n = (n as u64).min(total);
            (
                total - n,
                n,
                206u16,
                Some(format!("bytes {}-{}/{total}", total - n, total - 1)),
            )
        }
    };
    if write_http_head(stream, status, mime, len, content_range).is_ok() {
        let _ = stream_file_range(stream, path, offset, len);
    }
}

fn serve_part_prefix(
    stream: &TcpStream,
    part_path: &Path,
    name: &str,
    start: u64,
    end_inclusive: u64,
    total: u64,
) {
    let len = end_inclusive - start + 1;
    let content_range = format!("bytes {start}-{end_inclusive}/{total}");
    if write_http_head(stream, 206, mime_for(name), len, Some(content_range)).is_ok() {
        let _ = stream_file_range(stream, part_path, start, len);
    }
}

// An in-flight download: the sequential prefix [0, received) and, for videos,
// the fetched tail are served; holes between them are never sent.
fn serve_media_partial(
    mut stream: &TcpStream,
    app: &AppHandle,
    dir: &Path,
    name: &str,
    range: Option<ByteRange>,
    shared: Arc<TaskShared>,
) {
    let final_path = dir.join(name);
    let part_path = dir.join(partial_name(name));
    // Serving-side failures never reach the download log; record them so a
    // client-visible "failed" is always explainable from fetch.log.
    let reject = |code: u16| {
        diag_log(app, &format!("serve {code} \"{name}\" range={range:?}"));
    };
    if matches!(shared.inner.lock().unwrap().status, TaskStatus::Failed(_, _)) {
        reject(404);
        let _ = write_http_head(stream, 404, "text/plain", 9, None);
        let _ = stream.write_all(b"not found");
        return;
    }
    let complete = || serve_media_file(stream, &final_path, name, range);
    match range {
        // Plain load: answer with the prefix already on disk as a partial
        // response; the media stack continues with ranged requests.
        None => match wait_for_bytes(&shared, 1, RANGE_WAIT_SECS) {
            Err(()) => {
                reject(408);
                let _ = write_http_head(stream, 408, "text/plain", 25, None);
                let _ = stream.write_all(b"download still in progress");
            }
            Ok(TaskStatus::Done) => complete(),
            Ok(TaskStatus::Failed(_, _)) => {
                reject(404);
                let _ = write_http_head(stream, 404, "text/plain", 9, None);
                let _ = stream.write_all(b"not found");
            }
            Ok(TaskStatus::Running) => {
                let inner = shared.inner.lock().unwrap();
                let (received, total) = (inner.received, inner.total);
                drop(inner);
                match total {
                    // Without a known length no valid Content-Range exists.
                    Some(total) => serve_part_prefix(stream, &part_path, name, 0, received - 1, total),
                    None => {
                        reject(408);
                        let _ = write_http_head(stream, 408, "text/plain", 25, None);
                        let _ = stream.write_all(b"download still in progress");
                    }
                }
            }
        },
        Some(ByteRange::From { start, end }) => {
            let start = start as u64;
            let end = end.map(|e| e as u64);
            let (tail_start, tail_done, total) = {
                let inner = shared.inner.lock().unwrap();
                (inner.tail_start, inner.tail_done, inner.total)
            };
            if let Some(total) = total {
                if start >= total {
                    let _ = write_http_head(
                        stream,
                        416,
                        "text/plain",
                        21,
                        Some(format!("bytes */{total}")),
                    );
                    let _ = stream.write_all(b"range not satisfiable");
                    return;
                }
                // The tail fetch owns [tail_start, total): wait for it rather
                // than for the sequential download, which gets there last.
                if let Some(tail_start) = tail_start {
                    if start >= tail_start {
                        let done = tail_done || wait_for_tail(&shared, RANGE_WAIT_SECS);
                        if done {
                            let end = end.unwrap_or(total - 1).min(total - 1).max(start);
                            serve_part_prefix(stream, &part_path, name, start, end, total);
                            return;
                        }
                        // Tail fetch failed: the sequential pass still has to
                        // reach these bytes.
                    }
                }
            }
            match wait_for_bytes(&shared, start + 1, RANGE_WAIT_SECS) {
                Err(()) => {
                    reject(408);
                    let _ = write_http_head(stream, 408, "text/plain", 25, None);
                    let _ = stream.write_all(b"download still in progress");
                }
                Ok(TaskStatus::Done) => complete(),
                Ok(TaskStatus::Failed(_, _)) => {
                    reject(404);
                    let _ = write_http_head(stream, 404, "text/plain", 9, None);
                    let _ = stream.write_all(b"not found");
                }
                Ok(TaskStatus::Running) => {
                    let inner = shared.inner.lock().unwrap();
                    let (received, total) = (inner.received, inner.total);
                    drop(inner);
                    match total {
                        Some(total) => {
                            serve_part_prefix(stream, &part_path, name, start, received - 1, total)
                        }
                        None => {
                            reject(408);
                            let _ = write_http_head(stream, 408, "text/plain", 25, None);
                            let _ = stream.write_all(b"download still in progress");
                        }
                    }
                }
            }
        }
        Some(ByteRange::Last(n)) => {
            let n = n as u64;
            let outcome = wait_for_total(&shared, RANGE_WAIT_SECS);
            let (status, total) = match outcome {
                Ok(pair) => pair,
                Err(()) => {
                    reject(408);
                    let _ = write_http_head(stream, 408, "text/plain", 25, None);
                    let _ = stream.write_all(b"download still in progress");
                    return;
                }
            };
            let Some(total) = total else {
                // Unknown length: only the finished file can answer.
                match wait_for_task(&shared, RANGE_WAIT_SECS) {
                    Ok(TaskStatus::Done) => complete(),
                    _ => {
                        reject(404);
                        let _ = write_http_head(stream, 404, "text/plain", 9, None);
                        let _ = stream.write_all(b"not found");
                    }
                }
                return;
            };
            if matches!(status, TaskStatus::Done) {
                complete();
                return;
            }
            if matches!(status, TaskStatus::Failed(_, _)) {
                reject(404);
                let _ = write_http_head(stream, 404, "text/plain", 9, None);
                let _ = stream.write_all(b"not found");
                return;
            }
            let (tail_start, tail_done) = {
                let inner = shared.inner.lock().unwrap();
                (inner.tail_start, inner.tail_done)
            };
            // The end of the file is exactly what the tail fetch downloads:
            // wait for it instead of the sequential frontier, which arrives
            // last. This is the request players use to reach MP4 metadata.
            let tail_covered = matches!(tail_start, Some(ts) if n <= total - ts);
            if tail_covered {
                let done = tail_done || wait_for_tail(&shared, RANGE_WAIT_SECS);
                if done {
                    serve_part_prefix(stream, &part_path, name, total - n, total - 1, total);
                    return;
                }
            }
            match wait_for_bytes(&shared, total - n + 1, RANGE_WAIT_SECS) {
                Err(()) => {
                    reject(408);
                    let _ = write_http_head(stream, 408, "text/plain", 25, None);
                    let _ = stream.write_all(b"download still in progress");
                }
                Ok(TaskStatus::Done) => complete(),
                Ok(TaskStatus::Failed(_, _)) => {
                    reject(404);
                    let _ = write_http_head(stream, 404, "text/plain", 9, None);
                    let _ = stream.write_all(b"not found");
                }
                // The sequential writer has reached the requested tail bytes.
                Ok(TaskStatus::Running) => {
                    serve_part_prefix(stream, &part_path, name, total - n, total - 1, total);
                }
            }
        }
    }
}

#[tauri::command]
fn media_server_url(app: AppHandle) -> Result<String, CmdError> {
    app.try_state::<MediaServer>()
        .map(|server| server.base_url.clone())
        .ok_or_else(|| CmdError::new("internal", "Media server unavailable."))
}

pub fn run() {
    // The WebKitGTK DMABUF renderer freezes the UI on focus changes on common
    // driver combinations (tauri issue #13498); force the shared-memory path.
    #[cfg(target_os = "linux")]
    {
        // Read by WebKitGTK when the webview initializes; no thread exists yet.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(MediaTasks::default())
        .invoke_handler(tauri::generate_handler![
            fetch_posts,
            prepare_media,
            cached_media,
            download_image,
            download_file,
            clear_cache,
            suggest_tags,
            media_server_url
        ])
        .setup(|app| {
            // The webview's media element needs this before it can play; if the
            // loopback port cannot be opened, videos simply report load errors.
            if let Ok(server) = start_media_server(app.handle().clone()) {
                app.manage(server);
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("gvcache", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let response = serve_cache_request(app, request).await;
                responder.respond(response);
            });
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
