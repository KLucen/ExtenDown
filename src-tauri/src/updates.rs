use crate::document::CommandResult;
use reqwest::Url;
use reqwest::{StatusCode, header};
use semver::Version;
use serde::Serialize;
use std::{cmp::Ordering, process::Command, time::Duration};

const LATEST_RELEASE: &str = "https://github.com/KLucen/ExtenDown/releases/latest";
const EXPANDED_ASSETS: &str = "https://github.com/KLucen/ExtenDown/releases/expanded_assets/";
const RELEASE_PAGE: &str = "https://github.com/KLucen/ExtenDown/releases/tag/";
const MAX_ASSET_PAGE_BYTES: usize = 128 * 1024;
const GITHUB_BASE: &str = "https://github.com/";

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

fn installer_names(version: &Version, platform: &str, architecture: &str) -> Vec<String> {
    let prefix = format!("ExtenDown_{version}_");
    match (platform, architecture) {
        ("windows", "x86_64") => vec![format!("{prefix}x64-setup.exe")],
        ("windows", "aarch64") => vec![format!("{prefix}aarch64-setup.exe")],
        ("macos", "x86_64") => vec![format!("{prefix}x64.dmg"), format!("{prefix}x64.pkg")],
        ("macos", "aarch64") => vec![
            format!("{prefix}aarch64.dmg"),
            format!("{prefix}aarch64.pkg"),
        ],
        ("linux", "x86_64") => vec![
            format!("{prefix}amd64.AppImage"),
            format!("{prefix}amd64.deb"),
            format!("{prefix}amd64.rpm"),
        ],
        ("linux", "aarch64") => vec![
            format!("{prefix}aarch64.AppImage"),
            format!("{prefix}arm64.deb"),
            format!("{prefix}aarch64.rpm"),
        ],
        _ => Vec::new(),
    }
}

fn release_page_has_installer(
    html: &str,
    tag: &str,
    version: &Version,
    platform: &str,
    architecture: &str,
) -> bool {
    installer_names(version, platform, architecture)
        .iter()
        .any(|name| {
            html.contains(&format!(
                "href=\"/KLucen/ExtenDown/releases/download/{tag}/{name}\""
            ))
        })
}

fn release_tag(location: &str) -> CommandResult<Option<String>> {
    let url = Url::parse(GITHUB_BASE)
        .and_then(|base| base.join(location))
        .map_err(|_| "update-invalid-release")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("update-invalid-release");
    }
    if url.path() == "/KLucen/ExtenDown/releases" {
        return Ok(None);
    }
    let Some(tag) = url.path().strip_prefix("/KLucen/ExtenDown/releases/tag/") else {
        return Err("update-invalid-release");
    };
    stable_version(tag)?;
    Ok(Some(tag.to_owned()))
}

async fn request_latest_release(client: &reqwest::Client) -> CommandResult<Option<String>> {
    let response = client
        .head(LATEST_RELEASE)
        .send()
        .await
        .map_err(|_| "update-network")?;
    match response.status() {
        StatusCode::FOUND
        | StatusCode::SEE_OTHER
        | StatusCode::MOVED_PERMANENTLY
        | StatusCode::TEMPORARY_REDIRECT
        | StatusCode::PERMANENT_REDIRECT => {}
        StatusCode::TOO_MANY_REQUESTS => return Err("update-rate-limited"),
        StatusCode::FORBIDDEN => return Err("update-request-failed"),
        _ => return Err("update-request-failed"),
    }
    let location = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or("update-invalid-release")?;
    release_tag(location)
}

async fn release_has_installer(
    client: &reqwest::Client,
    tag: &str,
    version: &Version,
    platform: &str,
    architecture: &str,
) -> CommandResult<bool> {
    let url =
        Url::parse(&format!("{EXPANDED_ASSETS}{tag}")).map_err(|_| "update-invalid-release")?;
    let mut response = client.get(url).send().await.map_err(|_| "update-network")?;
    match response.status() {
        StatusCode::OK => {}
        StatusCode::NOT_FOUND => return Ok(false),
        StatusCode::TOO_MANY_REQUESTS => return Err("update-rate-limited"),
        StatusCode::FORBIDDEN => return Err("update-request-failed"),
        _ => return Err("update-request-failed"),
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ASSET_PAGE_BYTES as u64)
    {
        return Err("update-invalid-release");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "update-network")? {
        if chunk.len() > MAX_ASSET_PAGE_BYTES - body.len() {
            return Err("update-invalid-release");
        }
        body.extend_from_slice(&chunk);
    }
    let html = std::str::from_utf8(&body).map_err(|_| "update-invalid-release")?;
    Ok(release_page_has_installer(
        html,
        tag,
        version,
        platform,
        architecture,
    ))
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> CommandResult<UpdateStatus> {
    let current = &app.package_info().version;
    let client = reqwest::Client::builder()
        .user_agent(format!("ExtenDown/{current}"))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "update-network")?;
    let Some(tag) = request_latest_release(&client).await? else {
        return Ok(UpdateStatus::NoRelease);
    };
    let latest_version = stable_version(&tag)?;
    if latest_version.cmp_precedence(current) != Ordering::Greater {
        return Ok(UpdateStatus::UpToDate {
            latest_version: latest_version.to_string(),
        });
    }
    let has_installer = release_has_installer(
        &client,
        &tag,
        &latest_version,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
    .await?;
    Ok(UpdateStatus::UpdateAvailable {
        latest_version: latest_version.to_string(),
        tag,
        has_installer,
    })
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

    #[test]
    fn resolves_the_public_latest_redirect_and_handles_no_releases() {
        assert_eq!(
            release_tag("https://github.com/KLucen/ExtenDown/releases/tag/v0.1.10").unwrap(),
            Some("v0.1.10".to_owned())
        );
        assert_eq!(release_tag("/KLucen/ExtenDown/releases").unwrap(), None);
        assert_eq!(
            release_tag("https://github.com/KLucen/ExtenDown/releases").unwrap(),
            None
        );
    }

    #[test]
    fn selects_the_exact_installer_for_this_platform() {
        let version = Version::new(0, 1, 7);
        assert_eq!(
            installer_names(&version, "windows", "x86_64"),
            ["ExtenDown_0.1.7_x64-setup.exe"]
        );
        assert!(installer_names(&version, "other", "x86_64").is_empty());
        let html = "<a href=\"/KLucen/ExtenDown/releases/download/v0.1.7/ExtenDown_0.1.7_x64-setup.exe\">download</a>";
        assert!(release_page_has_installer(
            html, "v0.1.7", &version, "windows", "x86_64"
        ));
        assert!(!release_page_has_installer(
            html, "v0.1.8", &version, "windows", "x86_64"
        ));
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

    #[test]
    fn rejects_latest_redirects_outside_the_official_repository() {
        for location in [
            "https://github.com/other/repository/releases/tag/v0.2.0",
            "https://github.com.evil.example/KLucen/ExtenDown/releases/tag/v0.2.0",
            "https://example.com/KLucen/ExtenDown/releases/tag/v0.2.0",
            "https://github.com/KLucen/ExtenDown/releases/tag/not-a-version",
            "https://github.com/KLucen/ExtenDown/releases/tag/v0.2.0?redirect=1",
        ] {
            assert_eq!(release_tag(location), Err("update-invalid-release"));
        }
    }
}
