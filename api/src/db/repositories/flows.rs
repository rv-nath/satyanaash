//! Flow repository implementation using SQLx AnyPool

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{AnyPool, Row};
use uuid::Uuid;

use crate::db::models::*;
use crate::error::AppError;
use super::FlowRepository;

/// SQLx-based flow repository
pub struct SqlxFlowRepository {
    pool: AnyPool,
}

impl SqlxFlowRepository {
    pub fn new(pool: AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl FlowRepository for SqlxFlowRepository {
    async fn create(&self, project_id: &str, input: CreateFlow) -> Result<Flow, AppError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let graph_data = input.graph_data.unwrap_or_default();
        let graph_data_json = serde_json::to_string(&graph_data)?;

        sqlx::query(
            r#"INSERT INTO flows (
                id, project_id, name, description, graph_data, canvas_settings,
                version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)"#
        )
        .bind(&id)
        .bind(project_id)
        .bind(&input.name)
        .bind(&input.description)
        .bind(&graph_data_json)
        .bind(1i32)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(Flow {
            id,
            project_id: project_id.to_string(),
            name: input.name,
            description: input.description,
            graph_data,
            version: 1,
            group_id: None,
            created_at: now,
            updated_at: now,
        })
    }

    async fn get_by_id(&self, id: &str) -> Result<Option<Flow>, AppError> {
        let row = sqlx::query(
            r#"SELECT id, project_id, name, description, graph_data, group_id,
               version, created_at, updated_at
               FROM flows WHERE id = ?"#
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(Some(row_to_flow(&row)?)),
            None => Ok(None),
        }
    }

    async fn list_by_project(&self, project_id: &str, pagination: Pagination) -> Result<PaginatedResponse<Flow>, AppError> {
        // Get total count
        let count_row = sqlx::query("SELECT COUNT(*) as count FROM flows WHERE project_id = ?")
            .bind(project_id)
            .fetch_one(&self.pool)
            .await?;
        let total: i64 = count_row.try_get("count")?;

        // Calculate offset
        let offset = (pagination.page.saturating_sub(1)) * pagination.per_page;

        // Get paginated results
        let rows = sqlx::query(
            r#"SELECT id, project_id, name, description, graph_data, group_id,
               version, created_at, updated_at
               FROM flows WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"#
        )
        .bind(project_id)
        .bind(pagination.per_page as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await?;

        let flows: Result<Vec<Flow>, AppError> = rows.iter().map(row_to_flow).collect();

        Ok(PaginatedResponse {
            data: flows?,
            pagination: PaginationMeta {
                page: pagination.page,
                per_page: pagination.per_page,
                total: total as u64,
                total_pages: ((total as f64) / (pagination.per_page as f64)).ceil() as u32,
            },
        })
    }

    async fn update(&self, id: &str, input: UpdateFlow) -> Result<Flow, AppError> {
        // First get existing flow
        let existing = self.get_by_id(id).await?
            .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", id)))?;

        // Check version for optimistic locking
        if existing.version != input.version {
            return Err(AppError::VersionConflict {
                expected: input.version,
                actual: existing.version,
            });
        }

        let now = Utc::now();
        let name = input.name.unwrap_or(existing.name);
        let description = input.description.or(existing.description);
        let new_version = existing.version + 1;

        sqlx::query(
            r#"UPDATE flows SET
               name = ?, description = ?,
               version = ?, updated_at = ?
               WHERE id = ? AND version = ?"#
        )
        .bind(&name)
        .bind(&description)
        .bind(new_version)
        .bind(now.to_rfc3339())
        .bind(id)
        .bind(input.version)
        .execute(&self.pool)
        .await?;

        Ok(Flow {
            id: id.to_string(),
            project_id: existing.project_id,
            name,
            description,
            graph_data: existing.graph_data,
            version: new_version,
            group_id: existing.group_id,
            created_at: existing.created_at,
            updated_at: now,
        })
    }

    async fn update_graph(&self, id: &str, input: UpdateGraphData) -> Result<Flow, AppError> {
        // First get existing flow
        let existing = self.get_by_id(id).await?
            .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", id)))?;

        // Check version for optimistic locking
        if existing.version != input.version {
            return Err(AppError::VersionConflict {
                expected: input.version,
                actual: existing.version,
            });
        }

        let now = Utc::now();
        let graph_data_json = serde_json::to_string(&input.graph_data)?;
        let new_version = existing.version + 1;

        sqlx::query(
            r#"UPDATE flows SET
               graph_data = ?, version = ?, updated_at = ?
               WHERE id = ? AND version = ?"#
        )
        .bind(&graph_data_json)
        .bind(new_version)
        .bind(now.to_rfc3339())
        .bind(id)
        .bind(input.version)
        .execute(&self.pool)
        .await?;

        Ok(Flow {
            id: id.to_string(),
            project_id: existing.project_id,
            name: existing.name,
            description: existing.description,
            graph_data: input.graph_data,
            version: new_version,
            group_id: existing.group_id,
            created_at: existing.created_at,
            updated_at: now,
        })
    }

    async fn delete(&self, id: &str) -> Result<(), AppError> {
        let result = sqlx::query("DELETE FROM flows WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Flow {} not found", id)));
        }

        Ok(())
    }

    async fn set_group(&self, id: &str, group_id: Option<&str>) -> Result<Flow, AppError> {
        // No version check and no `updated_at` bump: which bucket a flow sits in is about the
        // sidebar, not the flow. Tying it to the graph's optimistic lock would let a drag fail
        // because somebody else edited the canvas, and would move a flow to the top of a
        // recently-changed list for being tidied.
        let result = sqlx::query("UPDATE flows SET group_id = ? WHERE id = ?")
            .bind(group_id)
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Flow {} not found", id)));
        }

        self.get_by_id(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", id)))
    }

    async fn find_existing_ids(&self, ids: &[String]) -> Result<std::collections::HashSet<String>, AppError> {
        if ids.is_empty() {
            return Ok(std::collections::HashSet::new());
        }

        // Build query with placeholders
        let placeholders: Vec<&str> = ids.iter().map(|_| "?").collect();
        let query = format!(
            "SELECT id FROM flows WHERE id IN ({})",
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

/// Convert a database row to a Flow
fn row_to_flow(row: &sqlx::any::AnyRow) -> Result<Flow, AppError> {
    let graph_data_str: String = row.try_get("graph_data")?;
    let created_str: String = row.try_get("created_at")?;
    let updated_str: String = row.try_get("updated_at")?;

    Ok(Flow {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        graph_data: serde_json::from_str(&graph_data_str)?,
        version: row.try_get("version")?,
        group_id: row.try_get("group_id")?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
    })
}
