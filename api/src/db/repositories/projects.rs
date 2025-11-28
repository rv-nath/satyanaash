//! Project repository implementation using SQLx AnyPool

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{AnyPool, Row};
use uuid::Uuid;

use crate::db::models::*;
use crate::error::AppError;
use super::ProjectRepository;

/// SQLx-based project repository
pub struct SqlxProjectRepository {
    pool: AnyPool,
}

impl SqlxProjectRepository {
    pub fn new(pool: AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ProjectRepository for SqlxProjectRepository {
    async fn create(&self, input: CreateProject) -> Result<Project, AppError> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let settings_json = serde_json::to_string(&input.settings)?;

        sqlx::query(
            r#"INSERT INTO projects (id, name, description, settings, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)"#
        )
        .bind(&id)
        .bind(&input.name)
        .bind(&input.description)
        .bind(&settings_json)
        .bind(now.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;

        Ok(Project {
            id,
            name: input.name,
            description: input.description,
            settings: input.settings,
            created_at: now,
            updated_at: now,
        })
    }

    async fn get_by_id(&self, id: &str) -> Result<Option<Project>, AppError> {
        let row = sqlx::query(
            "SELECT id, name, description, settings, created_at, updated_at FROM projects WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(Some(row_to_project(&row)?)),
            None => Ok(None),
        }
    }

    async fn list(&self, pagination: Pagination) -> Result<PaginatedResponse<Project>, AppError> {
        // Get total count
        let count_row = sqlx::query("SELECT COUNT(*) as count FROM projects")
            .fetch_one(&self.pool)
            .await?;
        let total: i64 = count_row.try_get("count")?;

        // Calculate offset
        let offset = (pagination.page.saturating_sub(1)) * pagination.per_page;

        // Get paginated results
        let rows = sqlx::query(
            "SELECT id, name, description, settings, created_at, updated_at
             FROM projects ORDER BY created_at DESC LIMIT ? OFFSET ?"
        )
        .bind(pagination.per_page as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await?;

        let projects: Result<Vec<Project>, AppError> = rows.iter().map(row_to_project).collect();

        Ok(PaginatedResponse {
            data: projects?,
            pagination: PaginationMeta {
                page: pagination.page,
                per_page: pagination.per_page,
                total: total as u64,
                total_pages: ((total as f64) / (pagination.per_page as f64)).ceil() as u32,
            },
        })
    }

    async fn update(&self, id: &str, input: UpdateProject) -> Result<Project, AppError> {
        // First get existing project
        let existing = self.get_by_id(id).await?
            .ok_or_else(|| AppError::NotFound(format!("Project {} not found", id)))?;

        let now = Utc::now();
        let name = input.name.unwrap_or(existing.name);
        let description = input.description.or(existing.description);
        let settings = input.settings.unwrap_or(existing.settings);
        let settings_json = serde_json::to_string(&settings)?;

        sqlx::query(
            "UPDATE projects SET name = ?, description = ?, settings = ?, updated_at = ? WHERE id = ?"
        )
        .bind(&name)
        .bind(&description)
        .bind(&settings_json)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;

        Ok(Project {
            id: id.to_string(),
            name,
            description,
            settings,
            created_at: existing.created_at,
            updated_at: now,
        })
    }

    async fn delete(&self, id: &str) -> Result<(), AppError> {
        let result = sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Project {} not found", id)));
        }

        Ok(())
    }
}

/// Convert a database row to a Project
fn row_to_project(row: &sqlx::any::AnyRow) -> Result<Project, AppError> {
    let settings_str: String = row.try_get("settings")?;
    let created_str: String = row.try_get("created_at")?;
    let updated_str: String = row.try_get("updated_at")?;

    Ok(Project {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        settings: serde_json::from_str(&settings_str)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .with_timezone(&Utc),
    })
}
