#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod components;
mod document;
mod export;
mod recovery;
mod workspace;

use base64::{Engine, engine::general_purpose::STANDARD};
use document::{
    CommandResult, DocumentSession, DocumentStore, OpenedDocument, bounded_read,
    existing_document_path, publish, save_document_path, supported_path,
};
use percent_encoding::percent_decode_str;
use recovery::{RecentDocument, RecoveryDraft};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, WebviewEvent, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use uuid::Uuid;

#[derive(Default)]
struct AppState(Mutex<DocumentStore>);

fn lock_store(app: &AppHandle) -> CommandResult<MutexGuard<'_, DocumentStore>> {
    app.state::<AppState>()
        .inner()
        .0
        .lock()
        .map_err(|_| "state-failed")
}

fn data_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| "app-data-unavailable")
}

fn draft_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(data_dir(app)?.join("drafts"))
}

fn remember_path(app: &AppHandle, path: &Path) {
    if let Ok(directory) = data_dir(app) {
        let _ = recovery::remember(&directory, path);
    }
}

fn focus_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn create_window(app: &AppHandle, label: &str) -> CommandResult<()> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .ok_or("window-create-failed")?
        .clone();
    config.label = label.to_owned();
    WebviewWindowBuilder::from_config(app, &config)
        .and_then(|builder| builder.build())
        .map_err(|_| "window-create-failed")?;
    Ok(())
}

fn open_path(
    app: &AppHandle,
    path: &Path,
    current_window: Option<&str>,
) -> CommandResult<Option<OpenedDocument>> {
    open_canonical_path(app, existing_document_path(path)?, current_window, None)
}

fn open_canonical_path(
    app: &AppHandle,
    path: PathBuf,
    current_window: Option<&str>,
    line: Option<u32>,
) -> CommandResult<Option<OpenedDocument>> {
    let mut store = lock_store(app)?;
    if let Some(owner) = store.owner(&path).map(str::to_owned) {
        let id = store
            .windows
            .get(&owner)
            .map(|session| session.document.document_id.clone());
        drop(store);
        focus_window(app, &owner);
        if let (Some(id), Some(line)) = (id, line) {
            workspace::request_location(app, &owner, id, line);
        }
        return Ok(None);
    }
    let session = DocumentSession::open(path.clone())?;
    let document = session.document.clone();
    let label = current_window.map_or_else(
        || format!("document-{}", Uuid::new_v4().simple()),
        str::to_owned,
    );
    store.windows.insert(label.clone(), session);
    if let (None, Some(line)) = (current_window, line) {
        store
            .workspace_locations
            .insert(label.clone(), (document.document_id.clone(), line));
    }
    remember_path(app, &path);
    drop(store);
    if current_window.is_none() {
        if let Err(error) = create_window(app, &label) {
            let mut store = lock_store(app)?;
            store.windows.remove(&label);
            store.workspace_locations.remove(&label);
            return Err(error);
        }
    }
    Ok(Some(document))
}

fn open_external_paths(app: AppHandle, paths: Vec<PathBuf>, origin: String) {
    tauri::async_runtime::spawn_blocking(move || {
        for path in paths {
            if let Err(error) = open_path(&app, &path, None) {
                let _ = app.emit_to(&origin, "extendown://document-open-error", error);
            }
        }
    });
}

fn argument_paths(args: impl IntoIterator<Item = PathBuf>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|path| supported_path(path))
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .collect()
}

#[tauri::command]
fn current_document(window: WebviewWindow) -> CommandResult<Option<OpenedDocument>> {
    let store = lock_store(window.app_handle())?;
    Ok(store
        .windows
        .get(window.label())
        .map(|session| session.document.clone()))
}

#[tauri::command]
fn new_markdown(window: WebviewWindow) -> CommandResult<OpenedDocument> {
    let mut store = lock_store(window.app_handle())?;
    let session = DocumentSession::blank();
    let document = session.document.clone();
    store.windows.insert(window.label().to_owned(), session);
    Ok(document)
}

#[tauri::command]
async fn new_document_window(app: AppHandle) -> CommandResult<()> {
    create_window(&app, &format!("document-{}", Uuid::new_v4().simple()))
}

