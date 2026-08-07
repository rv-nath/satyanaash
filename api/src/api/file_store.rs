//! Configuring a storage, and using it.
//!
//! Satyanaash proxies every call to a store so its credentials stay in this process. A saved
//! store keeps them in the database, write-only — see `db/repositories/file_stores.rs`. A store
//! defined by environment variables is listed too, read-only, because the shell that exported
//! it is the only place it can be changed.
//!
//! Stores are **named and project-scoped**, not per-environment: uploading happens while
//! authoring and yields a literal, so which environment is selected has no bearing on the
//! result — and having two at once is the point, since migrating from minio to a file service
//! means running both for a while.

use std::sync::Arc;

use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::db::models::{CreateFileStore, FileStore, UpdateFileStore};
use crate::db::repositories::FileStoreRepository;
use crate::error::AppError;
use crate::files::{
    config, open, sanitise, FileStore as Store, Reference, StoreConfig, StoreKind, StoredFile,
    MAX_UPLOAD_BYTES,
};

#[derive(Clone)]
pub struct FileStoreState {
    pub repo: Arc<dyn FileStoreRepository>,
}

/// GET /api/v1/projects/{id}/file-stores
///
/// Saved stores first, then any the environment defines. The env ones come last and are marked,
/// because a read-only entry mixed in among editable ones would offer a Save that silently did
/// nothing.
pub async fn list_stores(
    State(state): State<FileStoreState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<FileStore>>, AppError> {
    let mut stores = state.repo.list_by_project(&project_id).await?;
    stores.extend(
        config::from_environment()
            .into_iter()
            .map(|(name, cfg)| env_store(&project_id, &name, &cfg)),
    );
    Ok(Json(stores))
}

fn kind_str(kind: StoreKind) -> &'static str {
    match kind {
        StoreKind::S3 => "s3",
        StoreKind::Http => "http",
    }
}

fn reference_str(reference: Reference) -> &'static str {
    match reference {
        Reference::Key => "key",
        Reference::Url => "url",
    }
}

/// An environment-defined store, in the shape the list returns.
///
/// The id is prefixed `env:` so every route can tell at a glance that there is no database row
/// behind it, and so a saved store's UUID can never collide with one. The name is the variable
/// prefix itself, which says where it came from without a second naming scheme to invert.
fn env_store(project_id: &str, name: &str, cfg: &StoreConfig) -> FileStore {
    FileStore {
        id: format!("env:{name}"),
        project_id: project_id.to_string(),
        name: name.to_string(),
        kind: kind_str(cfg.kind).to_string(),
        endpoint: cfg.endpoint.clone(),
        bucket: cfg.bucket.clone(),
        prefix: cfg.prefix.clone(),
        access_key: cfg.access_key.clone(),
        reference: reference_str(cfg.reference).to_string(),
        region: cfg.region.clone(),
        has_secret: cfg.secret_key.is_some(),
        has_token: cfg.token.is_some(),
        source: "env".to_string(),
        // No row, so no history. Now rather than a fabricated past date, which would sort
        // convincingly wrongly if the list is ever ordered by age.
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    }
}

pub async fn create_store(
    State(state): State<FileStoreState>,
    Path(project_id): Path<String>,
    Json(input): Json<CreateFileStore>,
) -> Result<(StatusCode, Json<FileStore>), AppError> {
    Ok((StatusCode::CREATED, Json(state.repo.create(&project_id, input).await?)))
}

pub async fn update_store(
    State(state): State<FileStoreState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateFileStore>,
) -> Result<Json<FileStore>, AppError> {
    refuse_env(&id, "changed")?;
    Ok(Json(state.repo.update(&id, input).await?))
}

pub async fn delete_store(
    State(state): State<FileStoreState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    refuse_env(&id, "deleted")?;
    state.repo.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A store from the environment cannot be edited here, and says where it can be.
fn refuse_env(id: &str, verb: &str) -> Result<(), AppError> {
    if let Some(name) = id.strip_prefix("env:") {
        return Err(AppError::BadRequest(format!(
            "\"{name}\" comes from environment variables and cannot be {verb} here — edit \
             {name}_* where satyanaash is started, and restart it"
        )));
    }
    Ok(())
}

/// The config behind a store id, whether saved or from the environment.
async fn config_for(state: &FileStoreState, id: &str) -> Result<StoreConfig, AppError> {
    if let Some(name) = id.strip_prefix("env:") {
        return config::from_environment()
            .into_iter()
            .find(|(n, _)| n == name)
            .map(|(_, cfg)| cfg)
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "no storage called \"{name}\" in the environment any more — it may have been \
                     removed since this page loaded"
                ))
            });
    }
    state
        .repo
        .config_for(id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no storage with id {id}")))
}

