use crate::document::{
    CommandResult, DocumentSession, MAX_DOCUMENT_BYTES, MarkdownFormat, bounded_read, filename,
    publish,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_RECENT_FILES: usize = 20;
const MAX_RECOVERY_BYTES: u64 = MAX_DOCUMENT_BYTES * 6 + 32 * 1024;

#[derive(Clone, Deserialize, Serialize)]
pub struct RecentDocument {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Serialize)]
pub struct DraftSummary {
    pub id: String,
    pub name: String,
    pub path: Option<PathBuf>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct RecoveryDraft {
    pub id: String,
    pub name: String,
    pub path: Option<PathBuf>,
    pub source: String,
    pub format: MarkdownFormat,
    baseline: [u8; 32],
}

impl RecoveryDraft {
    pub fn write(directory: &Path, session: &DocumentSession, source: String) -> CommandResult<()> {
        if source.len() as u64 > MAX_DOCUMENT_BYTES || source.contains('\0') {
            return Err("invalid-source");
        }
        let document = &session.document;
        let draft = Self {
            id: document.document_id.clone(),
            name: document.name.clone(),
            path: document.path.clone(),
            source,
            format: document.format,
            baseline: session.baseline,
        };
        fs::create_dir_all(directory).map_err(|_| "draft-write-failed")?;
        let path = draft_path(directory, &draft.id)?;
        let bytes = serde_json::to_vec(&draft).map_err(|_| "draft-write-failed")?;
        publish(&path, &bytes, path.is_file(), || Ok(())).map_err(|_| "draft-write-failed")
    }

    pub fn read(directory: &Path, id: &str) -> CommandResult<Self> {
        let path = draft_path(directory, id)?;
        let bytes = bounded_read(&path, MAX_RECOVERY_BYTES).map_err(|_| "draft-not-found")?;
        let draft: Self = serde_json::from_slice(&bytes).map_err(|_| "invalid-draft")?;
        if draft.id != id || draft.source.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("invalid-draft");
        }
        Ok(draft)
    }

    pub fn list(directory: &Path) -> Vec<DraftSummary> {
        let Ok(entries) = fs::read_dir(directory) else {
            return Vec::new();
        };
        let mut paths = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let id = name.strip_suffix(".json")?.to_owned();
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, id))
            })
            .collect::<Vec<_>>();
        paths.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        paths
            .into_iter()
            .filter_map(|(_, id)| Self::read(directory, &id).ok())
            .map(|draft| DraftSummary {
                id: draft.id,
                name: draft.name,
                path: draft.path,
            })
            .collect()
    }

    pub fn restore(self, use_path: bool) -> CommandResult<DocumentSession> {
        let attached = self
            .path
            .as_ref()
            .filter(|_| use_path)
            .and_then(|path| crate::document::existing_document_path(path).ok())
            .and_then(|path| DocumentSession::open(path).ok())
            .filter(|session| session.baseline == self.baseline);
        let mut session = attached.unwrap_or_else(DocumentSession::blank);
        session.document.base_source = if session.document.path.is_some() {
            Some(session.document.source.clone())
        } else {
            None
        };
        let (source, format) = crate::document::serialize_draft(&self.source, self.format)?;
        session.document.document_id = self.id;
        session.document.name = self.name;
        session.document.source = source;
        session.document.format = format;
        session.document.recovered = true;
        Ok(session)
    }

    pub fn discard(directory: &Path, id: &str) -> CommandResult<()> {
        match fs::remove_file(draft_path(directory, id)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("draft-remove-failed"),
        }
    }
}

fn draft_path(directory: &Path, id: &str) -> CommandResult<PathBuf> {
    let parsed = Uuid::parse_str(id).map_err(|_| "draft-not-found")?;
    Ok(directory.join(format!("{parsed}.json")))
}

pub fn recent(directory: &Path) -> Vec<RecentDocument> {
    bounded_read(&directory.join("recent.json"), 256 * 1024)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<RecentDocument>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .take(MAX_RECENT_FILES)
        .collect()
}

