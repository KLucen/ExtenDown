use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const BOM: &[u8] = &[0xef, 0xbb, 0xbf];

pub type CommandResult<T> = Result<T, &'static str>;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    None,
    Lf,
    Crlf,
    Cr,
    Mixed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFormat {
    pub bom_byte_length: u8,
    pub line_ending: LineEnding,
    pub has_trailing_line_ending: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub document_id: String,
    pub name: String,
    pub path: Option<PathBuf>,
    pub source: String,
    pub format: MarkdownFormat,
    pub revision: u64,
    pub recovered: bool,
    pub base_source: Option<String>,
}

pub struct DocumentSession {
    pub document: OpenedDocument,
    pub baseline: [u8; 32],
}

impl DocumentSession {
    pub fn blank() -> Self {
        Self {
            document: OpenedDocument {
                document_id: Uuid::new_v4().to_string(),
                name: "未命名.md".into(),
                path: None,
                source: String::new(),
                format: detect_format("", false),
                revision: 0,
                recovered: false,
                base_source: None,
            },
            baseline: digest(&[]),
        }
    }

    pub fn open(path: PathBuf) -> CommandResult<Self> {
        let bytes = bounded_read(&path, MAX_DOCUMENT_BYTES)?;
        let (source, format) = decode(&bytes)?;
        let mut session = Self::blank();
        session.document.name = filename(&path);
        session.document.path = Some(path);
        session.document.source = source;
        session.document.format = format;
        session.baseline = digest(&bytes);
        Ok(session)
    }

    pub fn save(
        &mut self,
        path: PathBuf,
        source: &str,
        revision: u64,
    ) -> CommandResult<OpenedDocument> {
        if revision != self.document.revision {
            return Err("revision-conflict");
        }
        let current_target = self.document.path.as_ref() == Some(&path);
        let bytes = if self.document.format.line_ending == LineEnding::Mixed {
            if source == editor_source(&self.document.source) {
                encode_verbatim(
                    &self.document.source,
                    self.document.format.bom_byte_length > 0,
                )?
            } else {
                return Err("mixed-line-endings-read-only");
            }
        } else {
            encode(source, self.document.format)?
        };
        let baseline = if current_target {
            verify_baseline(&path, Some(self.baseline))?;
            Some(self.baseline)
        } else {
            optional_digest(&path)?
        };
        let candidate_digest = digest(&bytes);
        let (disk_source, disk_format) = decode(&bytes)?;
        if baseline != Some(candidate_digest) {
            publish(&path, &bytes, baseline.is_some(), || {
                verify_baseline(&path, baseline)
            })?;
        }
        self.document.path = Some(path.clone());
        self.document.name = filename(&path);
        self.document.source = disk_source;
        self.document.format = disk_format;
        self.document.revision += 1;
        self.document.recovered = false;
        self.document.base_source = None;
        self.baseline = candidate_digest;
        Ok(self.document.clone())
    }
}

#[derive(Default)]
pub struct DocumentStore {
    pub windows: HashMap<String, DocumentSession>,
}

impl DocumentStore {
    pub fn get_mut(&mut self, window: &str, id: &str) -> CommandResult<&mut DocumentSession> {
        self.windows
            .get_mut(window)
            .filter(|session| session.document.document_id == id)
            .ok_or("document-not-found")
    }

    pub fn owner(&self, path: &Path) -> Option<&str> {
        self.windows
            .iter()
            .find(|(_, session)| session.document.path.as_ref() == Some(&path.to_path_buf()))
            .map(|(label, _)| label.as_str())
    }
}

pub fn filename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "未命名.md".into())
}

pub fn supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["md", "markdown", "txt"]
                .iter()
                .any(|item| item.eq_ignore_ascii_case(ext))
        })
}

pub fn existing_document_path(path: &Path) -> CommandResult<PathBuf> {
    let target = path.canonicalize().map_err(|_| "read-failed")?;
    if !supported_path(path) || !supported_path(&target) {
        return Err("unsupported-file-type");
    }
    Ok(target)
}

pub fn save_document_path(path: &Path) -> CommandResult<PathBuf> {
    let path = if path.extension().is_none() {
        path.with_extension("md")
    } else {
        path.to_path_buf()
    };
    if !supported_path(&path) {
        return Err("unsupported-file-type");
    }
    match fs::symlink_metadata(&path) {
        Ok(_) => existing_document_path(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or("invalid-path")?;
            let parent = parent
                .canonicalize()
                .map_err(|_| "path-resolution-failed")?;
            Ok(parent.join(path.file_name().ok_or("invalid-path")?))
        }
        Err(_) => Err("path-resolution-failed"),
    }
}

pub fn bounded_read(path: &Path, limit: u64) -> CommandResult<Vec<u8>> {
    let file = File::open(path).map_err(|_| "read-failed")?;
    let metadata = file.metadata().map_err(|_| "read-failed")?;
    if !metadata.is_file() {
        return Err("read-failed");
    }
    if metadata.len() > limit {
        return Err("file-too-large");
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "read-failed")?;
    if bytes.len() as u64 > limit {
        return Err("file-too-large");
    }
    Ok(bytes)
}

fn detect_format(source: &str, has_bom: bool) -> MarkdownFormat {
    let mut endings = [false; 3];
    let mut bytes = source.bytes().peekable();
    while let Some(byte) = bytes.next() {
        match byte {
            b'\r' if bytes.peek() == Some(&b'\n') => {
                endings[1] = true;
                bytes.next();
            }
            b'\r' => endings[2] = true,
            b'\n' => endings[0] = true,
            _ => {}
        }
    }
    let line_ending = match endings {
        [false, false, false] => LineEnding::None,
        [true, false, false] => LineEnding::Lf,
        [false, true, false] => LineEnding::Crlf,
        [false, false, true] => LineEnding::Cr,
        _ => LineEnding::Mixed,
    };
    MarkdownFormat {
        bom_byte_length: if has_bom { 3 } else { 0 },
        line_ending,
        has_trailing_line_ending: source.ends_with(['\r', '\n']),
    }
}