// ------------------------------------------------------------- testing a storage

/// One step of a storage check.
#[derive(Debug, Serialize)]
pub struct CheckStep {
    pub step: String,
    /// `None` when an earlier step failed and this one was never attempted — which is not the
    /// same as failing, and a cross would send the author to the wrong place.
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub ok: bool,
    pub steps: Vec<CheckStep>,
}

/// The probe object a check writes and removes.
///
/// Named so that one left behind in a bucket explains itself.
const PROBE: &str = "satyanaash-storage-check.txt";

/// A real round-trip, not a ping.
///
/// Listing proves the endpoint, the credentials and the bucket. It does **not** prove writing,
/// which is a separate permission and the one that matters — so the check uploads a small
/// object and removes it again, reporting the three steps separately. One tick over the lot
/// would hide a read-only key until the first real upload.
async fn run_check(cfg: &StoreConfig) -> CheckResult {
    let mut steps = Vec::new();

    let store = match open(cfg) {
        Ok(s) => s,
        Err(e) => {
            steps.push(CheckStep {
                step: "Open the storage".into(),
                ok: Some(false),
                detail: Some(plain(&e)),
            });
            return CheckResult { ok: false, steps };
        }
    };

    let reach = format!("Reach {} and list it", cfg.endpoint);
    let listed = store.list().await;
    match &listed {
        Ok(files) => steps.push(CheckStep {
            step: reach,
            ok: Some(true),
            detail: Some(match files.len() {
                0 => "empty".to_string(),
                1 => "1 file".to_string(),
                n => format!("{n} files"),
            }),
        }),
        Err(e) => steps.push(CheckStep { step: reach, ok: Some(false), detail: Some(plain(e)) }),
    }
    if listed.is_err() {
        // Not attempted, and said so rather than shown as failures for steps that never ran.
        steps.push(CheckStep { step: "Upload a probe file".into(), ok: None, detail: None });
        steps.push(CheckStep { step: "Delete it again".into(), ok: None, detail: None });
        return CheckResult { ok: false, steps };
    }

    let put = store.put(PROBE, b"satyanaash storage check\n".to_vec(), Some("text/plain")).await;
    match &put {
        Ok(f) => steps.push(CheckStep {
            step: "Upload a probe file".into(),
            ok: Some(true),
            // What an author would paste, shown once here so the Reference choice is visible
            // before any test depends on it.
            detail: Some(f.reference.clone()),
        }),
        Err(e) => steps.push(CheckStep {
            step: "Upload a probe file".into(),
            ok: Some(false),
            detail: Some(plain(e)),
        }),
    }

    match put {
        Ok(f) => match store.delete(&f.key).await {
            Ok(()) => {
                steps.push(CheckStep { step: "Delete it again".into(), ok: Some(true), detail: None })
            }
            Err(e) => steps.push(CheckStep {
                step: "Delete it again".into(),
                // Called out rather than shrugged off: a probe left behind is litter, and a
                // store that cannot delete cannot be tidied from the Files screen either.
                ok: Some(false),
                detail: Some(format!("{} — {PROBE} is still there", plain(&e))),
            }),
        },
        Err(_) => steps.push(CheckStep { step: "Delete it again".into(), ok: None, detail: None }),
    }

    let ok = steps.iter().all(|s| s.ok == Some(true));
    CheckResult { ok, steps }
}

/// POST /api/v1/file-stores/{id}/test
pub async fn test_store(
    State(state): State<FileStoreState>,
    Path(id): Path<String>,
) -> Result<Json<CheckResult>, AppError> {
    let cfg = config_for(&state, &id).await?;
    Ok(Json(run_check(&cfg).await))
}

/// POST /api/v1/projects/{id}/file-stores/test — check a configuration that is not saved yet.
///
/// So an author finds out whether it works *before* committing it, which is the difference
/// between a form that helps and one that records a guess.
pub async fn test_draft(
    Path(_project_id): Path<String>,
    Json(input): Json<CreateFileStore>,
) -> Result<Json<CheckResult>, AppError> {
    Ok(Json(run_check(&draft_config(input)?).await))
}

