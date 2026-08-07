//! File store definitions.
//!
//! Two things this repository does that the others don't:
//!
//! **Secrets go in and never come out.** `FileStore` has no `secret_key` field at all, so
//! there is no route by which one can reach a response — the compiler enforces it rather than
//! a reviewer noticing. `config_for` is the single way back to the real credentials, and it
//! returns a `StoreConfig` for server-side use only.
//!
//! **An absent secret on update means keep the stored one.** The form was never given it, so
//! it cannot send it back; treating absence as "clear it" would silently break a working store
//! every time someone renamed it. An explicit empty string does clear it.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{AnyPool, Row};
use uuid::Uuid;

use super::FileStoreRepository;
use crate::db::models::{CreateFileStore, FileStore, UpdateFileStore};
use crate::error::AppError;
use crate::files::{Reference, StoreConfig, StoreKind};

pub struct SqlxFileStoreRepository {
    pool: AnyPool,
}

impl SqlxFileStoreRepository {
    pub fn new(pool: AnyPool) -> Self {
        Self { pool }
    }
}

/// Deliberately excludes `secret_key` and `token` — see the module note.
const SAFE_COLUMNS: &str = "id, project_id, name, kind, endpoint, bucket, prefix, access_key, \
                            reference, region, \
                            CASE WHEN secret_key IS NULL OR secret_key = '' THEN 0 ELSE 1 END AS has_secret, \
                            CASE WHEN token IS NULL OR token = '' THEN 0 ELSE 1 END AS has_token, \
                            created_at, updated_at";

fn row_to_store(row: &sqlx::any::AnyRow) -> Result<FileStore, AppError> {
    Ok(FileStore {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        name: row.try_get("name")?,
        kind: row.try_get("kind")?,
        endpoint: row.try_get("endpoint")?,
        bucket: row.try_get("bucket")?,
        prefix: row.try_get("prefix")?,
        access_key: row.try_get("access_key")?,
        reference: row.try_get("reference")?,
        region: row.try_get("region")?,
        has_secret: row.try_get::<i64, _>("has_secret")? != 0,
        has_token: row.try_get::<i64, _>("has_token")? != 0,
        source: "project".to_string(),
        created_at: parse_time(row.try_get("created_at")?),
        updated_at: parse_time(row.try_get("updated_at")?),
    })
}

/// A stored timestamp, or now.
///
/// A row written by hand or by an older version should not make the whole list unreadable, and
/// the alternative — failing the request — hides every other store because one date is odd.
fn parse_time(raw: String) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(&raw).map(|t| t.with_timezone(&Utc)).unwrap_or_else(|_| Utc::now())
}

fn normalise_prefix(prefix: Option<&str>) -> String {
    match prefix.map(str::trim).filter(|p| !p.is_empty()) {
        // Exactly one trailing slash, so a key is never `fixtures//nums.csv` — nor
        // `fixturesnums.csv`, which is a different object that looks right in a log.
        Some(p) => format!("{}/", p.trim_matches('/')),
        None => String::new(),
    }
}

fn validate(name: &str, kind: &str, endpoint: &str) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err(AppError::BadRequest("a storage needs a name".to_string()));
    }
    if !matches!(kind, "s3" | "http") {
        return Err(AppError::BadRequest(format!(
            "\"{kind}\" is not a kind of storage — expected \"s3\" or \"http\""
        )));
    }
    let e = endpoint.trim();
    if e.is_empty() {
        return Err(AppError::BadRequest("a storage needs an endpoint".to_string()));
    }
    if !e.starts_with("http://") && !e.starts_with("https://") {
        return Err(AppError::BadRequest(format!(
            "the endpoint needs a scheme — try http://{e}"
        )));
    }
    Ok(())
}

