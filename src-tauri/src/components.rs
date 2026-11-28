use flate2::read::GzDecoder;
use reqwest::{Client, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::async_runtime::Mutex;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Context, Emitter, Manager, Runtime};

const INVENTORY: &str = "optional-assets.json";
const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: usize = MAX_ASSET_BYTES as usize + 64 * 1024;
const COMPONENTS_DIR: &str = "extendown-components";
const SELECTIONS: &str = "selection.ini";
const RELEASE_PATH: &str = "/KLucen/ExtendownPlugin/releases/download/";
const NETWORK_ERROR: &str = "无法从 GitHub 下载官方组件，请检查网络后重试。";
const MISSING_ERROR: &str = "GitHub 暂无适用于当前版本的官方组件。";
const WRITE_ERROR: &str = "无法写入官方扩展目录，请检查安装目录的写入权限。";
const REMOVE_ERROR: &str = "无法删除官方组件文件，请检查安装目录的写入权限后重试。";
const PACKAGE_ERROR: &str = "官方组件文件未通过校验，请重试。";
const UNMANAGED_ERROR: &str = "此版本的官方组件随应用提供。";
const COMPONENTS_CHANGED: &str = "official-components-changed";

#[derive(Deserialize)]
struct Inventory {
    groups: BTreeSet<String>,
    assets: BTreeMap<String, ComponentAsset>,
}

#[derive(Deserialize)]
struct ComponentAsset {
    sha256: String,
    components: Vec<String>,
}

#[derive(Default)]
pub struct InstalledComponents(Option<Arc<ComponentStore>>);

struct ComponentStore {
    inventory: Inventory,
    root: PathBuf,
    state: RwLock<ComponentState>,
    installation: Arc<Mutex<()>>,
}

struct ComponentState {
    revision: u64,
    selected: BTreeSet<String>,
    installed: BTreeSet<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ComponentSnapshot {
    revision: u64,
    installed: Vec<String>,
    pending: Vec<String>,
}

impl ComponentState {
    fn snapshot(&self) -> ComponentSnapshot {
        ComponentSnapshot {
            revision: self.revision,
            installed: self.installed.iter().cloned().collect(),
            pending: self.selected.difference(&self.installed).cloned().collect(),
        }
    }
}

struct OptionalAssets<R: Runtime> {
    core: Box<dyn Assets<R>>,
    store: Arc<ComponentStore>,
}

impl<R: Runtime> Assets<R> for OptionalAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.core.setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let filename = key.as_ref().trim_start_matches('/');
        if let Some(asset) = self.store.inventory.assets.get(filename) {
            let state = self.store.state.read().ok()?;
            if !asset
                .components
                .iter()
                .any(|group| state.installed.contains(group))
            {
                return None;
            }
            return verified_asset(&self.store.root.join(filename), &asset.sha256).map(Cow::Owned);
        }
        self.core.get(key)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.core.iter()
    }

    fn csp_hashes(&self, key: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.core.csp_hashes(key)
    }
}

fn verified_asset(path: &Path, expected: &str) -> Option<Vec<u8>> {
    let bytes = crate::document::bounded_read(path, MAX_ASSET_BYTES).ok()?;
    matches_hash(&bytes, expected).then_some(bytes)
}

fn matches_hash(bytes: &[u8], expected: &str) -> bool {
    format!("{:x}", Sha256::digest(bytes)) == expected
}

fn verified_payload(compressed: &[u8], expected: &str) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    GzDecoder::new(compressed)
        .take(MAX_ASSET_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| PACKAGE_ERROR)?;
    if bytes.len() as u64 > MAX_ASSET_BYTES || !matches_hash(&bytes, expected) {
        return Err(PACKAGE_ERROR);
    }
    Ok(bytes)
}

pub(crate) fn allow_release_redirect(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.host_str() {
        Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => true,
        Some("github.com") => url.path().starts_with(RELEASE_PATH),
        _ => false,
    }
}

fn asset_url(version: &semver::Version, path: &str) -> Result<Url, &'static str> {
    let name = path.strip_prefix("assets/").ok_or(PACKAGE_ERROR)?;
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(PACKAGE_ERROR);
    }
    let mut url = Url::parse(&format!("https://github.com{RELEASE_PATH}"))
        .expect("valid component release URL");
    url.path_segments_mut()
        .expect("component release URL has a base")
        .pop_if_empty()
        .push(&format!("v{version}"))
        .push(&format!("{name}.gz"));
    Ok(url)
}