fn draft_config(input: CreateFileStore) -> Result<StoreConfig, AppError> {
    let endpoint = input.endpoint.trim().trim_end_matches('/').to_string();
    if endpoint.is_empty() {
        return Err(AppError::BadRequest("a storage needs an endpoint".to_string()));
    }
    let kind = match input.kind.as_str() {
        "http" => StoreKind::Http,
        _ => StoreKind::S3,
    };
    Ok(StoreConfig {
        kind,
        endpoint,
        bucket: input.bucket,
        prefix: match input.prefix.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => format!("{}/", p.trim_matches('/')),
            None => String::new(),
        },
        access_key: input.access_key,
        secret_key: input.secret_key,
        token: input.token,
        reference: match input.reference.as_deref() {
            Some("url") => Reference::Url,
            Some("key") => Reference::Key,
            // minio hands over a key: a URL to an in-cluster minio is an RFC1918 address,
            // which is exactly what the platform's SSRF guard rejects.
            _ => match kind {
                StoreKind::Http => Reference::Url,
                StoreKind::S3 => Reference::Key,
            },
        },
        region: input.region.unwrap_or_else(|| "us-east-1".to_string()),
    })
}

/// POST /api/v1/projects/{id}/file-stores/buckets — what this credential can see.
///
/// Takes a draft rather than a saved id, because the whole point is to answer it *while* someone
/// is filling the form in and does not yet know what to type.
pub async fn list_buckets(
    Path(_project_id): Path<String>,
    Json(input): Json<CreateFileStore>,
) -> Result<Json<Vec<String>>, AppError> {
    Ok(Json(open(&draft_config(input)?)?.buckets().await?))
}

#[derive(Debug, Deserialize)]
pub struct CreateBucketRequest {
    #[serde(flatten)]
    pub store: CreateFileStore,
    /// The bucket to make. Separate from the draft's own `bucket` so this cannot quietly create
    /// something other than what the author asked for.
    pub bucket: String,
}

/// POST /api/v1/projects/{id}/file-stores/create-bucket
pub async fn create_bucket(
    Path(_project_id): Path<String>,
    Json(input): Json<CreateBucketRequest>,
) -> Result<StatusCode, AppError> {
    let name = input.bucket.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("which bucket? a name is required".to_string()));
    }
    open(&draft_config(input.store)?)?.create_bucket(&name).await?;
    Ok(StatusCode::CREATED)
}

// ------------------------------------------------------------- files in a storage

#[derive(Debug, Deserialize)]
pub struct KeyQuery {
    pub key: String,
}

async fn store_for(state: &FileStoreState, id: &str) -> Result<Box<dyn Store>, AppError> {
    open(&config_for(state, id).await?)
}

/// GET /api/v1/file-stores/{id}/files
pub async fn list_files(
    State(state): State<FileStoreState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<StoredFile>>, AppError> {
    Ok(Json(store_for(&state, &id).await?.list().await?))
}

/// POST /api/v1/file-stores/{id}/files — multipart, one or more `file` parts.
///
/// Several in one request, because "select one or more files" is a single action and five
/// separate failures for it would be five things to make sense of.
pub async fn upload(
    State(state): State<FileStoreState>,
    Path(id): Path<String>,
    mut form: Multipart,
) -> Result<(StatusCode, Json<Vec<StoredFile>>), AppError> {
    let store = store_for(&state, &id).await?;
    let mut stored = Vec::new();

    while let Some(field) = form
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("could not read the upload: {e}")))?
    {
        let name = field.file_name().map(sanitise).unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let mime = field.content_type().map(str::to_string);
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("could not read \"{name}\": {e}")))?;

        if bytes.len() as u64 > MAX_UPLOAD_BYTES {
            return Err(AppError::BadRequest(format!(
                "\"{}\" is {:.1} MB — this server accepts up to {} MB, because an upload passes \
                 through its memory",
                name,
                bytes.len() as f64 / 1_048_576.0,
                MAX_UPLOAD_BYTES / 1_048_576
            )));
        }
        if bytes.is_empty() {
            return Err(AppError::BadRequest(format!("\"{name}\" is empty")));
        }

        // The extension is deliberately not checked: `wrong extension → 400` is a case an
        // author wants to write, so the store must hold whatever it is given. The UI flags it.
        stored.push(store.put(&name, bytes.to_vec(), mime.as_deref()).await?);
    }

    if stored.is_empty() {
        return Err(AppError::BadRequest(
            "no files in the upload — expected one or more `file` parts".to_string(),
        ));
    }
    Ok((StatusCode::CREATED, Json(stored)))
}

