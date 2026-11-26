use serde::Deserialize;
use std::path::Path;
use tauri::ipc::{InvokeBody, Request};

const MAX_METADATA_BYTES: usize = 1024;
const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ExportFormat {
    Html,
    Pdf,
    Png,
    Jpg,
}

impl ExportFormat {
    fn extension(&self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Pdf => "pdf",
            Self::Png => "png",
            Self::Jpg => "jpg",
        }
    }

    fn accepts_extension(&self, extension: &str) -> bool {
        extension.eq_ignore_ascii_case(self.extension())
            || (matches!(self, Self::Jpg) && extension.eq_ignore_ascii_case("jpeg"))
    }

    fn accepts_bytes(&self, bytes: &[u8]) -> bool {
        match self {
            Self::Html => bytes.starts_with(b"<!doctype html>") && std::str::from_utf8(bytes).is_ok(),
            Self::Pdf => bytes.starts_with(b"%PDF-"),
            Self::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            Self::Jpg => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ExportMetadata {
    format: ExportFormat,
    suggested_name: String,
    #[serde(default)]
    archive: bool,
}

impl ExportMetadata {
    fn extension(&self) -> &'static str {
        if self.archive { "zip" } else { self.format.extension() }
    }

    fn accepts_extension(&self, extension: &str) -> bool {
        if self.archive {
            extension.eq_ignore_ascii_case("zip")
        } else {
            self.format.accepts_extension(extension)
        }
    }

    fn accepts_bytes(&self, bytes: &[u8]) -> bool {
        if self.archive {
            matches!(self.format, ExportFormat::Png | ExportFormat::Jpg)
                && bytes.starts_with(b"PK\x03\x04")
        } else {
            self.format.accepts_bytes(bytes)
        }
    }
}

fn parse_export_packet(packet: &[u8]) -> Result<(ExportMetadata, &[u8]), String> {
    let separator = packet
        .iter()
        .take(MAX_METADATA_BYTES)
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| "无效的导出请求。".to_string())?;
    let (metadata, bytes) = (&packet[..separator], &packet[separator + 1..]);
    let metadata: ExportMetadata =
        serde_json::from_slice(metadata).map_err(|_| "无效的导出格式或文件名。".to_string())?;
    let name = &metadata.suggested_name;
    if name.is_empty()
        || name.len() > 512
        || name.chars().any(|ch| ch.is_control() || "/\\<>:\"|?*".contains(ch))
        || !Path::new(name)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| metadata.accepts_extension(extension))
    {
        return Err("无效的导出文件名。".to_owned());
    }
    if bytes.is_empty() || bytes.len() > MAX_EXPORT_BYTES || !metadata.accepts_bytes(bytes) {
        return Err("导出内容与格式不符，或文件超过 64 MiB。".to_owned());
    }
    Ok((metadata, bytes))
}

#[tauri::command]
pub async fn save_export(request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(packet) = request.body() else {
        return Err("无效的导出请求。".to_owned());
    };
    let (metadata, bytes) = parse_export_packet(packet)?;
    let extension = metadata.extension();
    let Some(mut destination) = rfd::AsyncFileDialog::new()
        .set_title("保存导出文件")
        .set_file_name(&metadata.suggested_name)
        .add_filter(extension.to_uppercase(), &[extension])
        .save_file()
        .await
        .map(|handle| handle.path().to_path_buf())
    else {
        return Ok(None);
    };
    match destination.extension().and_then(|extension| extension.to_str()) {
        Some(value) if metadata.accepts_extension(value) => {}
        None => {
            destination.set_extension(extension);
            if destination.exists() {
                return Err("目标文件已存在。请选择带扩展名的文件名以确认覆盖。".to_owned());
            }
        }
        Some(_) => return Err(format!("请选择扩展名为 .{extension} 的文件。")),
    }
    crate::atomic_write(&destination, bytes, || Ok(()))
        .map_err(|error| format!("无法保存导出文件（{error}）。"))?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_checks_basename_format_and_file_signature() {
        let valid = b"{\"format\":\"pdf\",\"suggestedName\":\"file.pdf\"}\n%PDF-1.4";
        assert_eq!(parse_export_packet(valid).unwrap().1, b"%PDF-1.4");
        let rejected = [
            b"{\"format\":\"pdf\",\"suggestedName\":\"../file.pdf\"}\n%PDF-1.4".as_slice(),
            b"{\"format\":\"pdf\",\"suggestedName\":\"file.png\"}\n%PDF-1.4",
            b"{\"format\":\"exe\",\"suggestedName\":\"file.exe\"}\n%PDF-1.4",
            b"{\"format\":\"pdf\",\"suggestedName\":\"file.pdf\"}\nnot-pdf",
        ];
        assert!(rejected.iter().all(|packet| parse_export_packet(packet).is_err()));
    }

    #[test]
    fn image_archives_require_zip_signature_and_extension() {
        let valid = b"{\"format\":\"png\",\"suggestedName\":\"file.png.zip\",\"archive\":true}\nPK\x03\x04";
        assert_eq!(parse_export_packet(valid).unwrap().0.extension(), "zip");
        let invalid_pdf_archive = b"{\"format\":\"pdf\",\"suggestedName\":\"file.pdf.zip\",\"archive\":true}\nPK\x03\x04";
        assert!(parse_export_packet(invalid_pdf_archive).is_err());
        let invalid_extension = b"{\"format\":\"jpg\",\"suggestedName\":\"file.jpg\",\"archive\":true}\nPK\x03\x04";
        assert!(parse_export_packet(invalid_extension).is_err());
    }
}
