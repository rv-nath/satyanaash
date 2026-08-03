//! Test group repository implementation using SQLx AnyPool

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{AnyPool, Row};
use uuid::Uuid;

use crate::db::models::*;
use crate::error::AppError;
use super::TestGroupRepository;

/// SQLx-based test group repository
pub struct SqlxTestGroupRepository {
    pool: AnyPool,
}

impl SqlxTestGroupRepository {
    pub fn new(pool: AnyPool) -> Self {
        Self { pool }
    }

    /// Is this name already taken in the project?
    ///
    /// Case-insensitively, because a group is a label a person reads: "Platform Ops" and
    /// "platform ops" in the same sidebar is a mistake every time, not a distinction.
    /// `except` skips one group, so renaming a group to the case it already has is allowed.
    async fn name_taken(
        &self,
        project_id: &str,
        name: &str,
        except: Option<&str>,
    ) -> Result<bool, AppError> {
        let taken: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM test_groups \
             WHERE project_id = ? AND name = ? COLLATE NOCASE AND id <> ?",
        )
        .bind(project_id)
        .bind(name)
        .bind(except.unwrap_or(""))
        .fetch_one(&self.pool)
        .await?;
        Ok(taken > 0)
    }

    async fn get_by_id(&self, id: &str) -> Result<Option<TestGroup>, AppError> {
        let row = sqlx::query(
            "SELECT id, project_id, name, created_at, updated_at FROM test_groups WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(Some(row_to_test_group(&row)?)),
            None => Ok(None),
        }
    }
}

#[async_trait]
impl TestGroupRepository for SqlxTestGroupRepository {
    async fn create(&self, project_id: &str, input: CreateTestGroup) -> Result<TestGroup, AppError> {
        // Two groups with one name is not a state anyone wants: the sidebar shows the same
        // label twice and there is no way to tell which a test is in. Refused rather than
        // silently allowed — which is how the project came to have two "Platform Ops".
        if self.name_taken(project_id, &input.name, None).await? {
            return Err(AppError::Conflict(format!(
                "A group called \"{}\" already exists in this project",
                input.name
            )));
        }

        let id = Uuid::new_v4().to_string();
        let now = Utc::now();

        sqlx::query(
            r#"INSERT INTO test_groups (id, project_id, name, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)"#,
        )
        .bind(&id)
        .bind(project_id)
        .bind(&input.name)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(TestGroup {
            id,
            project_id: project_id.to_string(),
            name: input.name,
            created_at: now,
            updated_at: now,
        })
    }