async fn download_asset(
    client: &Client,
    url: Url,
    expected: &str,
) -> Result<Vec<u8>, &'static str> {
    let mut response = client.get(url).send().await.map_err(|_| NETWORK_ERROR)?;
    match response.status() {
        StatusCode::OK => {}
        StatusCode::NOT_FOUND => return Err(MISSING_ERROR),
        _ => return Err(NETWORK_ERROR),
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_DOWNLOAD_BYTES as u64)
    {
        return Err(PACKAGE_ERROR);
    }
    let mut compressed = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| NETWORK_ERROR)? {
        if chunk.len() > MAX_DOWNLOAD_BYTES - compressed.len() {
            return Err(PACKAGE_ERROR);
        }
        compressed.extend_from_slice(&chunk);
    }
    verified_payload(&compressed, expected)
}

fn read_selections(path: &Path, groups: &BTreeSet<String>) -> BTreeSet<String> {
    crate::document::bounded_read(path, 4096)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|text| {
            text.lines()
                .filter_map(|line| line.split_once('='))
                .filter(|(key, enabled)| *enabled == "1" && groups.contains(*key))
                .map(|(key, _)| key.to_owned())
                .collect()
        })
        .unwrap_or_default()
}

impl ComponentStore {
    fn new(inventory: Inventory, root: PathBuf) -> Self {
        let selection = read_selections(&root.join(SELECTIONS), &inventory.groups);
        let installed = selection
            .iter()
            .filter(|group| {
                inventory.assets.iter().all(|(filename, asset)| {
                    !asset.components.contains(*group)
                        || verified_asset(&root.join(filename), &asset.sha256).is_some()
                })
            })
            .cloned()
            .collect();
        Self {
            inventory,
            root,
            state: RwLock::new(ComponentState {
                revision: 0,
                selected: selection,
                installed,
            }),
            installation: Arc::new(Mutex::new(())),
        }
    }