/// DELETE /api/v1/file-stores/{id}/files?key=…
///
/// The key is a query parameter rather than a path segment because it contains slashes, and a
/// wildcard route would have to guess where it begins.
pub async fn delete_file(
    State(state): State<FileStoreState>,
    Path(id): Path<String>,
    Query(q): Query<KeyQuery>,
) -> Result<StatusCode, AppError> {
    if q.key.trim().is_empty() {
        return Err(AppError::BadRequest("which file? `key` is required".to_string()));
    }
    store_for(&state, &id).await?.delete(&q.key).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn plain(e: &AppError) -> String {
    format!("{e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_environment_store_cannot_be_edited_and_says_where_it_can_be() {
        // Offering a Save that silently did nothing would be worse than refusing.
        let e = refuse_env("env:SAT_FILESTORE_DEV", "changed").unwrap_err();
        let msg = format!("{e}");
        assert!(msg.contains("SAT_FILESTORE_DEV_*"), "{msg}");
        assert!(msg.contains("restart"), "{msg}");
        // A saved store is untouched by the guard.
        assert!(refuse_env("2f9c-uuid", "changed").is_ok());
    }

    #[test]
    fn a_draft_takes_its_reference_form_from_its_kind() {
        let s3 = draft_config(CreateFileStore {
            name: "m".into(),
            kind: "s3".into(),
            endpoint: "http://h:9000".into(),
            bucket: Some("b".into()),
            prefix: Some("/fx/".into()),
            access_key: None,
            secret_key: None,
            token: None,
            reference: None,
            region: None,
        })
        .unwrap();
        // A URL to an in-cluster minio is RFC1918, which is the case the SSRF guard rejects.
        assert_eq!(s3.reference, Reference::Key);
        assert_eq!(s3.prefix, "fx/");

        let http = draft_config(CreateFileStore {
            name: "f".into(),
            kind: "http".into(),
            endpoint: "https://files/".into(),
            bucket: None,
            prefix: None,
            access_key: None,
            secret_key: None,
            token: None,
            reference: None,
            region: None,
        })
        .unwrap();
        assert_eq!(http.reference, Reference::Url);
        assert_eq!(http.endpoint, "https://files");
    }

    #[tokio::test]
    async fn a_check_reports_the_step_that_failed_and_does_not_pretend_the_rest_ran() {
        // A dead port, so listing cannot succeed.
        let cfg = draft_config(CreateFileStore {
            name: "f".into(),
            kind: "http".into(),
            endpoint: "http://127.0.0.1:1".into(),
            bucket: None,
            prefix: None,
            access_key: None,
            secret_key: None,
            token: None,
            reference: None,
            region: None,
        })
        .unwrap();

        let result = run_check(&cfg).await;
        assert!(!result.ok);
        assert_eq!(result.steps.len(), 3);
        assert_eq!(result.steps[0].ok, Some(false));
        assert!(result.steps[0].detail.as_deref().unwrap().contains("127.0.0.1:1"));
        // `None`, not `false`: these never ran, and a cross would send the author looking at
        // permissions when the endpoint is what is wrong.
        assert_eq!(result.steps[1].ok, None);
        assert_eq!(result.steps[2].ok, None);
    }

    #[test]
    fn an_environment_store_is_listed_read_only_with_no_secret_in_it() {
        let cfg = StoreConfig {
            kind: StoreKind::S3,
            endpoint: "http://127.0.0.1:9000".into(),
            bucket: Some("sat-fixtures".into()),
            prefix: "fixtures/".into(),
            access_key: Some("AK".into()),
            secret_key: Some("supersecret".into()),
            token: None,
            reference: Reference::Key,
            region: "us-east-1".into(),
        };
        let store = env_store("p1", "SAT_FILESTORE_DEV", &cfg);
        assert_eq!(store.id, "env:SAT_FILESTORE_DEV");
        assert_eq!(store.source, "env");
        assert!(store.has_secret);
        // Same guarantee as a saved store: the secret has no field to travel in.
        let json = serde_json::to_string(&store).unwrap();
        assert!(!json.contains("supersecret"), "{json}");
    }
}
