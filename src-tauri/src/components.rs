use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Context, Manager, Runtime};

const INVENTORY: &str = "optional-assets.json";
const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;
const COMPONENTS_DIR: &str = "extendown-components";

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
pub struct InstalledComponents(Option<BTreeSet<String>>);

struct OptionalAssets<R: Runtime> {
    core: Box<dyn Assets<R>>,
    inventory: Inventory,
    root: PathBuf,
    enabled: BTreeSet<String>,
}

impl<R: Runtime> Assets<R> for OptionalAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.core.setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let filename = key.as_ref().trim_start_matches('/');
        if let Some(asset) = self.inventory.assets.get(filename) {
            if !asset.components.iter().any(|group| self.enabled.contains(group)) {
                return None;
            }
            return verified_asset(&self.root.join(filename), &asset.sha256).map(Cow::Owned);
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
    let actual = format!("{:x}", Sha256::digest(&bytes));
    (actual == expected).then_some(bytes)
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

pub fn configure<R: Runtime>(context: &mut Context<R>) -> InstalledComponents {
    let Some(data) = context.assets().get(&AssetKey::from(INVENTORY)) else {
        return InstalledComponents::default();
    };
    let inventory: Inventory = serde_json::from_slice(&data)
        .expect("invalid embedded component inventory");
    let executable = std::env::current_exe().expect("failed to resolve executable path");
    let root = executable
        .parent()
        .expect("executable has no parent")
        .join(COMPONENTS_DIR);
    let enabled: BTreeSet<String> = read_selections(&root.join("selection.ini"), &inventory.groups)
        .into_iter()
        .filter(|group| {
            inventory.assets.iter().all(|(filename, asset)| {
                !asset.components.contains(group) || root.join(filename).is_file()
            })
        })
        .collect();
    let empty = tauri::utils::assets::EmbeddedAssets::new(Default::default(), &[], Default::default());
    let core = context.set_assets(Box::new(empty));
    context.set_assets(Box::new(OptionalAssets {
        core,
        inventory,
        root,
        enabled: enabled.clone(),
    }));
    InstalledComponents(Some(enabled))
}

#[tauri::command]
pub fn installed_components(app: tauri::AppHandle) -> Option<Vec<String>> {
    app.state::<InstalledComponents>().0.as_ref()
        .map(|groups| groups.iter().cloned().collect())
}
