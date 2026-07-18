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