#[tauri::command]
async fn open_markdown(window: WebviewWindow) -> CommandResult<Option<OpenedDocument>> {
    let selected = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("打开文档")
        .add_filter("Markdown / 文本", &["md", "markdown", "txt"])
        .pick_file()
        .await;
    match selected {
        Some(file) => open_path(window.app_handle(), file.path(), Some(window.label())),
        None => Ok(None),
    }
}

#[tauri::command]
fn recent_markdown(app: AppHandle) -> CommandResult<Vec<RecentDocument>> {
    Ok(recovery::recent(&data_dir(&app)?))
}

#[tauri::command]
async fn open_recent_markdown(
    window: WebviewWindow,
    id: String,
) -> CommandResult<Option<OpenedDocument>> {
    let app = window.app_handle();
    let entry = recovery::recent(&data_dir(app)?)
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or("recent-not-found")?;
    open_path(app, &entry.path, Some(window.label()))
}

async fn save_as(
    window: &WebviewWindow,
    document_id: Option<&str>,
    source: &str,
    revision: u64,
) -> CommandResult<Option<OpenedDocument>> {
    let app = window.app_handle();
    let suggestion = if let Some(document_id) = document_id {
        lock_store(app)?
            .get_mut(window.label(), document_id)?
            .document
            .name
            .clone()
    } else {
        "未命名.md".into()
    };
    let selected = rfd::AsyncFileDialog::new()
        .set_parent(window)
        .set_title("另存为")
        .set_file_name(suggestion)
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("纯文本", &["txt"])
        .save_file()
        .await;
    let Some(file) = selected else {
        return Ok(None);
    };
    let path = save_document_path(file.path())?;
    if file.path().extension().is_none() && path.exists() {
        return Err("target-already-exists");
    }
    let mut store = lock_store(app)?;
    if store
        .owner(&path)
        .is_some_and(|label| label != window.label())
    {
        return Err("path-already-open");
    }
    let document = if let Some(id) = document_id {
        store
            .get_mut(window.label(), id)?
            .save(path.clone(), source, revision)?
    } else {
        if store.windows.contains_key(window.label()) {
            return Err("document-not-found");
        }
        let mut session = DocumentSession::blank();
        let document = session.save(path.clone(), source, revision)?;
        store.windows.insert(window.label().to_owned(), session);
        document
    };
    remember_path(app, &path);
    if let Ok(directory) = draft_dir(app) {
        let _ = RecoveryDraft::discard(&directory, &document.document_id);
    }
    Ok(Some(document))
}

#[tauri::command]
async fn save_markdown(
    window: WebviewWindow,
    document_id: String,
    source: String,
    revision: u64,
) -> CommandResult<Option<OpenedDocument>> {
    let app = window.app_handle();
    let saved = {
        let mut store = lock_store(app)?;
        let session = store.get_mut(window.label(), &document_id)?;
        session
            .document
            .path
            .clone()
            .map(|path| session.save(path, &source, revision))
            .transpose()?
    };
    let Some(document) = saved else {
        return save_as(&window, Some(&document_id), &source, revision).await;
    };
    if let Ok(directory) = draft_dir(app) {
        let _ = RecoveryDraft::discard(&directory, &document.document_id);
    }
    Ok(Some(document))
}

#[tauri::command]
async fn save_markdown_as(
    window: WebviewWindow,
    document_id: Option<String>,
    source: String,
    revision: u64,
) -> CommandResult<Option<OpenedDocument>> {
    save_as(&window, document_id.as_deref(), &source, revision).await
}

#[tauri::command]
fn reload_markdown(window: WebviewWindow, document_id: String) -> CommandResult<OpenedDocument> {
    let app = window.app_handle();
    let mut store = lock_store(app)?;
    let previous = store.get_mut(window.label(), &document_id)?;
    let path = previous.document.path.clone().ok_or("document-not-found")?;
    if path.canonicalize().ok().as_ref() != Some(&path) {
        return Err("external-change");
    }
    let refreshed = DocumentSession::open(path)?;
    let document = refreshed.document.clone();
    store.windows.insert(window.label().to_owned(), refreshed);
    Ok(document)
}