    async fn list_by_project(&self, project_id: &str) -> Result<Vec<TestGroup>, AppError> {
        // Newest first — new groups appear at the top.
        let rows = sqlx::query(
            r#"SELECT id, project_id, name, created_at, updated_at
               FROM test_groups WHERE project_id = ? ORDER BY created_at DESC"#,
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;

        rows.iter().map(row_to_test_group).collect()
    }

    async fn update(&self, id: &str, input: UpdateTestGroup) -> Result<TestGroup, AppError> {
        // Renaming into a name someone else holds is the same collision as creating one.
        // Guarding create alone would leave the back door open.
        let existing = self
            .get_by_id(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Test group {} not found", id)))?;
        if self.name_taken(&existing.project_id, &input.name, Some(id)).await? {
            return Err(AppError::Conflict(format!(
                "A group called \"{}\" already exists in this project",
                input.name
            )));
        }

        let now = Utc::now();
        let result = sqlx::query("UPDATE test_groups SET name = ?, updated_at = ? WHERE id = ?")
            .bind(&input.name)
            .bind(now.to_rfc3339())
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Test group {} not found", id)));
        }

        self.get_by_id(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Test group {} not found", id)))
    }

    async fn delete(&self, id: &str) -> Result<(), AppError> {
        // Tests fall back to Ungrouped rather than being deleted.
        sqlx::query("UPDATE test_cases SET group_id = NULL WHERE group_id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        let result = sqlx::query("DELETE FROM test_groups WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Test group {} not found", id)));
        }

        Ok(())
    }
}

/// Convert a database row to a TestGroup
fn row_to_test_group(row: &sqlx::any::AnyRow) -> Result<TestGroup, AppError> {
    let created_str: String = row.try_get("created_at")?;
    let updated_str: String = row.try_get("updated_at")?;

    Ok(TestGroup {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        name: row.try_get("name")?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::any::{install_default_drivers, AnyPoolOptions};

    async fn setup_pool() -> AnyPool {
        install_default_drivers();
        // One connection so the in-memory DB is shared across all queries.
        let pool = AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::query(
            "CREATE TABLE test_groups (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE test_cases (id TEXT PRIMARY KEY, group_id TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn create_list_orders_newest_first() {
        let pool = setup_pool().await;
        // Seed two groups with controlled timestamps (older then newer).
        sqlx::query("INSERT INTO test_groups (id, project_id, name, created_at, updated_at) VALUES ('g1','p','Older','2020-01-01T00:00:00+00:00','2020-01-01T00:00:00+00:00')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO test_groups (id, project_id, name, created_at, updated_at) VALUES ('g2','p','Newer','2021-01-01T00:00:00+00:00','2021-01-01T00:00:00+00:00')")
            .execute(&pool).await.unwrap();

        let repo = SqlxTestGroupRepository::new(pool);
        let groups = repo.list_by_project("p").await.unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].name, "Newer"); // newest first
        assert_eq!(groups[1].name, "Older");
    }

    #[tokio::test]
    async fn a_second_group_cannot_take_a_name_already_in_use() {
        // Two groups with one name shows the same label twice in the sidebar with no way to
        // tell which a test is in. This is how the project came to have two "Platform Ops".
        let repo = SqlxTestGroupRepository::new(setup_pool().await);
        repo.create("p", CreateTestGroup { name: "Platform Ops".into() }).await.unwrap();

        let again = repo.create("p", CreateTestGroup { name: "Platform Ops".into() }).await;
        assert!(matches!(again, Err(AppError::Conflict(_))), "{again:?}");
        // …and the message names the group, so the toast is useful without opening a log.
        if let Err(AppError::Conflict(msg)) = again {
            assert!(msg.contains("Platform Ops"), "{msg}");
        }
        assert_eq!(repo.list_by_project("p").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_clash_is_case_insensitive() {
        // A group is a label a person reads. "Platform Ops" beside "platform ops" is a
        // mistake every time, not a distinction worth preserving.
        let repo = SqlxTestGroupRepository::new(setup_pool().await);
        repo.create("p", CreateTestGroup { name: "Platform Ops".into() }).await.unwrap();
        let lower = repo.create("p", CreateTestGroup { name: "platform ops".into() }).await;
        assert!(matches!(lower, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn another_project_may_use_the_same_name() {
        // The clash is per project. Two projects each having a "Default" is normal.
        let repo = SqlxTestGroupRepository::new(setup_pool().await);
        repo.create("p", CreateTestGroup { name: "Default".into() }).await.unwrap();
        assert!(repo.create("other", CreateTestGroup { name: "Default".into() }).await.is_ok());
    }

    #[tokio::test]
    async fn renaming_into_a_taken_name_is_refused_too() {
        // Guarding create alone would leave the back door open: create "B", rename it "A".
        let repo = SqlxTestGroupRepository::new(setup_pool().await);
        repo.create("p", CreateTestGroup { name: "wallet".into() }).await.unwrap();
        let sms = repo.create("p", CreateTestGroup { name: "sms".into() }).await.unwrap();

        let clash = repo.update(&sms.id, UpdateTestGroup { name: "wallet".into() }).await;
        assert!(matches!(clash, Err(AppError::Conflict(_))), "{clash:?}");
        // The rename did not happen.
        assert_eq!(repo.get_by_id(&sms.id).await.unwrap().unwrap().name, "sms");
    }

    #[tokio::test]
    async fn a_group_may_be_renamed_to_a_different_case_of_its_own_name() {
        // Fixing the capitalisation of a group is not a clash with itself, which a naive
        // "is this name taken" check would refuse.
        let repo = SqlxTestGroupRepository::new(setup_pool().await);
        let g = repo.create("p", CreateTestGroup { name: "platform ops".into() }).await.unwrap();
        let fixed = repo.update(&g.id, UpdateTestGroup { name: "Platform Ops".into() }).await;
        assert_eq!(fixed.unwrap().name, "Platform Ops");
    }

    #[tokio::test]
    async fn delete_nulls_group_id_on_tests() {
        let pool = setup_pool().await;
        let repo = SqlxTestGroupRepository::new(pool.clone());
        let g = repo.create("p", CreateTestGroup { name: "Campaigns".into() }).await.unwrap();
        sqlx::query("INSERT INTO test_cases (id, group_id) VALUES ('t1', ?)")
            .bind(&g.id).execute(&pool).await.unwrap();

        repo.delete(&g.id).await.unwrap();

        // group gone
        assert!(repo.list_by_project("p").await.unwrap().is_empty());
        // test case survives with NULL group_id
        let gid: Option<String> = sqlx::query_scalar("SELECT group_id FROM test_cases WHERE id = 't1'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(gid, None);
    }
}
