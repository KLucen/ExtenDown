use flate2::read::GzDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Context, Emitter, Manager, Runtime};

const INVENTORY: &str = "optional-assets.json";
const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;
const COMPONENTS_DIR: &str = "extendown-components";
const SELECTIONS: &str = "selection.ini";
const AVAILABLE_DIR: &str = "available";
const WRITE_ERROR: &str = "无法写入官方扩展目录，请检查安装目录的写入权限。";
const PACKAGE_ERROR: &str = "官方扩展安装文件缺失或损坏，请用当前版本的安装包重新安装。";

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
    installed: RwLock<BTreeSet<String>>,
    installation: Mutex<()>,
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
            let installed = self.store.installed.read().ok()?;
            if !asset
                .components
                .iter()
                .any(|group| installed.contains(group))
            {
                return None;
            }
            drop(installed);
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

fn verified_payload(path: &Path, expected: &str) -> Option<Vec<u8>> {
    let compressed = crate::document::bounded_read(path, MAX_ASSET_BYTES + 64 * 1024).ok()?;
    let mut bytes = Vec::new();
    GzDecoder::new(compressed.as_slice())
        .take(MAX_ASSET_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_ASSET_BYTES && matches_hash(&bytes, expected)).then_some(bytes)
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
            .into_iter()
            .filter(|group| {
                inventory.assets.iter().all(|(filename, asset)| {
                    !asset.components.contains(group)
                        || verified_asset(&root.join(filename), &asset.sha256).is_some()
                })
            })
            .collect();
        Self {
            inventory,
            root,
            installed: RwLock::new(installed),
            installation: Mutex::new(()),
        }
    }

    fn install(&self, group: &str) -> Result<Vec<String>, &'static str> {
        if !self.inventory.groups.contains(group) {
            return Err("找不到该官方扩展。");
        }
        let selection_path = self.root.join(SELECTIONS);
        let mut selection = read_selections(&selection_path, &self.inventory.groups);
        let mut pending = Vec::new();
        for (filename, asset) in self
            .inventory
            .assets
            .iter()
            .filter(|(_, asset)| asset.components.iter().any(|id| id == group))
        {
            let destination = self.root.join(filename);
            if verified_asset(&destination, &asset.sha256).is_some() {
                continue;
            }
            let name = filename.strip_prefix("assets/").ok_or(PACKAGE_ERROR)?;
            let source = self.root.join(AVAILABLE_DIR).join(format!("{name}.gz"));
            let bytes = verified_payload(&source, &asset.sha256).ok_or(PACKAGE_ERROR)?;
            pending.push((destination, bytes));
        }
        for (destination, bytes) in pending {
            let directory = destination.parent().ok_or(WRITE_ERROR)?;
            fs::create_dir_all(directory).map_err(|_| WRITE_ERROR)?;
            crate::atomic_write(&destination, &bytes, || Ok(())).map_err(|_| WRITE_ERROR)?;
        }

        if selection.insert(group.to_owned()) {
            let mut new_selections = String::from("[components]\r\n");
            for id in &self.inventory.groups {
                let enabled = if selection.contains(id) { '1' } else { '0' };
                new_selections.push_str(&format!("{id}={enabled}\r\n"));
            }
            crate::atomic_write(&selection_path, new_selections.as_bytes(), || Ok(()))
                .map_err(|_| WRITE_ERROR)?;
        }
        let mut installed = self.installed.write().map_err(|_| WRITE_ERROR)?;
        installed.insert(group.to_owned());
        Ok(installed.iter().cloned().collect())
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
pub fn installed_components(app: tauri::AppHandle) -> Option<Vec<String>> {
    let store = app.state::<InstalledComponents>();
    store.0.as_ref().map(|store| {
        store
            .installed
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .cloned()
            .collect()
    })
}

#[tauri::command]
pub async fn install_official_component(
    app: tauri::AppHandle,
    component_id: String,
) -> Result<Vec<String>, String> {
    let store = app
        .state::<InstalledComponents>()
        .0
        .clone()
        .ok_or("此版本已经包含全部官方扩展。")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _installation = store.installation.lock().map_err(|_| WRITE_ERROR)?;
        let groups = store.install(&component_id)?;
        let _ = app.emit("official-components-changed", &groups);
        Ok(groups)
    })
    .await
    .map_err(|_| WRITE_ERROR)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    fn fixture() -> (tempfile::TempDir, ComponentStore) {
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path();
        fs::create_dir(root_path.join(AVAILABLE_DIR)).unwrap();
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

    fn stage_pdf(root: &Path, source: &[u8]) {
        let file = fs::File::create(root.join("available/pdf.js.gz")).unwrap();
        let mut encoder = GzEncoder::new(file, Compression::default());
        encoder.write_all(source).unwrap();
        encoder.finish().unwrap();
    }

    #[test]
    fn installs_only_the_selected_component_and_persists_it() {
        let (root, store) = fixture();
        stage_pdf(root.path(), b"PDF exporter");
        assert_eq!(store.install("pdf").unwrap(), ["images", "pdf"]);
        assert_eq!(
            fs::read(root.path().join("assets/pdf.js")).unwrap(),
            b"PDF exporter"
        );
        assert_eq!(
            fs::read(root.path().join("assets/raster.js")).unwrap(),
            b"raster renderer"
        );
        assert_eq!(store.install("pdf").unwrap(), ["images", "pdf"]);
        let reopened = ComponentStore::new(store.inventory, root.path().to_owned());
        assert_eq!(
            *reopened.installed.read().unwrap(),
            BTreeSet::from(["images".to_owned(), "pdf".to_owned()])
        );
    }

    #[test]
    fn rejects_corrupt_payloads_and_unknown_components() {
        let (root, store) = fixture();
        stage_pdf(root.path(), b"unexpected contents");
        assert_eq!(store.install("pdf"), Err(PACKAGE_ERROR));
        assert!(store.install("../pdf").is_err());
        assert!(!root.path().join("assets/pdf.js").exists());
        assert_eq!(
            fs::read_to_string(root.path().join(SELECTIONS)).unwrap(),
            "[components]\r\npdf=0\r\nimages=1\r\n"
        );
    }

    #[test]
    fn restores_a_selected_component_with_a_corrupt_asset() {
        let (root, store) = fixture();
        stage_pdf(root.path(), b"PDF exporter");
        store.install("pdf").unwrap();
        let pdf_asset = root.path().join("assets/pdf.js");
        fs::write(&pdf_asset, b"unexpected contents").unwrap();

        let reopened = ComponentStore::new(store.inventory, root.path().to_owned());
        assert_eq!(
            *reopened.installed.read().unwrap(),
            BTreeSet::from(["images".to_owned()])
        );
        assert_eq!(reopened.install("pdf").unwrap(), ["images", "pdf"]);
        assert_eq!(fs::read(pdf_asset).unwrap(), b"PDF exporter");
    }
}