#[async_trait]
impl FileStoreRepository for SqlxFileStoreRepository {
    async fn list_by_project(&self, project_id: &str) -> Result<Vec<FileStore>, AppError> {
        let rows = sqlx::query(&format!(
            "SELECT {SAFE_COLUMNS} FROM file_stores WHERE project_id = ? ORDER BY name COLLATE NOCASE"
        ))
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_store).collect()
    }

    async fn get_by_id(&self, id: &str) -> Result<Option<FileStore>, AppError> {
        let row = sqlx::query(&format!("SELECT {SAFE_COLUMNS} FROM file_stores WHERE id = ?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(row_to_store).transpose()
    }

    async fn create(&self, project_id: &str, input: CreateFileStore) -> Result<FileStore, AppError> {
        validate(&input.name, &input.kind, &input.endpoint)?;
        if self.name_taken(project_id, input.name.trim(), None).await? {
            return Err(AppError::Conflict(format!(
                "this project already has a storage called \"{}\"",
                input.name.trim()
            )));
        }

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"INSERT INTO file_stores
               (id, project_id, name, kind, endpoint, bucket, prefix, access_key, secret_key,
                token, reference, region, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(project_id)
        .bind(input.name.trim())
        .bind(&input.kind)
        .bind(input.endpoint.trim().trim_end_matches('/'))
        .bind(&input.bucket)
        .bind(normalise_prefix(input.prefix.as_deref()))
        .bind(&input.access_key)
        .bind(&input.secret_key)
        .bind(&input.token)
        .bind(input.reference.as_deref().unwrap_or(default_reference(&input.kind)))
        .bind(input.region.as_deref().unwrap_or("us-east-1"))
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        self.get_by_id(&id)
            .await?
            .ok_or_else(|| AppError::Internal("the storage vanished after being saved".to_string()))
    }

    async fn update(&self, id: &str, input: UpdateFileStore) -> Result<FileStore, AppError> {
        let existing = self
            .get_by_id(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("no storage with id {id}")))?;

        let name = input.name.clone().unwrap_or_else(|| existing.name.clone());
        let kind = input.kind.clone().unwrap_or_else(|| existing.kind.clone());
        let endpoint = input.endpoint.clone().unwrap_or_else(|| existing.endpoint.clone());
        validate(&name, &kind, &endpoint)?;

        if name.trim().to_lowercase() != existing.name.to_lowercase()
            && self.name_taken(&existing.project_id, name.trim(), Some(id)).await?
        {
            return Err(AppError::Conflict(format!(
                "this project already has a storage called \"{}\"",
                name.trim()
            )));
        }

        // COALESCE on the two secrets is what makes absence mean "keep": the bind is NULL when
        // the field was not sent, and NULL leaves the column alone. An explicit empty string
        // is not NULL, so clearing still works.
        sqlx::query(
            r#"UPDATE file_stores SET
                 name = ?, kind = ?, endpoint = ?, bucket = ?, prefix = ?, access_key = ?,
                 secret_key = COALESCE(?, secret_key),
                 token = COALESCE(?, token),
                 reference = ?, region = ?, updated_at = ?
               WHERE id = ?"#,
        )
        .bind(name.trim())
        .bind(&kind)
        .bind(endpoint.trim().trim_end_matches('/'))
        .bind(input.bucket.or(existing.bucket))
        .bind(normalise_prefix(input.prefix.as_deref().or(Some(&existing.prefix))))
        .bind(input.access_key.or(existing.access_key))
        .bind(&input.secret_key)
        .bind(&input.token)
        .bind(input.reference.unwrap_or(existing.reference))
        .bind(input.region.unwrap_or(existing.region))
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;

        self.get_by_id(id)
            .await?
            .ok_or_else(|| AppError::Internal("the storage vanished after being saved".to_string()))
    }

    async fn delete(&self, id: &str) -> Result<(), AppError> {
        // Nothing is checked for references. A store's whole output is text already pasted
        // into tests, and those keep whatever they were given — deleting the definition does
        // not reach into them. What breaks is the next upload, and that says so.
        sqlx::query("DELETE FROM file_stores WHERE id = ?").bind(id).execute(&self.pool).await?;
        Ok(())
    }

    async fn config_for(&self, id: &str) -> Result<Option<StoreConfig>, AppError> {
        let row = sqlx::query(
            "SELECT kind, endpoint, bucket, prefix, access_key, secret_key, token, reference, \
             region FROM file_stores WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else { return Ok(None) };
        let kind = match row.try_get::<String, _>("kind")?.as_str() {
            "http" => StoreKind::Http,
            _ => StoreKind::S3,
        };
        let reference = match row.try_get::<String, _>("reference")?.as_str() {
            "url" => Reference::Url,
            _ => Reference::Key,
        };
        Ok(Some(StoreConfig {
            kind,
            endpoint: row.try_get("endpoint")?,
            bucket: row.try_get("bucket")?,
            prefix: row.try_get("prefix")?,
            access_key: row.try_get("access_key")?,
            secret_key: row.try_get("secret_key")?,
            token: row.try_get("token")?,
            reference,
            region: row.try_get("region")?,
        }))
    }

    async fn name_taken(
        &self,
        project_id: &str,
        name: &str,
        except: Option<&str>,
    ) -> Result<bool, AppError> {
        let taken: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM file_stores \
             WHERE project_id = ? AND name = ? COLLATE NOCASE AND id <> ?",
        )
        .bind(project_id)
        .bind(name)
        .bind(except.unwrap_or(""))
        .fetch_one(&self.pool)
        .await?;
        Ok(taken > 0)
    }
}

/// minio hands over a key by default, a file service a URL.
///
/// A URL to an in-cluster minio is an RFC1918 address, which is what the platform's SSRF guard
/// rejects — so defaulting an S3 store to a URL would default it to broken.
fn default_reference(kind: &str) -> &'static str {
    match kind {
        "http" => "url",
        _ => "key",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::any::{install_default_drivers, AnyPoolOptions};

    async fn setup() -> SqlxFileStoreRepository {
        install_default_drivers();
        let pool = AnyPoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys=ON").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        for statement in include_str!("../../../migrations/011_file_stores.sql").split(';') {
            let stmt = statement.trim();
            if stmt.lines().any(|l| !l.trim().is_empty() && !l.trim().starts_with("--")) {
                sqlx::query(stmt).execute(&pool).await.unwrap();
            }
        }
        sqlx::query("INSERT INTO projects (id) VALUES ('p1')").execute(&pool).await.unwrap();
        SqlxFileStoreRepository::new(pool)
    }

    fn minio(name: &str) -> CreateFileStore {
        CreateFileStore {
            name: name.into(),
            kind: "s3".into(),
            endpoint: "http://127.0.0.1:9000/".into(),
            bucket: Some("sat-fixtures".into()),
            prefix: Some("/fixtures/".into()),
            access_key: Some("MV5SimprxKP2XBpFVA2l".into()),
            secret_key: Some("supersecret".into()),
            token: None,
            reference: None,
            region: None,
        }
    }

    #[tokio::test]
    async fn a_saved_store_never_hands_back_its_secret() {
        // The assertion this whole module exists for. `FileStore` has no field for it, so this
        // is really checking that nothing was smuggled into another one.
        let repo = setup().await;
        let saved = repo.create("p1", minio("sat-fixtures")).await.unwrap();
        let json = serde_json::to_string(&saved).unwrap();
        assert!(!json.contains("supersecret"), "{json}");
        // …but the form has to know one is there, or it cannot tell "leave it" from "unset".
        assert!(saved.has_secret);
        assert!(!saved.has_token);
        // The access key is not a secret and is shown, so a mistyped one is visible.
        assert_eq!(saved.access_key.as_deref(), Some("MV5SimprxKP2XBpFVA2l"));
        assert_eq!(saved.source, "project");
    }

    #[tokio::test]
    async fn the_real_credentials_come_back_only_through_config_for() {
        let repo = setup().await;
        let saved = repo.create("p1", minio("sat-fixtures")).await.unwrap();
        let cfg = repo.config_for(&saved.id).await.unwrap().unwrap();
        assert_eq!(cfg.secret_key.as_deref(), Some("supersecret"));
        assert_eq!(cfg.kind, StoreKind::S3);
        // minio defaults to a key, because a URL at an RFC1918 address is what the guard rejects.
        assert_eq!(cfg.reference, Reference::Key);
        assert!(repo.config_for("nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn renaming_a_store_does_not_wipe_its_secret() {
        // The failure this prevents: the form never received the secret, so it sends nothing
        // back, and a naive UPDATE writes NULL over a working credential. Every rename would
        // quietly break the store.
        let repo = setup().await;
        let saved = repo.create("p1", minio("sat-fixtures")).await.unwrap();

        let renamed = repo
            .update(
                &saved.id,
                UpdateFileStore {
                    name: Some("minio (dev)".into()),
                    kind: None,
                    endpoint: None,
                    bucket: None,
                    prefix: None,
                    access_key: None,
                    secret_key: None,
                    token: None,
                    reference: None,
                    region: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(renamed.name, "minio (dev)");
        assert!(renamed.has_secret);
        let cfg = repo.config_for(&saved.id).await.unwrap().unwrap();
        assert_eq!(cfg.secret_key.as_deref(), Some("supersecret"));
        // And the rest survived the partial update too.
        assert_eq!(cfg.bucket.as_deref(), Some("sat-fixtures"));
        assert_eq!(cfg.prefix, "fixtures/");
    }

    #[tokio::test]
    async fn a_secret_can_still_be_replaced_or_cleared() {
        let repo = setup().await;
        let saved = repo.create("p1", minio("sat-fixtures")).await.unwrap();

        let patch = |secret: Option<String>| UpdateFileStore {
            name: None, kind: None, endpoint: None, bucket: None, prefix: None,
            access_key: None, secret_key: secret, token: None, reference: None, region: None,
        };

        repo.update(&saved.id, patch(Some("newsecret".into()))).await.unwrap();
        assert_eq!(
            repo.config_for(&saved.id).await.unwrap().unwrap().secret_key.as_deref(),
            Some("newsecret")
        );

        // An explicit empty string is a different request from not mentioning it.
        let cleared = repo.update(&saved.id, patch(Some(String::new()))).await.unwrap();
        assert!(!cleared.has_secret);
    }

    #[tokio::test]
    async fn two_stores_cannot_share_a_name() {
        // The picker is the whole interface for switching between them, and two identical
        // entries cannot be told apart in it.
        let repo = setup().await;
        repo.create("p1", minio("sat-fixtures")).await.unwrap();
        let clash = repo.create("p1", minio("SAT-FIXTURES")).await;
        assert!(matches!(clash, Err(AppError::Conflict(_))), "{clash:?}");
    }

    #[tokio::test]
    async fn a_prefix_is_normalised_and_an_endpoint_trimmed() {
        let repo = setup().await;
        let saved = repo.create("p1", minio("sat-fixtures")).await.unwrap();
        // `/fixtures/` in, `fixtures/` out — one trailing slash, no leading one.
        assert_eq!(saved.prefix, "fixtures/");
        // The endpoint's trailing slash is dropped, because every URL is built by appending
        // a path that starts with one.
        assert_eq!(saved.endpoint, "http://127.0.0.1:9000");
    }

    #[tokio::test]
    async fn nonsense_is_refused_with_something_to_act_on() {
        let repo = setup().await;
        let mut no_name = minio("sat-fixtures");
        no_name.name = "   ".into();
        assert!(format!("{:?}", repo.create("p1", no_name).await).contains("needs a name"));

        let mut bad_kind = minio("a");
        bad_kind.kind = "ftp".into();
        let e = format!("{:?}", repo.create("p1", bad_kind).await);
        assert!(e.contains("\\\"s3\\\"") || e.contains("s3"), "{e}");

        // The commonest typo, and the message says what to type instead.
        let mut no_scheme = minio("b");
        no_scheme.endpoint = "127.0.0.1:9000".into();
        let e = format!("{:?}", repo.create("p1", no_scheme).await);
        assert!(e.contains("http://127.0.0.1:9000"), "{e}");
    }

    #[tokio::test]
    async fn deleting_a_store_leaves_the_tests_that_used_it_alone() {
        // Nothing is checked for references, deliberately: a reference is already a literal in
        // a test body, and deleting the definition cannot reach into it. What breaks is the
        // next upload, which says so.
        let repo = setup().await;
        let saved = repo.create("p1", minio("sat-fixtures")).await.unwrap();
        repo.delete(&saved.id).await.unwrap();
        assert!(repo.get_by_id(&saved.id).await.unwrap().is_none());
        // Deleting one that is already gone is not an error — the caller asked for absence.
        repo.delete(&saved.id).await.unwrap();
    }
}