    fn check_group(&self, group: &str) -> Result<(), &'static str> {
        if !self.inventory.groups.contains(group) {
            return Err("找不到该官方组件。");
        }
        Ok(())
    }

    fn group_assets(&self, group: &str) -> impl Iterator<Item = (&String, &ComponentAsset)> {
        self.inventory
            .assets
            .iter()
            .filter(move |(_, asset)| asset.components.iter().any(|id| id == group))
    }

    fn snapshot(&self) -> ComponentSnapshot {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .snapshot()
    }

    fn save_selection(&self, selected: &BTreeSet<String>) -> Result<(), &'static str> {
        fs::create_dir_all(&self.root).map_err(|_| WRITE_ERROR)?;
        let mut contents = String::from("[components]\r\n");
        for id in &self.inventory.groups {
            let enabled = if selected.contains(id) { '1' } else { '0' };
            contents.push_str(&format!("{id}={enabled}\r\n"));
        }
        crate::atomic_write(&self.root.join(SELECTIONS), contents.as_bytes(), || Ok(()))
            .map_err(|_| WRITE_ERROR)
    }

    async fn download_missing(
        &self,
        group: &str,
        version: &semver::Version,
    ) -> Result<Vec<(PathBuf, Vec<u8>)>, &'static str> {
        self.check_group(group)?;
        let missing = self
            .group_assets(group)
            .filter(|(file, asset)| verified_asset(&self.root.join(file), &asset.sha256).is_none())
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return Ok(Vec::new());
        }
        let client = Client::builder()
            .user_agent(format!("ExtenDown/{version}"))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(Policy::custom(|redirect| {
                if redirect.previous().len() < 4 && allow_release_redirect(redirect.url()) {
                    redirect.follow()
                } else {
                    redirect.error("Unexpected component download redirect")
                }
            }))
            .build()
            .map_err(|_| NETWORK_ERROR)?;
        let mut pending = Vec::with_capacity(missing.len());
        for batch in missing.chunks(6) {
            let mut downloads = Vec::with_capacity(batch.len());
            for (file, asset) in batch {
                let url = asset_url(version, file)?;
                let expected = asset.sha256.clone();
                let client = client.clone();
                downloads.push((
                    self.root.join(file),
                    tauri::async_runtime::spawn(async move {
                        download_asset(&client, url, &expected).await
                    }),
                ));
            }
            let mut results = downloads.into_iter();
            while let Some((path, result)) = results.next() {
                match result.await {
                    Ok(Ok(bytes)) => pending.push((path, bytes)),
                    failure => {
                        for (_, task) in results {
                            task.abort();
                        }
                        return Err(failure.ok().and_then(Result::err).unwrap_or(NETWORK_ERROR));
                    }
                }
            }
        }
        Ok(pending)
    }

    fn complete_install(
        &self,
        group: &str,
        pending: Vec<(PathBuf, Vec<u8>)>,
    ) -> Result<ComponentSnapshot, &'static str> {
        let mut state = self.state.write().map_err(|_| WRITE_ERROR)?;
        let mut selection = state.selected.clone();
        let needs_save = selection.insert(group.to_owned());
        let mut written = Vec::new();
        let result = (|| {
            for (destination, bytes) in pending {
                let directory = destination.parent().ok_or(WRITE_ERROR)?;
                fs::create_dir_all(directory).map_err(|_| WRITE_ERROR)?;
                crate::atomic_write(&destination, &bytes, || Ok(())).map_err(|_| WRITE_ERROR)?;
                written.push(destination);
            }
            if needs_save {
                self.save_selection(&selection)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            // Only absent or invalid assets were downloaded. Verified shared
            // files never enter this list and remain available after rollback.
            for destination in written {
                let _ = fs::remove_file(destination);
            }
            return Err(error);
        }
        state.selected = selection;
        state.installed.insert(group.to_owned());
        state.revision += 1;
        Ok(state.snapshot())
    }

    fn uninstall(&self, group: &str) -> Result<ComponentSnapshot, &'static str> {
        self.check_group(group)?;
        let mut state = self.state.write().map_err(|_| WRITE_ERROR)?;
        let mut selection = state.selected.clone();
        if !selection.remove(group) {
            return Ok(state.snapshot());
        }
        // Move files out of the served directory before recording the removal.
        // Restore the moved files if any move or selection write fails.
        let staging = tempfile::tempdir_in(&self.root).map_err(|_| REMOVE_ERROR)?;
        let mut staged = Vec::new();
        let result = (|| {
            for (file, asset) in self.group_assets(group) {
                if asset.components.iter().any(|id| selection.contains(id)) {
                    continue;
                }
                let source = self.root.join(file);
                let destination = staging.path().join(staged.len().to_string());
                match fs::rename(&source, &destination) {
                    Ok(()) => staged.push((source, destination)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err(REMOVE_ERROR),
                }
            }
            self.save_selection(&selection)
        })();
        if let Err(error) = result {
            let mut rollback_failed = false;
            for (source, destination) in staged.into_iter().rev() {
                rollback_failed |= fs::rename(destination, source).is_err();
            }
            if rollback_failed {
                let _ = staging.keep();
            }
            return Err(error);
        }
        state.selected = selection;
        state.installed.remove(group);
        state.revision += 1;
        Ok(state.snapshot())
    }
}

pub fn configure<R: Runtime>(context: &mut Context<R>) -> InstalledComponents {
    let Some(data) = context.assets().get(&AssetKey::from(INVENTORY)) else {
        return InstalledComponents::default();
    };
    let inventory: Inventory =
        serde_json::from_slice(&data).expect("invalid embedded component inventory");
    let executable = std::env::current_exe().expect("failed to resolve executable path");
    let root = executable
        .parent()
        .expect("executable has no parent")
        .join(COMPONENTS_DIR);
    let store = Arc::new(ComponentStore::new(inventory, root));
    let empty =
        tauri::utils::assets::EmbeddedAssets::new(Default::default(), &[], Default::default());
    let core = context.set_assets(Box::new(empty));
    context.set_assets(Box::new(OptionalAssets {
        core,
        store: Arc::clone(&store),
    }));
    InstalledComponents(Some(store))
}

