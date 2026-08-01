//! Suite repository.
//!
//! `members` is stored as a JSON array, or NULL for "everything in the project".
//! NULL and `[]` are deliberately different: absence means the selection was never
//! narrowed, so a flow added tomorrow is included, while an empty array means the author
//! narrowed it to nothing and the run says so rather than quietly doing everything.

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{AnyPool, Row};
use uuid::Uuid;

use crate::db::models::*;
use crate::error::AppError;
use super::SuiteRepository;

pub struct SqlxSuiteRepository {
    pool: AnyPool,
}

impl SqlxSuiteRepository {
    pub fn new(pool: AnyPool) -> Self {
        Self { pool }
    }
}

const COLUMNS: &str = "id, project_id, name, members, created_at, updated_at";

#[async_trait]
impl SuiteRepository for SqlxSuiteRepository {
    async fn create(&self, project_id: &str, input: CreateSuite) -> Result<Suite, AppError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();

        sqlx::query(
            r#"INSERT INTO suites (id, project_id, name, members, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(project_id)
        .bind(&input.name)
        .bind(encode_members(input.members.as_deref())?)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(Suite {
            id,
            project_id: project_id.to_string(),
            name: input.name,
            members: input.members,
            created_at: now,
            updated_at: now,
        })
    }

    async fn get_by_id(&self, id: &str) -> Result<Option<Suite>, AppError> {
        let row = sqlx::query(&format!("SELECT {COLUMNS} FROM suites WHERE id = ?"))
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(row_to_suite).transpose()
    }

    async fn list_by_project(&self, project_id: &str) -> Result<Vec<Suite>, AppError> {
        let rows = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM suites WHERE project_id = ? ORDER BY created_at DESC"
        ))
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(row_to_suite).collect()
    }

    async fn update(&self, id: &str, input: UpdateSuite) -> Result<Suite, AppError> {
        let existing = self
            .get_by_id(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Suite {} not found", id)))?;

        // `members` absent leaves the selection alone; present-and-null resets it to
        // "everything". Both are edits the PATCH has to be able to express, which is why
        // the field is an Option of an Option.
        let members = match input.members {
            Some(next) => next,
            None => existing.members,
        };
        let name = input.name.unwrap_or(existing.name);
        let now = Utc::now();

        sqlx::query("UPDATE suites SET name = ?, members = ?, updated_at = ? WHERE id = ?")
            .bind(&name)
            .bind(encode_members(members.as_deref())?)
            .bind(now.to_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await?;

        Ok(Suite { name, members, updated_at: now, ..existing })
    }

    async fn delete(&self, id: &str) -> Result<(), AppError> {
        let result = sqlx::query("DELETE FROM suites WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Suite {} not found", id)));
        }
        Ok(())
    }
}

fn encode_members(members: Option<&[SuiteMember]>) -> Result<Option<String>, AppError> {
    members
        .map(|m| serde_json::to_string(m).map_err(|e| AppError::Internal(e.to_string())))
        .transpose()
}

fn row_to_suite(row: &sqlx::any::AnyRow) -> Result<Suite, AppError> {
    let members: Option<String> = row.try_get("members")?;
    let created: String = row.try_get("created_at")?;
    let updated: String = row.try_get("updated_at")?;

    Ok(Suite {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        name: row.try_get("name")?,
        // A selection that will not parse is treated as absent rather than as empty:
        // running everything is recoverable, running nothing looks like the suite works
        // and covers nothing.
        members: members.and_then(|json| serde_json::from_str(&json).ok()),
        created_at: chrono::DateTime::parse_from_rfc3339(&created)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::any::{install_default_drivers, AnyPoolOptions};

    async fn repo() -> SqlxSuiteRepository {
        install_default_drivers();
        let pool = AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        for statement in include_str!("../../../migrations/009_runs.sql").split(';') {
            let stmt = statement.trim();
            if stmt.lines().any(|l| !l.trim().is_empty() && !l.trim().starts_with("--")) {
                sqlx::query(stmt).execute(&pool).await.unwrap();
            }
        }
        sqlx::query("INSERT INTO projects (id) VALUES ('p1')").execute(&pool).await.unwrap();
        SqlxSuiteRepository::new(pool)
    }

    fn flow(id: &str) -> SuiteMember {
        SuiteMember { kind: MemberKind::Flow, id: id.into() }
    }

    #[tokio::test]
    async fn a_new_suite_selects_nothing_and_therefore_everything() {
        let repo = repo().await;
        let suite = repo
            .create("p1", CreateSuite { name: "Regression".into(), members: None })
            .await
            .unwrap();
        assert_eq!(suite.members, None);
        assert_eq!(repo.get_by_id(&suite.id).await.unwrap().unwrap().members, None);
    }

    #[tokio::test]
    async fn an_edited_selection_round_trips_in_order() {
        let repo = repo().await;
        let chosen = vec![flow("f2"), SuiteMember { kind: MemberKind::Test, id: "t1".into() }, flow("f1")];
        let suite = repo
            .create("p1", CreateSuite { name: "Smoke".into(), members: Some(chosen.clone()) })
            .await
            .unwrap();

        let read = repo.get_by_id(&suite.id).await.unwrap().unwrap();
        // Order is the run order, so it must survive the round trip exactly.
        assert_eq!(read.members, Some(chosen));
    }

    #[tokio::test]
    async fn an_empty_selection_is_stored_as_empty_not_as_everything() {
        // The distinction the whole absent-means-everything rule rests on. Collapse these
        // two and narrowing a suite to nothing would silently run the entire project.
        let repo = repo().await;
        let suite = repo
            .create("p1", CreateSuite { name: "Paused".into(), members: Some(vec![]) })
            .await
            .unwrap();
        assert_eq!(repo.get_by_id(&suite.id).await.unwrap().unwrap().members, Some(vec![]));
    }

    #[tokio::test]
    async fn a_patch_can_rename_without_touching_the_selection() {
        let repo = repo().await;
        let suite = repo
            .create("p1", CreateSuite { name: "Old".into(), members: Some(vec![flow("f1")]) })
            .await
            .unwrap();

        let updated = repo
            .update(&suite.id, UpdateSuite { name: Some("New".into()), members: None })
            .await
            .unwrap();

        assert_eq!(updated.name, "New");
        assert_eq!(updated.members, Some(vec![flow("f1")]), "the selection was left alone");
    }

    #[tokio::test]
    async fn a_patch_can_put_the_selection_back_to_everything() {
        let repo = repo().await;
        let suite = repo
            .create("p1", CreateSuite { name: "Smoke".into(), members: Some(vec![flow("f1")]) })
            .await
            .unwrap();

        let updated = repo
            .update(&suite.id, UpdateSuite { name: None, members: Some(None) })
            .await
            .unwrap();

        assert_eq!(updated.members, None);
        assert_eq!(updated.name, "Smoke");
    }
}
