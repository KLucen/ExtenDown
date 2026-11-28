use crate::components::allow_release_redirect;
use crate::document::CommandResult;
use reqwest::{Client, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, time::Duration};

const CATALOG_URL: &str =
    "https://raw.githubusercontent.com/KLucen/ExtendownPlugin/main/catalog.json";
const RELEASE_BASE: &str = "https://github.com/KLucen/ExtendownPlugin/releases/download/";
const MAX_CATALOG_BYTES: usize = 128 * 1024;
const MAX_PLUGINS: usize = 100;
const MAX_PACKAGE_BYTES: usize = 512 * 1024;
const INVALID_CATALOG: &str = "GitHub 插件目录格式无效。";
const CATALOG_UNAVAILABLE: &str = "无法获取 GitHub 插件目录，请稍后重试。";
const PACKAGE_UNAVAILABLE: &str = "无法下载插件包，请检查网络后重试。";
const INVALID_PACKAGE: &str = "插件包过大或完整性校验失败。";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u8,
    plugins: Vec<RepositoryPlugin>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Theme,
    Command,
}

#[derive(Deserialize, Serialize)]
pub struct RepositoryPlugin {
    id: String,
    name: String,
    version: String,
    description: String,
    tag: String,
    filename: String,
    sha256: String,
    kind: Kind,
}

fn safe_segment(value: &str) -> bool {
    value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_id(id: &str) -> bool {
    id.len() <= 200
        && id.contains('.')
        && !id.starts_with("core.")
        && id != "org.extendown"
        && !id.starts_with("org.extendown.")
        && id.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && id.split(['.', '-']).all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.encode_utf16().count() <= max
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn parse_catalog(bytes: &[u8]) -> CommandResult<Vec<RepositoryPlugin>> {
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|_| INVALID_CATALOG)?;
    if catalog.schema_version != 1 || catalog.plugins.len() > MAX_PLUGINS {
        return Err(INVALID_CATALOG);
    }
    let mut ids = BTreeSet::new();
    for plugin in &catalog.plugins {
        let version = semver::Version::parse(&plugin.version).map_err(|_| INVALID_CATALOG)?;
        if !version.pre.is_empty()
            || !version.build.is_empty()
            || [version.major, version.minor, version.patch]
                .iter()
                .any(|number| *number > 999_999_999)
            || !valid_id(&plugin.id)
            || !ids.insert(&plugin.id)
            || !valid_text(&plugin.name, 200)
            || !valid_text(&plugin.description, 500)
            || !safe_segment(&plugin.tag)
            || !safe_segment(&plugin.filename)
            || !plugin.filename.ends_with(".edplugin")
            || plugin.sha256.len() != 64
            || !plugin.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(INVALID_CATALOG);
        }
    }
    Ok(catalog.plugins)
}

fn client(redirect: Policy, error: &'static str) -> CommandResult<Client> {
    Client::builder()
        .user_agent(concat!("ExtenDown/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .redirect(redirect)
        .build()
        .map_err(|_| error)
}

async fn fetch(
    request: reqwest::RequestBuilder,
    max_bytes: usize,
    unavailable: &'static str,
    invalid: &'static str,
) -> CommandResult<Vec<u8>> {
    let mut response = request.send().await.map_err(|_| unavailable)?;
    if response.status() != StatusCode::OK {
        return Err(unavailable);
    }
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err(invalid);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable)? {
        if chunk.len() > max_bytes - bytes.len() {
            return Err(invalid);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn repository_plugins() -> CommandResult<Vec<RepositoryPlugin>> {
    let client = client(Policy::none(), CATALOG_UNAVAILABLE)?;
    let bytes = fetch(
        client.get(CATALOG_URL),
        MAX_CATALOG_BYTES,
        CATALOG_UNAVAILABLE,
        INVALID_CATALOG,
    )
    .await?;
    parse_catalog(&bytes)
}

impl RepositoryPlugin {
    fn download_url(&self) -> CommandResult<Url> {
        Url::parse(&format!("{RELEASE_BASE}{}/{}", self.tag, self.filename))
            .map_err(|_| INVALID_CATALOG)
    }

    fn verify(&self, bytes: &[u8]) -> CommandResult<()> {
        let digest = format!("{:x}", Sha256::digest(bytes));
        if digest.eq_ignore_ascii_case(&self.sha256) {
            Ok(())
        } else {
            Err(INVALID_PACKAGE)
        }
    }
}

#[tauri::command]
pub async fn list_repository_plugins() -> CommandResult<Vec<RepositoryPlugin>> {
    repository_plugins().await
}

#[tauri::command]
pub async fn download_repository_plugin(id: String, version: String) -> CommandResult<Vec<u8>> {
    let catalog = repository_plugins().await?;
    let plugin = catalog
        .iter()
        .find(|plugin| plugin.id == id && plugin.version == version)
        .ok_or("插件目录已变化，请刷新后重试。")?;
    let redirects = Policy::custom(|attempt| {
        if attempt.previous().len() < 5 && allow_release_redirect(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("unexpected plugin package download redirect")
        }
    });
    let client = client(redirects, PACKAGE_UNAVAILABLE)?;
    let bytes = fetch(
        client.get(plugin.download_url()?),
        MAX_PACKAGE_BYTES,
        PACKAGE_UNAVAILABLE,
        INVALID_PACKAGE,
    )
    .await?;
    plugin.verify(&bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn sample() -> Value {
        json!({
            "schemaVersion": 1,
            "plugins": [{
                "id": "org.example.markdown-tools",
                "name": "Markdown 文本工具",
                "version": "1.0.0",
                "description": "统计字符并补充文末换行。",
                "tag": "plugins-v1",
                "filename": "markdown-tools.edplugin",
                "sha256": format!("{:x}", Sha256::digest(b"test package")),
                "kind": "command"
            }]
        })
    }

    #[test]
    fn accepts_catalog_entries_and_checks_package_hash() {
        let bytes = sample().to_string();
        let plugins = parse_catalog(bytes.as_bytes()).unwrap();
        let plugin = &plugins[0];
        assert_eq!(
            plugin.download_url().unwrap().as_str(),
            "https://github.com/KLucen/ExtendownPlugin/releases/download/plugins-v1/markdown-tools.edplugin"
        );
        assert!(plugin.verify(b"test package").is_ok());
        assert!(plugin.verify(b"changed package").is_err());
    }

    #[test]
    fn rejects_unsafe_paths_and_conflicting_entries() {
        for (field, value) in [
            ("tag", "../v1"),
            ("tag", "v1%2F.."),
            ("filename", "test.edplugin?source=external"),
            ("filename", "test.zip"),
            ("id", "org.extendown.local"),
            ("kind", "markdown"),
            ("version", "1.0.0-preview"),
        ] {
            let mut invalid = sample();
            invalid["plugins"][0][field] = json!(value);
            assert!(
                parse_catalog(invalid.to_string().as_bytes()).is_err(),
                "{field}"
            );
        }
        let mut duplicate = sample();
        let plugin = duplicate["plugins"][0].clone();
        duplicate["plugins"].as_array_mut().unwrap().push(plugin);
        assert!(parse_catalog(duplicate.to_string().as_bytes()).is_err());
    }
}
