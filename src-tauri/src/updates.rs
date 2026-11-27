use crate::document::CommandResult;
use reqwest::{StatusCode, header};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, process::Command, time::Duration};

const RELEASE_API: &str = "https://api.github.com/repos/KLucen/ExtenDown/releases/latest";
const RELEASE_PAGE: &str = "https://github.com/KLucen/ExtenDown/releases/tag/";
const MAX_RELEASE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    state: String,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum UpdateStatus {
    NoRelease,
    UpToDate {
        latest_version: String,
    },
    UpdateAvailable {
        latest_version: String,
        tag: String,
        has_installer: bool,
    },
}

fn stable_version(tag: &str) -> CommandResult<Version> {
    let value = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    let version = Version::parse(value).map_err(|_| "update-invalid-release")?;
    if !version.pre.is_empty() {
        return Err("update-invalid-release");
    }
    Ok(version)
}

fn installer_for_platform(name: &str, platform: &str) -> bool {
    let name = name.to_ascii_lowercase();
    match platform {
        "windows" => name.ends_with("-setup.exe") || name.ends_with(".msi"),
        "macos" => name.ends_with(".dmg") || name.ends_with(".pkg"),
        "linux" => name.ends_with(".appimage") || name.ends_with(".deb") || name.ends_with(".rpm"),
        _ => false,
    }
}

fn parse_release(body: &[u8], current: &Version, platform: &str) -> CommandResult<UpdateStatus> {
    let release: Release = serde_json::from_slice(body).map_err(|_| "update-invalid-release")?;
    if release.draft || release.prerelease {
        return Ok(UpdateStatus::NoRelease);
    }
    let latest_version = stable_version(&release.tag_name)?;
    if latest_version.cmp_precedence(current) != Ordering::Greater {
        return Ok(UpdateStatus::UpToDate {
            latest_version: latest_version.to_string(),
        });
    }
    let has_installer = release.assets.iter().any(|asset| {
        asset.state == "uploaded" && asset.size > 0 && installer_for_platform(&asset.name, platform)
    });
    Ok(UpdateStatus::UpdateAvailable {
        latest_version: latest_version.to_string(),
        tag: release.tag_name,
        has_installer,
    })
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> CommandResult<UpdateStatus> {
    let current = &app.package_info().version;
    let client = reqwest::Client::builder()
        .user_agent(format!("ExtenDown/{current}"))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "update-network")?;
    let mut response = client
        .get(RELEASE_API)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|_| "update-network")?;

    match response.status() {
        StatusCode::OK => {}
        StatusCode::NOT_FOUND => return Ok(UpdateStatus::NoRelease),
        StatusCode::TOO_MANY_REQUESTS => return Err("update-rate-limited"),
        StatusCode::FORBIDDEN
            if response
                .headers()
                .get("x-ratelimit-remaining")
                .is_some_and(|v| v == "0")
                || response.headers().contains_key(header::RETRY_AFTER) =>
        {
            return Err("update-rate-limited");
        }
        _ => return Err("update-request-failed"),
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "update-network")? {
        if chunk.len() > MAX_RELEASE_BYTES - body.len() {
            return Err("update-invalid-release");
        }
        body.extend_from_slice(&chunk);
    }
    parse_release(&body, current, std::env::consts::OS)
}

fn release_url(tag: &str) -> CommandResult<String> {
    stable_version(tag).map_err(|_| "update-open-failed")?;
    Ok(format!("{RELEASE_PAGE}{tag}"))
}

#[tauri::command]
pub fn open_update_release(tag: String) -> CommandResult<()> {
    let url = release_url(&tag)?;
    #[cfg(windows)]
    let mut browser = {
        use std::os::windows::process::CommandExt;
        let mut browser = Command::new("explorer.exe");
        browser.creation_flags(0x0800_0000);
        browser
    };
    #[cfg(target_os = "macos")]
    let mut browser = Command::new("open");
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut browser = Command::new("xdg-open");

    browser.arg(url).spawn().map_err(|_| "update-open-failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn release(tag: &str, assets: Value) -> Value {
        json!({
            "tag_name": tag,
            "draft": false,
            "prerelease": false,
            "assets": assets,
        })
    }

    fn status(release: Value) -> CommandResult<Value> {
        parse_release(
            release.to_string().as_bytes(),
            &Version::new(0, 1, 6),
            "windows",
        )
        .map(|status| serde_json::to_value(status).unwrap())
    }

    #[test]
    fn recognizes_a_new_version_without_installer_assets() {
        assert_eq!(
            status(release("v0.1.10", json!([]))).unwrap(),
            json!({
                "status": "update-available",
                "latestVersion": "0.1.10",
                "tag": "v0.1.10",
                "hasInstaller": false,
            })
        );
    }

    #[test]
    fn distinguishes_uploaded_windows_installers_from_other_assets() {
        let mut assets = json!([
            {"name": "ExtenDown_0.1.7_x64-setup.exe", "state": "starter", "size": 0},
            {"name": "ExtenDown_0.1.7.dmg", "state": "uploaded", "size": 10},
            {"name": "ExtenDown_0.1.7_x64-setup.exe.sig", "state": "uploaded", "size": 10}
        ]);
        assert_eq!(
            status(release("0.1.7", assets.clone())).unwrap()["hasInstaller"],
            false
        );
        assets[0]["state"] = json!("uploaded");
        assets[0]["size"] = json!(10);
        assert_eq!(
            status(release("0.1.7", assets)).unwrap()["hasInstaller"],
            true
        );
    }

    #[test]
    fn excludes_older_and_prerelease_versions() {
        for tag in ["v0.1.5", "v0.1.6+build.1"] {
            assert_eq!(
                status(release(tag, json!([]))).unwrap()["status"],
                "up-to-date"
            );
        }
        let mut prerelease = release("v0.1.7-rc.1", json!([]));
        prerelease["prerelease"] = json!(true);
        assert_eq!(status(prerelease).unwrap(), json!({"status": "no-release"}));
        assert_eq!(
            status(release("unexpected", json!([]))),
            Err("update-invalid-release")
        );
    }

    #[test]
    fn restricts_opening_to_official_release_tag_urls() {
        assert_eq!(
            release_url("v0.2.0").unwrap(),
            "https://github.com/KLucen/ExtenDown/releases/tag/v0.2.0"
        );
        for value in [
            "https://example.com",
            "../latest",
            "v0.2.0?download=1",
            "v0.2.0%2F",
        ] {
            assert_eq!(release_url(value), Err("update-open-failed"));
        }
    }
}