#[tauri::command]
fn write_markdown_draft(
    window: WebviewWindow,
    document_id: String,
    source: String,
    revision: u64,
) -> CommandResult<()> {
    let app = window.app_handle();
    let directory = draft_dir(app)?;
    let mut store = lock_store(app)?;
    if let Ok(session) = store.get_mut(window.label(), &document_id) {
        if session.document.revision == revision {
            return RecoveryDraft::write(&directory, session, source);
        }
    }
    Ok(())
}

#[tauri::command]
fn clear_markdown_draft(window: WebviewWindow, document_id: String) -> CommandResult<()> {
    let app = window.app_handle();
    let mut store = lock_store(app)?;
    store.get_mut(window.label(), &document_id)?;
    RecoveryDraft::discard(&draft_dir(app)?, &document_id)
}

#[tauri::command]
fn recover_markdown_drafts(app: AppHandle) -> CommandResult<Vec<RecoveryDraft>> {
    let store = lock_store(&app)?;
    let drafts = RecoveryDraft::list(&draft_dir(&app)?);
    Ok(drafts
        .into_iter()
        .filter(|draft| {
            !store
                .windows
                .values()
                .any(|session| session.document.document_id == draft.id)
        })
        .collect())
}

#[tauri::command]
fn restore_markdown_draft(window: WebviewWindow, id: String) -> CommandResult<OpenedDocument> {
    let app = window.app_handle();
    let mut store = lock_store(app)?;
    let draft = RecoveryDraft::read(&draft_dir(app)?, &id)?;
    if store
        .windows
        .values()
        .any(|session| session.document.document_id == id)
    {
        return Err("draft-already-open");
    }
    let path = draft
        .path
        .as_deref()
        .and_then(|path| existing_document_path(path).ok());
    let available = path.as_deref().is_some_and(|path| {
        store
            .owner(path)
            .is_none_or(|owner| owner == window.label())
    });
    let session = draft.restore(available)?;
    let document = session.document.clone();
    store.windows.insert(window.label().to_owned(), session);
    Ok(document)
}

#[tauri::command]
fn discard_markdown_draft(app: AppHandle, id: String) -> CommandResult<()> {
    let store = lock_store(&app)?;
    if store
        .windows
        .values()
        .any(|session| session.document.document_id == id)
    {
        return Err("draft-already-open");
    }
    RecoveryDraft::discard(&draft_dir(&app)?, &id)
}

fn image_path(document: &Path, reference: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(reference).decode_utf8().ok()?;
    if decoded.contains([':', '\\', '?', '#', '\0']) {
        return None;
    }
    let relative = Path::new(decoded.as_ref());
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    let folder = document.parent()?.canonicalize().ok()?;
    let path = folder.join(relative).canonicalize().ok()?;
    path.starts_with(&folder).then_some(path)
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(b"\0\0\x01\0") {
        Some("image/x-icon")
    } else {
        None
    }
}

#[tauri::command]
async fn read_document_image(
    window: WebviewWindow,
    document_id: String,
    reference: String,
) -> CommandResult<Option<String>> {
    let path = lock_store(window.app_handle())?
        .get_mut(window.label(), &document_id)?
        .document
        .path
        .clone();
    let image = path
        .as_deref()
        .and_then(|path| image_path(path, &reference))
        .and_then(|path| bounded_read(&path, 8 * 1024 * 1024).ok())
        .and_then(|bytes| {
            image_mime(&bytes).map(|mime| format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
        });
    Ok(image)
}

#[tauri::command]
async fn open_plugin_package(window: WebviewWindow) -> CommandResult<Option<Vec<u8>>> {
    let selected = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("选择 ExtenDown 插件包")
        .add_filter("ExtenDown 插件", &["edplugin"])
        .pick_file()
        .await;
    let Some(file) = selected else {
        return Ok(None);
    };
    if !file
        .path()
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("edplugin"))
    {
        return Err("unsupported-file-type");
    }
    bounded_read(file.path(), 512 * 1024).map(Some)
}

#[derive(Serialize)]
struct DefaultAppStatus {
    supported: bool,
    requested: bool,
    message: &'static str,
}