fn decode(bytes: &[u8]) -> CommandResult<(String, MarkdownFormat)> {
    let has_bom = bytes.starts_with(BOM);
    let source = std::str::from_utf8(bytes.strip_prefix(BOM).unwrap_or(bytes))
        .map_err(|_| "invalid-utf8")?;
    if source.contains('\0') {
        return Err("invalid-source");
    }
    Ok((source.to_owned(), detect_format(source, has_bom)))
}

fn editor_source(source: &str) -> String {
    source.replace("\r\n", "\n").replace('\r', "\n")
}

fn encode_verbatim(source: &str, has_bom: bool) -> CommandResult<Vec<u8>> {
    if source.contains('\0') {
        return Err("invalid-source");
    }
    let extra = if has_bom { BOM.len() } else { 0 };
    if (source.len() + extra) as u64 > MAX_DOCUMENT_BYTES {
        return Err("file-too-large");
    }
    let mut result = Vec::with_capacity(source.len() + extra);
    if has_bom {
        result.extend_from_slice(BOM);
    }
    result.extend_from_slice(source.as_bytes());
    Ok(result)
}

pub fn encode(source: &str, format: MarkdownFormat) -> CommandResult<Vec<u8>> {
    if source.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("file-too-large");
    }
    let normalized = editor_source(source);
    let converted = match format.line_ending {
        LineEnding::Cr => normalized.replace('\n', "\r"),
        LineEnding::Crlf => normalized.replace('\n', "\r\n"),
        LineEnding::None | LineEnding::Lf => normalized,
        LineEnding::Mixed => return Err("mixed-line-endings-read-only"),
    };
    encode_verbatim(&converted, format.bom_byte_length == 3)
}

pub fn serialize_draft(
    source: &str,
    format: MarkdownFormat,
) -> CommandResult<(String, MarkdownFormat)> {
    decode(&encode(source, format)?)
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn optional_digest(path: &Path) -> CommandResult<Option<[u8; 32]>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            Ok(Some(digest(&bounded_read(path, MAX_DOCUMENT_BYTES)?)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => Err("read-failed"),
    }
}

fn verify_baseline(path: &Path, baseline: Option<[u8; 32]>) -> CommandResult<()> {
    if optional_digest(path).map_err(|_| "external-change")? != baseline {
        return Err("external-change");
    }
    Ok(())
}

pub fn publish(
    path: &Path,
    bytes: &[u8],
    overwrite: bool,
    validate: impl FnOnce() -> CommandResult<()>,
) -> CommandResult<()> {
    let parent = path.parent().ok_or("save-failed")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "save-failed")?;
    temp.write_all(bytes).map_err(|_| "save-failed")?;
    if overwrite {
        let metadata = fs::metadata(path).map_err(|_| "save-failed")?;
        if !metadata.is_file() || metadata.permissions().readonly() {
            return Err("save-failed");
        }
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|_| "save-failed")?;
    }
    temp.as_file().sync_all().map_err(|_| "save-failed")?;
    validate()?;
    if overwrite {
        temp.persist(path).map_err(|_| "save-failed")?;
    } else {
        temp.persist_noclobber(path).map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                "external-change"
            } else {
                "save-failed"
            }
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_bom_and_crlf_without_touching_unchanged_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("round-trip.md");
        let original = b"\xef\xbb\xbf# One\r\n";
        fs::write(&path, original).unwrap();
        let before = fs::metadata(&path).unwrap().modified().unwrap();
        let mut document = DocumentSession::open(path.clone()).unwrap();
        document.save(path.clone(), "# One\n", 0).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
        document.save(path.clone(), "# Two\n", 1).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xef\xbb\xbf# Two\r\n");
    }

    #[test]
    fn detects_external_changes_and_allows_save_as() {
        let folder = tempfile::tempdir().unwrap();
        let original = folder.path().join("external.md");
        let copy = folder.path().join("copy.md");
        fs::write(&original, b"# Original\n").unwrap();
        let mut document = DocumentSession::open(original.clone()).unwrap();
        fs::write(&original, b"# External\n").unwrap();
        assert_eq!(
            document.save(original.clone(), "# Draft\n", 0).err(),
            Some("external-change")
        );
        document.save(copy.clone(), "# Draft\n", 0).unwrap();
        assert_eq!(fs::read(original).unwrap(), b"# External\n");
        assert_eq!(fs::read(copy).unwrap(), b"# Draft\n");
    }

    #[test]
    fn preserves_exact_mixed_bytes_when_copying_read_only_source() {
        let folder = tempfile::tempdir().unwrap();
        let original = folder.path().join("mixed.md");
        let copy = folder.path().join("copy.md");
        fs::write(&original, b"# A\r\nB\n").unwrap();
        let mut document = DocumentSession::open(original.clone()).unwrap();
        assert_eq!(
            document.save(original, "# Changed", 0).err(),
            Some("mixed-line-endings-read-only")
        );
        document.save(copy.clone(), "# A\nB\n", 0).unwrap();
        assert_eq!(fs::read(copy).unwrap(), b"# A\r\nB\n");
    }

    #[test]
    fn failed_validation_preserves_existing_document() {
        let folder = tempfile::tempdir().unwrap();
        let original = folder.path().join("existing.md");
        fs::write(&original, b"original").unwrap();
        assert_eq!(
            publish(&original, b"new", true, || Err("external-change")),
            Err("external-change")
        );
        assert_eq!(fs::read(original).unwrap(), b"original");
    }
}
