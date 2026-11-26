use crate::document::{
    CommandResult, MAX_DOCUMENT_BYTES, OpenedDocument, bounded_read, filename, publish,
    supported_path,
};
use crate::{draft_dir, lock_store, open_canonical_path, recovery};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use uuid::Uuid;

#[derive(Default)]
pub struct Workspaces(Mutex<HashMap<String, Root>>);

impl Workspaces {
    pub fn remove(&self, window: &str) {
        if let Ok(mut rooms) = self.0.lock() {
            rooms.remove(window);
        }
    }
}

#[derive(Clone)]
struct Root {
    id: String,
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootView {
    id: String,
    name: String,
    path: String,
}

fn display_path(path: &Path) -> String {
    let display = path.to_string_lossy();
    if cfg!(windows) {
        if let Some(network) = display.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{network}");
        }
        if let Some(drive) = display.strip_prefix(r"\\?\") {
            return drive.into();
        }
    }
    display.into_owned()
}

fn relative_string(path: &Path) -> Option<String> {
    path.iter()
        .map(|component| component.to_str())
        .collect::<Option<Vec<_>>>()
        .map(|components| components.join("/"))
}

fn valid_component(name: &str) -> bool {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
        return false;
    }
    if !cfg!(windows) {
        return true;
    }
    let base = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let device = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    !device
        && !name.ends_with(['.', ' '])
        && !name.contains([':', '*', '?', '"', '<', '>', '|'])
        && !name.chars().any(char::is_control)
}

fn relative_path(value: &str) -> CommandResult<PathBuf> {
    if value.is_empty() {
        return Ok(PathBuf::new());
    }
    if value.len() > 32_768
        || value.split('/').count() > 64
        || !value.split('/').all(valid_component)
    {
        return Err("workspace-invalid-path");
    }
    Ok(value.split('/').collect())
}

impl Root {
    fn ensure_available(&self) -> CommandResult<()> {
        if self.path.canonicalize().ok().as_ref() != Some(&self.path) || !self.path.is_dir() {
            return Err("workspace-unavailable");
        }
        Ok(())
    }

    fn resolve(&self, relative: &Path) -> CommandResult<PathBuf> {
        let candidate = self.path.join(relative);
        let canonical = candidate.canonicalize().map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                "workspace-missing"
            } else {
                "workspace-read-failed"
            }
        })?;
        if !canonical.starts_with(&self.path) {
            return Err("workspace-outside-root");
        }
        Ok(canonical)
    }

    fn mutable_entry(&self, relative: &Path) -> CommandResult<PathBuf> {
        let name = relative.file_name().ok_or("workspace-invalid-path")?;
        let parent = self.resolve(relative.parent().ok_or("workspace-invalid-path")?)?;
        let path = parent.join(name);
        let metadata = fs::symlink_metadata(&path).map_err(|_| "workspace-missing")?;
        if linked_entry(&metadata) {
            return Err("workspace-linked-entry");
        }
        self.resolve(relative)
    }
}

fn workspace(window: &WebviewWindow, id: &str) -> CommandResult<Root> {
    let state = window.state::<Workspaces>();
    let this = state
        .0
        .lock()
        .map_err(|_| "state-failed")?
        .get(window.label())
        .filter(|root| root.id == id)
        .cloned()
        .ok_or("workspace-not-selected")?;
    this.ensure_available()?;
    Ok(this)
}

#[tauri::command]
pub async fn choose_workspace(window: WebviewWindow) -> CommandResult<Option<RootView>> {
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let path = folder
        .path()
        .canonicalize()
        .map_err(|_| "workspace-unavailable")?;
    let root = Root {
        id: Uuid::new_v4().to_string(),
        path,
    };
    root.ensure_available()?;
    let selected = RootView {
        id: root.id.clone(),
        name: root
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| display_path(&root.path)),
        path: display_path(&root.path),
    };
    window
        .state::<Workspaces>()
        .0
        .lock()
        .map_err(|_| "state-failed")?
        .insert(window.label().into(), root);
    Ok(Some(selected))
}