#[tauri::command]
fn set_default_markdown_app() -> DefaultAppStatus {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let requested = std::process::Command::new("explorer.exe")
            .arg("ms-settings:defaultapps")
            .creation_flags(0x0800_0000)
            .spawn()
            .is_ok();
        DefaultAppStatus {
            supported: true,
            requested,
            message: if requested {
                "已请求打开 Windows 默认应用设置。请搜索 .md 并选择 ExtenDown。"
            } else {
                "无法打开 Windows 默认应用设置。可在系统设置中搜索 .md。"
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    DefaultAppStatus {
        supported: false,
        requested: false,
        message: "请在系统的“打开方式”中将 ExtenDown 设为 Markdown 默认应用。",
    }
}

pub(crate) fn atomic_write(
    path: &Path,
    bytes: &[u8],
    validate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let overwrite = path.is_file();
    let mut validation_error = None;
    let result = publish(path, bytes, overwrite, || {
        validate().map_err(|error| {
            validation_error = Some(error);
            "save-failed"
        })
    });
    result.map_err(|error| validation_error.unwrap_or_else(|| error.to_owned()))
}

fn main() {
    let mut context = tauri::generate_context!();
    let installed_components = components::configure(&mut context);
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(workspace::Workspaces::default())
        .manage(installed_components)
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths =
                argument_paths(args.into_iter().skip(1).map(PathBuf::from), Path::new(&cwd));
            if paths.is_empty() {
                if let Some(label) = app.webview_windows().keys().next() {
                    focus_window(app, label);
                }
            } else {
                open_external_paths(app.clone(), paths, "main".into());
            }
        }))
        .setup(|app| {
            let cwd = std::env::current_dir()?;
            let paths = argument_paths(std::env::args_os().skip(1).map(PathBuf::from), &cwd);
            let mut paths = paths.into_iter();
            if let Some(first) = paths.next() {
                if let Err(error) = open_path(app.handle(), &first, Some("main")) {
                    eprintln!("ExtenDown: {error}");
                }
            }
            let rest = paths.collect::<Vec<_>>();
            if !rest.is_empty() {
                open_external_paths(app.handle().clone(), rest, "main".into());
            }
            Ok(())
        })
        .on_webview_event(|webview, event| {
            if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                open_external_paths(
                    webview.app_handle().clone(),
                    paths.clone(),
                    webview.label().to_owned(),
                );
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                window
                    .state::<workspace::Workspaces>()
                    .remove(window.label());
                if let Ok(mut store) = lock_store(window.app_handle()) {
                    store.windows.remove(window.label());
                    store.workspace_locations.remove(window.label());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            current_document,
            new_markdown,
            new_document_window,
            open_markdown,
            recent_markdown,
            open_recent_markdown,
            save_markdown,
            save_markdown_as,
            reload_markdown,
            write_markdown_draft,
            clear_markdown_draft,
            recover_markdown_drafts,
            restore_markdown_draft,
            discard_markdown_draft,
            read_document_image,
            open_plugin_package,
            set_default_markdown_app,
            export::save_export,
            components::installed_components,
            workspace::choose_workspace,
            workspace::close_workspace,
            workspace::workspace_list,
            workspace::workspace_open,
            workspace::workspace_current_file,
            workspace::workspace_initial_location,
            workspace::workspace_create,
            workspace::workspace_rename,
            workspace::workspace_trash,
            workspace::workspace_reveal,
            workspace::workspace_search,
            workspace::workspace_check_links,
        ])
        .build(context)
        .expect("failed to build the ExtenDown host")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                open_external_paths(_app.clone(), paths, "main".into());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_images_stay_inside_the_document_directory() {
        let folder = tempfile::tempdir().unwrap();
        let document = folder.path().join("document.md");
        let image = folder.path().join("local image.png");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(
            image_path(&document, "./local%20image.png"),
            image.canonicalize().ok()
        );
        for invalid in [
            "../local%20image.png",
            "/absolute.png",
            "https://example.com/x.png",
            "dir%5cout.png",
        ] {
            assert_eq!(image_path(&document, invalid), None);
        }
    }
}