pub fn remember(directory: &Path, path: &Path) -> CommandResult<()> {
    fs::create_dir_all(directory).map_err(|_| "recent-write-failed")?;
    let mut entries = recent(directory);
    let id = entries
        .iter()
        .find(|entry| entry.path == path)
        .map(|entry| entry.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    entries.retain(|entry| entry.path != path);
    entries.insert(
        0,
        RecentDocument {
            id,
            name: filename(path),
            path: path.to_owned(),
        },
    );
    entries.truncate(MAX_RECENT_FILES);
    let target = directory.join("recent.json");
    let bytes = serde_json::to_vec(&entries).map_err(|_| "recent-write-failed")?;
    publish(&target, &bytes, target.is_file(), || Ok(())).map_err(|_| "recent-write-failed")
}

pub fn retarget_recent(directory: &Path, original: &Path, target: &Path) -> CommandResult<()> {
    let mut entries = recent(directory);
    let mut changed = false;
    for entry in &mut entries {
        let Ok(suffix) = entry.path.strip_prefix(original) else {
            continue;
        };
        entry.path = if suffix.as_os_str().is_empty() {
            target.to_owned()
        } else {
            target.join(suffix)
        };
        entry.name = filename(&entry.path);
        changed = true;
    }
    if changed {
        let path = directory.join("recent.json");
        let bytes = serde_json::to_vec(&entries).map_err(|_| "recent-write-failed")?;
        publish(&path, &bytes, true, || Ok(())).map_err(|_| "recent-write-failed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_older_drafts_and_discards_only_the_requested_draft() {
        let directory = tempfile::tempdir().unwrap();
        let ids = (0..22)
            .map(|index| {
                let session = DocumentSession::blank();
                RecoveryDraft::write(directory.path(), &session, format!("Draft {index}")).unwrap();
                session.document.document_id
            })
            .collect::<Vec<_>>();

        assert_eq!(RecoveryDraft::list(directory.path()).len(), ids.len());
        RecoveryDraft::discard(directory.path(), &ids[0]).unwrap();
        assert!(RecoveryDraft::read(directory.path(), &ids[0]).is_err());
        assert_eq!(RecoveryDraft::list(directory.path()).len(), ids.len() - 1);
        assert_eq!(
            RecoveryDraft::read(directory.path(), &ids[1])
                .unwrap()
                .source,
            "Draft 1"
        );
    }

    #[test]
    fn restores_a_draft_against_its_baseline_and_detaches_after_external_changes() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("example.md");
        fs::write(&original, b"\xef\xbb\xbf# Base\r\n").unwrap();
        let session = DocumentSession::open(original.clone()).unwrap();
        let id = session.document.document_id.clone();
        let drafts = directory.path().join("drafts");
        RecoveryDraft::write(&drafts, &session, "# Restored\n".into()).unwrap();
        let restored = RecoveryDraft::read(&drafts, &id)
            .unwrap()
            .restore(true)
            .unwrap();
        assert!(restored.document.path.is_some());
        assert_eq!(restored.document.source, "# Restored\r\n");
        assert_eq!(restored.document.base_source.as_deref(), Some("# Base\r\n"));
        fs::write(&original, b"external").unwrap();
        let detached = RecoveryDraft::read(&drafts, &id)
            .unwrap()
            .restore(true)
            .unwrap();
        assert!(detached.document.path.is_none());
        assert_eq!(detached.document.source, "# Restored\r\n");
        assert_eq!(fs::read(original).unwrap(), b"external");
    }

    #[test]
    fn recovers_a_line_ending_conversion_without_content_changes() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("mixed.md");
        let bytes = b"\xef\xbb\xbf# A\r\nB\n";
        fs::write(&original, bytes).unwrap();
        let original = original.canonicalize().unwrap();
        let mut session = DocumentSession::open(original.clone()).unwrap();
        let draft = session
            .normalize_line_endings(crate::document::LineEnding::Crlf, 0)
            .unwrap();
        let drafts = directory.path().join("drafts");
        RecoveryDraft::write(&drafts, &session, "# A\nB\n".into()).unwrap();
        assert_eq!(fs::read(&original).unwrap(), bytes);

        let mut recovered = RecoveryDraft::read(&drafts, &draft.document_id)
            .unwrap()
            .restore(true)
            .unwrap();
        assert_eq!(recovered.document.path.as_deref(), Some(original.as_path()));
        assert_eq!(recovered.document.format, draft.format);
        assert!(recovered.document.recovered);
        recovered.save(original.clone(), "# A\nB\n", 0).unwrap();
        assert_eq!(fs::read(original).unwrap(), b"\xef\xbb\xbf# A\r\nB\r\n");
    }
}