#[tauri::command]
pub fn installed_components(app: tauri::AppHandle) -> Option<ComponentSnapshot> {
    let store = app.state::<InstalledComponents>();
    store.0.as_ref().map(|store| store.snapshot())
}

#[tauri::command]
pub async fn install_official_component(
    app: tauri::AppHandle,
    component_id: String,
) -> Result<ComponentSnapshot, String> {
    let store = app
        .state::<InstalledComponents>()
        .0
        .clone()
        .ok_or(UNMANAGED_ERROR)?;
    let installation = Arc::clone(&store.installation).lock_owned().await;
    let pending = store
        .download_missing(&component_id, &app.package_info().version)
        .await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _installation = installation;
        let state = store.complete_install(&component_id, pending)?;
        let _ = app.emit(COMPONENTS_CHANGED, &state);
        Ok(state)
    })
    .await
    .map_err(|_| WRITE_ERROR)?
}

#[tauri::command]
pub async fn uninstall_official_component(
    app: tauri::AppHandle,
    component_id: String,
) -> Result<ComponentSnapshot, String> {
    let store = app
        .state::<InstalledComponents>()
        .0
        .clone()
        .ok_or(UNMANAGED_ERROR)?;
    let installation = Arc::clone(&store.installation).lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _installation = installation;
        let state = store.uninstall(&component_id)?;
        let _ = app.emit(COMPONENTS_CHANGED, &state);
        Ok(state)
    })
    .await
    .map_err(|_| REMOVE_ERROR)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    fn fixture() -> (tempfile::TempDir, ComponentStore) {
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path();
        fs::create_dir(root_path.join("assets")).unwrap();
        fs::write(
            root_path.join(SELECTIONS),
            "[components]\r\npdf=0\r\nimages=1\r\n",
        )
        .unwrap();
        fs::write(root_path.join("assets/raster.js"), b"raster renderer").unwrap();
        let groups = BTreeSet::from(["images".to_owned(), "pdf".to_owned()]);
        let assets = [
            (
                "assets/pdf.js",
                b"PDF exporter".as_slice(),
                vec!["pdf".to_owned()],
            ),
            (
                "assets/raster.js",
                b"raster renderer".as_slice(),
                groups.iter().cloned().collect(),
            ),
        ]
        .into_iter()
        .map(|(name, bytes, components)| {
            (
                name.to_owned(),
                ComponentAsset {
                    sha256: format!("{:x}", Sha256::digest(bytes)),
                    components,
                },
            )
        })
        .collect();
        let store = ComponentStore::new(Inventory { groups, assets }, root_path.to_owned());
        (root, store)
    }

    fn compressed(source: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(source).unwrap();
        encoder.finish().unwrap()
    }

    fn install_pdf(store: &ComponentStore) -> ComponentSnapshot {
        let name = "assets/pdf.js";
        let expected = &store.inventory.assets[name].sha256;
        let bytes = verified_payload(&compressed(b"PDF exporter"), expected).unwrap();
        store
            .complete_install("pdf", vec![(store.root.join(name), bytes)])
            .unwrap()
    }

    #[test]
    fn installs_only_the_selected_component_and_persists_it() {
        let (root, store) = fixture();
        let snapshot = install_pdf(&store);
        assert_eq!(snapshot.installed, ["images", "pdf"]);
        assert!(snapshot.pending.is_empty());
        assert_eq!(
            fs::read(root.path().join("assets/pdf.js")).unwrap(),
            b"PDF exporter"
        );
        assert_eq!(
            fs::read(root.path().join("assets/raster.js")).unwrap(),
            b"raster renderer"
        );
        let reopened = ComponentStore::new(store.inventory, root.path().to_owned());
        assert_eq!(reopened.snapshot().installed, ["images", "pdf"]);
    }

    #[test]
    fn failure_to_persist_selection_rolls_back_new_files() {
        let (root, store) = fixture();
        let selection = root.path().join(SELECTIONS);
        fs::remove_file(&selection).unwrap();
        fs::create_dir(&selection).unwrap();
        let pdf_asset = root.path().join("assets/pdf.js");
        let result =
            store.complete_install("pdf", vec![(pdf_asset.clone(), b"PDF exporter".to_vec())]);
        assert_eq!(result, Err(WRITE_ERROR));
        assert!(!pdf_asset.exists());
        assert_eq!(store.snapshot().installed, ["images"]);
        assert!(root.path().join("assets/raster.js").exists());
    }

    #[test]
    fn rejects_corrupt_payloads_and_unknown_components() {
        let (root, store) = fixture();
        let expected = &store.inventory.assets["assets/pdf.js"].sha256;
        assert_eq!(
            verified_payload(&compressed(b"unexpected contents"), expected),
            Err(PACKAGE_ERROR)
        );
        assert!(store.check_group("../pdf").is_err());
        assert!(!root.path().join("assets/pdf.js").exists());
        assert_eq!(
            fs::read_to_string(root.path().join(SELECTIONS)).unwrap(),
            "[components]\r\npdf=0\r\nimages=1\r\n"
        );
    }

    #[test]
    fn restores_a_selected_component_with_a_corrupt_asset() {
        let (root, store) = fixture();
        install_pdf(&store);
        let pdf_asset = root.path().join("assets/pdf.js");
        fs::write(&pdf_asset, b"unexpected contents").unwrap();

        let reopened = ComponentStore::new(store.inventory, root.path().to_owned());
        assert_eq!(reopened.snapshot().installed, ["images"]);
        assert_eq!(reopened.snapshot().pending, ["pdf"]);
        assert_eq!(install_pdf(&reopened).installed, ["images", "pdf"]);
        assert_eq!(fs::read(pdf_asset).unwrap(), b"PDF exporter");
    }

    #[test]
    fn uninstall_preserves_shared_files_until_the_last_group_is_removed() {
        let (root, store) = fixture();
        let installed = install_pdf(&store);
        let remaining = store.uninstall("pdf").unwrap();
        assert!(remaining.revision > installed.revision);
        assert_eq!(remaining.installed, ["images"]);
        assert!(!root.path().join("assets/pdf.js").exists());
        assert!(root.path().join("assets/raster.js").exists());
        let empty = store.uninstall("images").unwrap();
        assert!(empty.revision > remaining.revision);
        assert!(empty.installed.is_empty());
        assert!(!root.path().join("assets/raster.js").exists());
        let reopened = ComponentStore::new(store.inventory, root.path().to_owned());
        assert!(reopened.snapshot().installed.is_empty());
        assert!(reopened.snapshot().pending.is_empty());
    }

    #[test]
    fn uninstall_can_forget_a_selected_component_pending_repair() {
        let (root, store) = fixture();
        install_pdf(&store);
        fs::remove_file(root.path().join("assets/pdf.js")).unwrap();
        let reopened = ComponentStore::new(store.inventory, root.path().to_owned());
        assert_eq!(reopened.snapshot().pending, ["pdf"]);
        let snapshot = reopened.uninstall("pdf").unwrap();
        assert!(snapshot.pending.is_empty());
        assert_eq!(snapshot.installed, ["images"]);
        assert!(root.path().join("assets/raster.js").exists());
    }

    #[test]
    fn official_release_downloads_are_scoped_to_the_version_and_github() {
        let version = semver::Version::new(0, 1, 7);
        let url = asset_url(&version, "assets/pdf-engine-Hash.js").unwrap();
        assert_eq!(
            url.as_str(),
            "https://github.com/KLucen/ExtendownPlugin/releases/download/v0.1.7/pdf-engine-Hash.js.gz"
        );
        assert!(allow_release_redirect(&url));
        assert!(asset_url(&version, "assets/../escaped.js").is_err());
        assert!(allow_release_redirect(
            &Url::parse("https://release-assets.githubusercontent.com/download/path?token=fixture")
                .unwrap()
        ));
        for invalid in [
            "http://github.com/KLucen/ExtendownPlugin/releases/download/v1.2.3/file.gz",
            "https://github.com/other/repository/releases/download/v1.2.3/file.gz",
            "https://release-assets.githubusercontent.com:8443/download",
            "https://release-assets.githubusercontent.com.example/download",
            "https://owner@release-assets.githubusercontent.com/download",
        ] {
            assert!(
                !allow_release_redirect(&Url::parse(invalid).unwrap()),
                "{invalid}"
            );
        }
    }
}
