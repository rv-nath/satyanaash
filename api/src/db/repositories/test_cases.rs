//! Test case repository implementation using SQLx AnyPool

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{AnyPool, Row};
use uuid::Uuid;

use crate::db::models::*;
use crate::error::AppError;
use super::TestCaseRepository;

/// SQLx-based test case repository
pub struct SqlxTestCaseRepository {
    pool: AnyPool,
}

impl SqlxTestCaseRepository {
    pub fn new(pool: AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl TestCaseRepository for SqlxTestCaseRepository {
    async fn create(&self, project_id: &str, input: CreateTestCase) -> Result<TestCase, AppError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let headers_json = serde_json::to_string(&input.headers)?;
        let exports_json = serde_json::to_string(&input.exports)?;

        sqlx::query(
            r#"INSERT INTO test_cases (
                id, project_id, name, given_condition, when_action, then_expected,
                method, endpoint, headers, payload, exports, assertion_script,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#
        )
        .bind(&id)
        .bind(project_id)
        .bind(&input.name)
        .bind(&input.given_condition)
        .bind(&input.when_action)
        .bind(&input.then_expected)
        .bind(&input.method)
        .bind(&input.endpoint)
        .bind(&headers_json)
        .bind(&input.payload)
        .bind(&exports_json)
        .bind(&input.assertion_script)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(TestCase {
            id,
            project_id: project_id.to_string(),
            name: input.name,
            given_condition: input.given_condition,
            when_action: input.when_action,
            then_expected: input.then_expected,
            method: input.method,
            endpoint: input.endpoint,
            headers: input.headers,
            payload: input.payload,
            exports: input.exports,
            assertion_script: input.assertion_script,
            created_at: now,
            updated_at: now,
        })
    }

    async fn get_by_id(&self, id: &str) -> Result<Option<TestCase>, AppError> {
        let row = sqlx::query(
            r#"SELECT id, project_id, name, given_condition, when_action, then_expected,
               method, endpoint, headers, payload, exports, assertion_script,
               created_at, updated_at
               FROM test_cases WHERE id = ?"#
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(Some(row_to_test_case(&row)?)),
            None => Ok(None),
        }
    }

    async fn list_by_project(&self, project_id: &str, pagination: Pagination) -> Result<PaginatedResponse<TestCase>, AppError> {
        // Get total count
        let count_row = sqlx::query("SELECT COUNT(*) as count FROM test_cases WHERE project_id = ?")
            .bind(project_id)
            .fetch_one(&self.pool)
            .await?;
        let total: i64 = count_row.try_get("count")?;

        // Calculate offset
        let offset = (pagination.page.saturating_sub(1)) * pagination.per_page;

        // Get paginated results
        let rows = sqlx::query(
            r#"SELECT id, project_id, name, given_condition, when_action, then_expected,
               method, endpoint, headers, payload, exports, assertion_script,
               created_at, updated_at
               FROM test_cases WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"#
        )
        .bind(project_id)
        .bind(pagination.per_page as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await?;

        let test_cases: Result<Vec<TestCase>, AppError> = rows.iter().map(row_to_test_case).collect();

        Ok(PaginatedResponse {
            data: test_cases?,
            pagination: PaginationMeta {
                page: pagination.page,
                per_page: pagination.per_page,
                total: total as u64,
                total_pages: ((total as f64) / (pagination.per_page as f64)).ceil() as u32,
            },
        })
    }

    async fn update(&self, id: &str, input: UpdateTestCase) -> Result<TestCase, AppError> {
        // First get existing test case
        let existing = self.get_by_id(id).await?
            .ok_or_else(|| AppError::NotFound(format!("Test case {} not found", id)))?;

        let now = Utc::now();
        let name = input.name.unwrap_or(existing.name);
        let given_condition = input.given_condition.or(existing.given_condition);
        let when_action = input.when_action.or(existing.when_action);
        let then_expected = input.then_expected.or(existing.then_expected);
        let method = input.method.unwrap_or(existing.method);
        let endpoint = input.endpoint.unwrap_or(existing.endpoint);
        let headers = input.headers.unwrap_or(existing.headers);
        let payload = input.payload.or(existing.payload);
        let exports = input.exports.unwrap_or(existing.exports);
        let assertion_script = input.assertion_script.or(existing.assertion_script);

        let headers_json = serde_json::to_string(&headers)?;
        let exports_json = serde_json::to_string(&exports)?;

        sqlx::query(
            r#"UPDATE test_cases SET
               name = ?, given_condition = ?, when_action = ?, then_expected = ?,
               method = ?, endpoint = ?, headers = ?, payload = ?,
               exports = ?, assertion_script = ?, updated_at = ?
               WHERE id = ?"#
        )
        .bind(&name)
        .bind(&given_condition)
        .bind(&when_action)
        .bind(&then_expected)
        .bind(&method)
        .bind(&endpoint)
        .bind(&headers_json)
        .bind(&payload)
        .bind(&exports_json)
        .bind(&assertion_script)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;

        Ok(TestCase {
            id: id.to_string(),
            project_id: existing.project_id,
            name,
            given_condition,
            when_action,
            then_expected,
            method,
            endpoint,
            headers,
            payload,
            exports,
            assertion_script,
            created_at: existing.created_at,
            updated_at: now,
        })
    }

    async fn delete(&self, id: &str) -> Result<(), AppError> {
        let result = sqlx::query("DELETE FROM test_cases WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Test case {} not found", id)));
        }

        Ok(())
    }

    async fn find_existing_ids(&self, ids: &[String]) -> Result<std::collections::HashSet<String>, AppError> {
        if ids.is_empty() {
            return Ok(std::collections::HashSet::new());
        }

        // Build query with placeholders
        let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
        let query = format!(
            "SELECT id FROM test_cases WHERE id IN ({})",
            placeholders.join(", ")
        );

        // Build and execute query
        let mut q = sqlx::query_scalar::<_, String>(&query);
        for id in ids {
            q = q.bind(id);
        }

        let existing: Vec<String> = q.fetch_all(&self.pool).await?;
        Ok(existing.into_iter().collect())
    }
}

/// Convert a database row to a TestCase
fn row_to_test_case(row: &sqlx::any::AnyRow) -> Result<TestCase, AppError> {
    let headers_str: String = row.try_get("headers")?;
    let exports_str: String = row.try_get("exports")?;
    let created_str: String = row.try_get("created_at")?;
    let updated_str: String = row.try_get("updated_at")?;

    Ok(TestCase {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        name: row.try_get("name")?,
        given_condition: row.try_get("given_condition")?,
        when_action: row.try_get("when_action")?,
        then_expected: row.try_get("then_expected")?,
        method: row.try_get("method")?,
        endpoint: row.try_get("endpoint")?,
        headers: serde_json::from_str(&headers_str)?,
        payload: row.try_get("payload")?,
        exports: serde_json::from_str(&exports_str)?,
        assertion_script: row.try_get("assertion_script")?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
    })
}
