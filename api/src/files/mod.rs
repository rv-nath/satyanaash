//! The file store: somewhere to put a file so the API under test can fetch it.
//!
//! `recipients.files` on a campaign takes URLs or minio bucket/keys. The author must not have
//! to know which — they pick files and copy what comes back. Satyanaash uploads at that
//! moment, so what comes back is **real and stable immediately**, which is why it is only
//! text from then on: paste it into a body, or name it as an environment variable. Nothing in
//! the dataset, the test-case model or the execution engine knows this module exists.
//!
//! **Satyanaash keeps no copy of the bytes.** `list` reads the store, so there is no table to
//! drift out of step with it and no migration. The cost is real and stated where it is
//! incurred: delete a file and any test whose body holds its reference starts failing. That
//! is a true report — the API genuinely cannot fetch it any more — and re-upload is a button.
//!
//! Two implementations, because the store is the environment's business and not ours:
//! `http_store` for a plain upload/fetch service, `s3` for minio.

use async_trait::async_trait;
use serde::Serialize;

use crate::error::AppError;

pub mod config;
pub mod http_store;
pub mod s3;
pub mod sigv4;

pub use config::{Reference, StoreConfig, StoreKind};

/// One file, as the store reports it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StoredFile {
    /// What the author called it. Shown in the list.
    pub name: String,
    /// How the store addresses it — what `delete` takes back.
    pub key: String,
    /// **What the author pastes into a test.** A URL, or `bucket/key`, depending on the
    /// store's `reference` setting. Named for what it is used for rather than for its form,
    /// because the form is not always a URL and the UI must not claim otherwise.
    pub reference: String,
    pub size: u64,
    /// ISO-8601 when the store knows it. Absent rather than invented — a made-up timestamp
    /// sorts wrongly and looks authoritative.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploaded_at: Option<String>,
}

#[async_trait]
pub trait FileStore: Send + Sync {
    async fn put(&self, name: &str, bytes: Vec<u8>, mime: Option<&str>) -> Result<StoredFile, AppError>;
    async fn list(&self) -> Result<Vec<StoredFile>, AppError>;
    async fn delete(&self, key: &str) -> Result<(), AppError>;

    /// The containers this credential can see, so an author can pick instead of guessing.
    ///
    /// "Create a bucket first" is a dead end for a test author who has never heard of one and may
    /// not be allowed to make one. Being shown what already exists turns it into a choice.
    ///
    /// Defaults to none: only an object store has buckets, and a file service that answered this
    /// would be inventing a concept it does not have.
    async fn buckets(&self) -> Result<Vec<String>, AppError> {
        Ok(Vec::new())
    }

    /// Make one, when the credential is allowed to.
    ///
    /// Often it is not — which is a real answer, and the error says so plainly enough to forward
    /// to whoever does have the rights.
    async fn create_bucket(&self, _name: &str) -> Result<(), AppError> {
        Err(AppError::BadRequest(
            "this kind of storage has no buckets to create".to_string(),
        ))
    }
}

/// Build the store for an environment, or say why there isn't one.
pub fn open(cfg: &StoreConfig) -> Result<Box<dyn FileStore>, AppError> {
    match cfg.kind {
        StoreKind::Http => Ok(Box::new(http_store::HttpStore::new(cfg.clone()))),
        StoreKind::S3 => Ok(Box::new(s3::S3Store::new(cfg.clone())?)),
    }
}

/// The object name for an uploaded file.
///
/// Prefix, then the name as given. Deliberately **not** content-addressed: the author copies
/// this string and reads it in a body afterwards, and `9f2a1c…-nums100.csv` is harder to
/// recognise than `nums100.csv`. Re-uploading the same name replaces it, which is what
/// "upload the corrected file" should do.
pub fn key_for(cfg: &StoreConfig, name: &str) -> String {
    format!("{}{}", cfg.prefix, sanitise(name))
}

/// Keep a filename to something a store and a URL can both carry.
///
/// The extension survives untouched, because the platform reads it to decide whether the
/// upload is allowed at all — and because `wrong extension → 400` is a test somebody wants.
pub fn sanitise(name: &str) -> String {
    let trimmed = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => c,
            _ => '_',
        })
        .collect();
    if cleaned.trim_matches(['.', '_', '-']).is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

// There is deliberately no extension check here. This platform accepts .csv .txt .xls .xlsx
// for a recipients file, but "wrong extension → 400" is a test an author wants to write, so
// the store must hold whatever it is given. The flag lives in the UI, where it is advice —
// `extensionIsKnown` in `gui-lov/src/lib/fileStore.ts`.

/// Upload ceiling.
///
/// The platform allows 2 GB. This is far lower because the upload passes through this
/// process's memory, and a stray multi-gigabyte file would take the server down rather than
/// fail a test. A thousand-number CSV is about 40 KB.
pub const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use config::{Reference, StoreKind};

    fn cfg(prefix: &str) -> StoreConfig {
        StoreConfig {
            kind: StoreKind::S3,
            endpoint: "http://127.0.0.1:9000".into(),
            bucket: Some("sat-fixtures".into()),
            prefix: prefix.into(),
            access_key: Some("k".into()),
            secret_key: Some("s".into()),
            token: None,
            reference: Reference::Key,
            region: "us-east-1".into(),
        }
    }

    #[test]
    fn a_key_keeps_the_name_the_author_recognises() {
        // Not content-addressed on purpose: this string is copied into a body and read back
        // there later, and `nums100.csv` is recognisable where a hash is not.
        assert_eq!(key_for(&cfg("fixtures/"), "nums100.csv"), "fixtures/nums100.csv");
        assert_eq!(key_for(&cfg(""), "nums100.csv"), "nums100.csv");
    }

    #[test]
    fn a_filename_survives_but_a_path_does_not() {
        // Browsers hand over bare names, but a pasted path or a crafted one must not escape
        // the prefix.
        assert_eq!(sanitise("nums100.csv"), "nums100.csv");
        assert_eq!(sanitise("../../etc/passwd"), "passwd");
        assert_eq!(sanitise("C:\\temp\\numbers_template (1).csv"), "numbers_template__1_.csv");
        assert_eq!(sanitise("  spaced name.txt "), "spaced_name.txt");
        // Nothing usable left is still a name, not an empty key.
        assert_eq!(sanitise("///"), "file");
        assert_eq!(sanitise("..."), "file");
    }
}