#[tauri::command]
pub fn close_workspace(window: WebviewWindow, workspace_id: String) -> CommandResult<()> {
    let state = window.state::<Workspaces>();
    let mut roots = state.0.lock().map_err(|_| "state-failed")?;
    if roots
        .get(window.label())
        .is_some_and(|root| root.id == workspace_id)
    {
        roots.remove(window.label());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    directory: bool,
    document: bool,
    linked: bool,
}

fn entries(root: &Root, parent: &Path, canonical: &Path) -> CommandResult<DirectoryListing> {
    let listing = fs::read_dir(canonical).map_err(|_| "workspace-read-failed")?;
    let mut entries = Vec::new();
    let mut limited = false;
    let mut scanned = 0;
    for entry in listing {
        if scanned == MAX_DIRECTORY_ENTRIES {
            limited = true;
            break;
        }
        scanned += 1;
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !valid_component(&name) {
            continue;
        }
        let relative = parent.join(&name);
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let linked = kind.is_symlink()
            || entry
                .metadata()
                .is_ok_and(|metadata| linked_entry(&metadata));
        let (directory, document) = if linked {
            let Ok(target) = root.resolve(&relative) else {
                continue;
            };
            (
                target.is_dir(),
                target.is_file() && supported_path(&relative) && supported_path(&target),
            )
        } else {
            if !kind.is_dir() && !kind.is_file() {
                continue;
            }
            (kind.is_dir(), kind.is_file() && supported_path(&relative))
        };
        let Some(path) = relative_string(&relative) else {
            continue;
        };
        entries.push(Entry {
            name,
            path,
            directory,
            document,
            linked,
        });
    }
    entries.sort_by_cached_key(|entry| {
        (
            !entry.directory,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    Ok(DirectoryListing { entries, limited })
}

fn linked_entry(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    if std::os::windows::fs::MetadataExt::file_attributes(metadata) & 0x400 != 0 {
        return true;
    }
    metadata.is_symlink()
}

#[tauri::command]
pub async fn workspace_list(
    window: WebviewWindow,
    workspace_id: String,
    relative: String,
) -> CommandResult<DirectoryListing> {
    let root = workspace(&window, &workspace_id)?;
    let relative = relative_path(&relative)?;
    let canonical = root.resolve(&relative)?;
    entries(&root, &relative, &canonical)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    document_id: String,
    line: u32,
}

pub fn request_location(app: &AppHandle, owner: &str, document_id: String, line: u32) {
    let _ = app.emit_to(
        owner,
        "extendown://workspace-location",
        Location { document_id, line },
    );
}

#[tauri::command]
pub fn workspace_initial_location(window: WebviewWindow) -> CommandResult<Option<Location>> {
    Ok(lock_store(window.app_handle())?
        .workspace_locations
        .remove(window.label())
        .map(|(document_id, line)| Location { document_id, line }))
}

#[tauri::command]
pub async fn workspace_open(
    window: WebviewWindow,
    workspace_id: String,
    relative: String,
    new_window: bool,
    line: Option<u32>,
) -> CommandResult<Option<OpenedDocument>> {
    let root = workspace(&window, &workspace_id)?;
    let relative = relative_path(&relative)?;
    let path = root.resolve(&relative)?;
    if !supported_path(&relative) || !supported_path(&path) || !path.is_file() {
        return Err("unsupported-file-type");
    }
    let opened = open_canonical_path(
        window.app_handle(),
        path,
        (!new_window).then_some(window.label()),
        line,
    )?;
    Ok(if new_window { None } else { opened })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentWorkspaceFile {
    relative: String,
    status: &'static str,
}

#[tauri::command]
pub async fn workspace_current_file(
    window: WebviewWindow,
    workspace_id: String,
    document_id: String,
) -> CommandResult<Option<CurrentWorkspaceFile>> {
    let root = workspace(&window, &workspace_id)?;
    let mut store = lock_store(window.app_handle())?;
    let session = store.get_mut(window.label(), &document_id)?;
    let Some(path) = session.document.path.as_ref() else {
        return Ok(None);
    };
    let Some(relative) = path.strip_prefix(&root.path).ok().and_then(relative_string) else {
        return Ok(None);
    };
    let (path, baseline) = (path.clone(), session.baseline);
    drop(store);
    let status = match root.resolve(&relative_path(&relative)?) {
        Ok(resolved) if resolved == path => crate::document::disk_status(&path, baseline),
        Err("workspace-missing") => "missing",
        _ => "changed",
    };
    Ok(Some(CurrentWorkspaceFile { relative, status }))
}

#[tauri::command]
pub async fn workspace_create(
    window: WebviewWindow,
    workspace_id: String,
    parent: String,
    name: String,
) -> CommandResult<String> {
    if !valid_component(&name) || !supported_path(Path::new(&name)) {
        return Err("workspace-invalid-name");
    }
    let root = workspace(&window, &workspace_id)?;
    let parent = relative_path(&parent)?;
    let canonical = root.resolve(&parent)?;
    let target = canonical.join(&name);
    let relative = relative_string(&parent.join(name)).ok_or("workspace-invalid-path")?;
    publish(&target, b"", false, || {
        if root.resolve(&parent)? != canonical {
            return Err("workspace-outside-root");
        }
        Ok(())
    })
    .map_err(|error| {
        if error == "external-change" {
            "workspace-name-exists"
        } else {
            error
        }
    })?;
    Ok(relative)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenamedDocument {
    document_id: String,
    path: PathBuf,
    name: String,
}

fn rename_entry(path: &Path, target: &Path) -> CommandResult<()> {
    if path == target {
        return Ok(());
    }
    let same_entry = match fs::symlink_metadata(target) {
        Ok(metadata)
            if !linked_entry(&metadata) && target.canonicalize().ok().as_deref() == Some(path) =>
        {
            true
        }
        Ok(_) => return Err("workspace-name-exists"),
        Err(error) if error.kind() != ErrorKind::NotFound => return Err("workspace-rename-failed"),
        _ => false,
    };
    if cfg!(windows) && same_entry {
        let temporary =
            path.with_file_name(format!(".extendown-rename-{}", Uuid::new_v4().simple()));
        fs::rename(path, &temporary).map_err(|_| "workspace-rename-failed")?;
        if fs::rename(&temporary, target).is_err() {
            let _ = fs::rename(&temporary, path);
            return Err("workspace-rename-failed");
        }
        return Ok(());
    }
    fs::rename(path, target).map_err(|_| "workspace-rename-failed")
}

#[tauri::command]
pub async fn workspace_rename(
    window: WebviewWindow,
    workspace_id: String,
    relative: String,
    name: String,
) -> CommandResult<String> {
    if !valid_component(&name) {
        return Err("workspace-invalid-name");
    }
    let root = workspace(&window, &workspace_id)?;
    let relative = relative_path(&relative)?;
    let path = root.mutable_entry(&relative)?;
    if path.is_file() && supported_path(&path) && !supported_path(Path::new(&name)) {
        return Err("workspace-invalid-name");
    }
    let target = path.with_file_name(&name);
    let app = window.app_handle();
    let mut store = lock_store(app)?;
    rename_entry(&path, &target)?;
    for (label, session) in &mut store.windows {
        let Some(suffix) = session
            .document
            .path
            .as_deref()
            .and_then(|current| current.strip_prefix(&path).ok())
        else {
            continue;
        };
        let new_path = if suffix.as_os_str().is_empty() {
            target.clone()
        } else {
            target.join(suffix)
        };
        session.document.path = Some(new_path.clone());
        session.document.name = filename(&new_path);
        let document_id = session.document.document_id.clone();
        if let Ok(directory) = draft_dir(app) {
            if let Ok(draft) = recovery::RecoveryDraft::read(&directory, &document_id) {
                let _ = recovery::RecoveryDraft::write(&directory, session, draft.source);
            }
        }
        let _ = app.emit_to(
            label,
            "extendown://workspace-renamed",
            RenamedDocument {
                document_id,
                path: new_path,
                name: session.document.name.clone(),
            },
        );
    }
    if let Ok(directory) = crate::data_dir(app) {
        let _ = recovery::retarget_recent(&directory, &path, &target);
    }
    relative_string(&relative.with_file_name(name)).ok_or("workspace-invalid-path")
}

#[tauri::command]
pub async fn workspace_trash(
    window: WebviewWindow,
    workspace_id: String,
    relative: String,
) -> CommandResult<()> {
    let root = workspace(&window, &workspace_id)?;
    let relative = relative_path(&relative)?;
    let path = root.mutable_entry(&relative)?;
    let store = lock_store(window.app_handle())?;
    if store.windows.values().any(|session| {
        session
            .document
            .path
            .as_ref()
            .is_some_and(|p| p.starts_with(&path))
    }) {
        return Err("workspace-entry-open");
    }
    let path = if cfg!(windows) && display_path(&path).encode_utf16().count() < 260 {
        PathBuf::from(display_path(&path))
    } else {
        path
    };
    trash::delete(path).map_err(|_| "workspace-trash-failed")
}

#[tauri::command]
pub async fn workspace_reveal(
    window: WebviewWindow,
    workspace_id: String,
    relative: String,
) -> CommandResult<()> {
    let root = workspace(&window, &workspace_id)?;
    let path = root.resolve(&relative_path(&relative)?)?;
    reveal(&path)
}

fn reveal(path: &Path) -> CommandResult<()> {
    use std::process::Command;
    #[cfg(windows)]
    let mut process = {
        use std::os::windows::process::CommandExt;
        let mut process = Command::new("explorer.exe");
        let path = display_path(path);
        if Path::new(&path).is_dir() {
            process.arg(path);
        } else {
            process.raw_arg(format!("/select,\"{path}\""));
        }
        process.creation_flags(0x0800_0000);
        process
    };
    #[cfg(target_os = "macos")]
    let mut process = {
        let mut process = Command::new("open");
        process.arg("-R").arg(path);
        process
    };
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut process = {
        let mut process = Command::new("xdg-open");
        process.arg(if path.is_dir() {
            path
        } else {
            path.parent().ok_or("workspace-invalid-path")?
        });
        process
    };
    process
        .spawn()
        .map(|_| ())
        .map_err(|_| "workspace-reveal-failed")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    path: String,
    line: Option<usize>,
    preview: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    hits: Vec<SearchHit>,
    limited: bool,
    skipped: usize,
}

const MAX_SEARCH_ENTRIES: usize = 20_000;
const MAX_SEARCH_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Serialize)]
pub struct DirectoryListing {
    entries: Vec<Entry>,
    limited: bool,
}

fn search(root: &Root, query: &str, in_contents: bool) -> CommandResult<SearchResults> {
    let mut result = SearchResults {
        hits: Vec::new(),
        limited: false,
        skipped: 0,
    };
    let query = query.trim().to_lowercase();
    if query.is_empty() || query.len() > 1024 {
        return Ok(result);
    }
    let mut queue = vec![PathBuf::new()];
    let mut visited = HashSet::new();
    let mut count = 0;
    let mut bytes = 0;
    while let Some(directory) = queue.pop() {
        let canonical = root.resolve(&directory);
        let Some(canonical) = canonical.ok().filter(|path| visited.insert(path.clone())) else {
            continue;
        };
        let Ok(files) = entries(root, &directory, &canonical) else {
            result.skipped += 1;
            continue;
        };
        result.limited |= files.limited;
        for entry in files.entries {
            if count >= MAX_SEARCH_ENTRIES
                || bytes >= MAX_SEARCH_BYTES
                || result.hits.len() >= MAX_SEARCH_RESULTS
            {
                result.limited = true;
                return Ok(result);
            }
            count += 1;
            if entry.directory {
                if !entry.linked {
                    if let Ok(path) = relative_path(&entry.path) {
                        queue.push(path);
                    } else {
                        result.limited = true;
                    }
                }
                continue;
            }
            if !entry.document {
                continue;
            }
            if in_contents {
                let source = relative_path(&entry.path)
                    .and_then(|path| root.resolve(&path))
                    .and_then(|path| {
                        bounded_read(&path, MAX_DOCUMENT_BYTES.min(MAX_SEARCH_BYTES - bytes))
                    });
                let Ok(source) = source else {
                    result.skipped += 1;
                    continue;
                };
                bytes += source.len() as u64;
                let Ok(source) = String::from_utf8(source) else {
                    result.skipped += 1;
                    continue;
                };
                for (number, line) in source
                    .trim_start_matches('\u{feff}')
                    .replace("\r\n", "\n")
                    .split(['\n', '\r'])
                    .enumerate()
                {
                    if !line.to_lowercase().contains(&query) {
                        continue;
                    }
                    if result.hits.len() >= MAX_SEARCH_RESULTS {
                        result.limited = true;
                        return Ok(result);
                    }
                    result.hits.push(SearchHit {
                        path: entry.path.clone(),
                        line: Some(number + 1),
                        preview: Some(line.trim().chars().take(180).collect()),
                    });
                }
            } else if entry.path.to_lowercase().contains(&query) {
                result.hits.push(SearchHit {
                    path: entry.path,
                    line: None,
                    preview: None,
                });
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn workspace_search(
    window: WebviewWindow,
    workspace_id: String,
    query: String,
    in_contents: bool,
) -> CommandResult<SearchResults> {
    let root = workspace(&window, &workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || search(&root, &query, in_contents))
        .await
        .map_err(|_| "workspace-read-failed")?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    path: String,
    with_fragment: bool,
}

#[derive(Serialize)]
pub struct CheckedLink {
    status: &'static str,
    target: Option<String>,
    source: Option<String>,
}

fn link_path(root: &Root, document: &Path, reference: &str) -> CommandResult<PathBuf> {
    let decoded = percent_decode_str(reference)
        .decode_utf8()
        .map_err(|_| "workspace-invalid-path")?;
    if decoded.starts_with('/') || decoded.contains(['\\', ':', '\0']) {
        return Err("workspace-outside-root");
    }
    let mut target = document
        .parent()
        .ok_or("workspace-invalid-path")?
        .strip_prefix(&root.path)
        .map_err(|_| "workspace-outside-root")?
        .to_path_buf();
    for part in decoded.split('/') {
        match part {
            "." | "" => {}
            ".." if target.pop() => {}
            ".." => return Err("workspace-outside-root"),
            name if valid_component(name) => target.push(name),
            _ => return Err("workspace-invalid-path"),
        }
    }
    root.resolve(&target)
}

#[tauri::command]
pub async fn workspace_check_links(
    window: WebviewWindow,
    workspace_id: String,
    document_id: String,
    links: Vec<LinkTarget>,
) -> CommandResult<Vec<CheckedLink>> {
    let root = workspace(&window, &workspace_id)?;
    if links.len() > 500 || links.iter().any(|link| link.path.len() > 8192) {
        return Err("workspace-too-many-links");
    }
    let document = {
        let mut store = lock_store(window.app_handle())?;
        store
            .get_mut(window.label(), &document_id)?
            .document
            .path
            .clone()
            .filter(|path| path.starts_with(&root.path))
            .ok_or("workspace-invalid-path")?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut remaining_bytes = 4 * 1024 * 1024;
        let mut checked = Vec::with_capacity(links.len());
        for link in links {
            let mut entry = CheckedLink {
                status: "ok",
                target: None,
                source: None,
            };
            match link_path(&root, &document, &link.path) {
                Ok(path) => {
                    entry.target = if path.is_file() && supported_path(&path) {
                        path.strip_prefix(&root.path).ok().and_then(relative_string)
                    } else {
                        None
                    };
                    if link.with_fragment && entry.target.is_some() {
                        let source = bounded_read(&path, MAX_DOCUMENT_BYTES.min(remaining_bytes))
                            .and_then(|bytes| String::from_utf8(bytes).map_err(|_| "invalid-utf8"));
                        if let Ok(source) = source {
                            remaining_bytes -= source.len() as u64;
                            entry.source = Some(source);
                        } else {
                            entry.status = "unverified";
                        }
                    }
                }
                Err("workspace-outside-root") => entry.status = "outside",
                Err("workspace-missing") => entry.status = "missing",
                Err(_) => entry.status = "unverified",
            }
            checked.push(entry);
        }
        checked
    })
    .await
    .map_err(|_| "workspace-read-failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(path: &Path) -> Root {
        Root {
            path: path.canonicalize().unwrap(),
            id: "test".into(),
        }
    }

    #[test]
    fn lists_one_level_and_searches_documents_recursively() {
        let folder = tempfile::tempdir().unwrap();
        let root = root(folder.path());
        fs::create_dir(root.path.join("notes")).unwrap();
        fs::write(
            root.path.join("notes/中文.md"),
            "\u{feff}# 标题\r\nabc\r命中",
        )
        .unwrap();
        let listing = entries(&root, Path::new(""), &root.path).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].path, "notes");
        assert_eq!(
            search(&root, "中文", false).unwrap().hits[0].path,
            "notes/中文.md"
        );
        assert_eq!(search(&root, "命中", true).unwrap().hits[0].line, Some(3));
    }

    #[test]
    fn validates_relative_paths_and_link_targets() {
        let folder = tempfile::tempdir().unwrap();
        let root = root(folder.path());
        for path in [
            "../escape.md",
            "/absolute.md",
            "docs//name.md",
            r"docs\name.md",
        ] {
            assert!(relative_path(path).is_err(), "{path}");
        }
        fs::create_dir(root.path.join("notes")).unwrap();
        fs::write(root.path.join("引用 文件.md"), "# Title").unwrap();
        let document = root.path.join("notes/active.md");
        assert!(link_path(&root, &document, "../引用%20文件.md").is_ok());
        assert_eq!(
            link_path(&root, &document, "../../outside.md").err(),
            Some("workspace-outside-root")
        );
        assert_eq!(
            link_path(&root, &document, "%2e%2e/%2e%2e/outside.md").err(),
            Some("workspace-outside-root")
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_outside_junctions_and_handles_case_only_rename() {
        use std::os::windows::process::CommandExt;
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = root(folder.path());
        let make_junction = |path: &Path, target: &Path| {
            assert!(
                std::process::Command::new("cmd.exe")
                    .args(["/D", "/C", "mklink", "/J"])
                    .arg(path)
                    .arg(target)
                    .creation_flags(0x0800_0000)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        };
        let path = folder.path().join("external");
        make_junction(&path, outside.path());
        assert_eq!(
            root.resolve(Path::new("external")).err(),
            Some("workspace-outside-root")
        );
        assert!(root.mutable_entry(Path::new("external")).is_err());
        fs::remove_dir(path).unwrap();
        let target = folder.path().join("target");
        let alias = folder.path().join("alias");
        fs::create_dir(&target).unwrap();
        make_junction(&alias, &target);
        assert_eq!(
            rename_entry(&target.canonicalize().unwrap(), &root.path.join("alias")),
            Err("workspace-name-exists")
        );
        assert!(target.is_dir());
        fs::remove_dir(alias).unwrap();
        let original = root.path.join("Mixed.md");
        fs::write(&original, "Example").unwrap();
        rename_entry(&original, &root.path.join("mixed.md")).unwrap();
        assert!(
            fs::read_dir(&root.path)
                .unwrap()
                .any(|entry| entry.unwrap().file_name() == "mixed.md")
        );
    }
}
