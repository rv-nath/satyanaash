//! Database pool initialization with Any driver for SQLite/PostgreSQL

use sqlx::any::{install_default_drivers, AnyPoolOptions};
use sqlx::AnyPool;
use tracing::{info, warn};

/// Initialize database pool from URL
/// Supports: sqlite:// and postgres://
pub async fn init_pool(database_url: &str) -> Result<AnyPool, sqlx::Error> {
    // Install drivers for SQLite and PostgreSQL
    install_default_drivers();

    info!("Connecting to database: {}...",
        if database_url.contains("@") { "[redacted]" } else { database_url });

    // For SQLite, add foreign_keys pragma to connection URL
    let connection_url = if database_url.starts_with("sqlite:") && !database_url.contains("?") {
        format!("{}?mode=rwc", database_url)
    } else {
        database_url.to_string()
    };

    let pool = AnyPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                // Set pragmas on each new connection
                sqlx::query("PRAGMA foreign_keys=ON").execute(&mut *conn).await?;
                sqlx::query("PRAGMA journal_mode=WAL").execute(&mut *conn).await?;
                Ok(())
            })
        })
        .connect(&connection_url)
        .await?;

    info!("SQLite pragmas configured via after_connect hook");

    // Run migrations
    run_migrations(&pool).await?;

    info!("Database ready");
    Ok(pool)
}

/// Run all migration files from migrations/ folder
async fn run_migrations(pool: &AnyPool) -> Result<(), sqlx::Error> {
    info!("Running migrations...");

    // Embed migration files at compile time
    let migrations = [
        include_str!("../../migrations/001_projects.sql"),
        include_str!("../../migrations/002_test_cases.sql"),
        include_str!("../../migrations/003_flows.sql"),
        include_str!("../../migrations/004_executions.sql"),
        include_str!("../../migrations/005_merge_canvas_settings.sql"),
        include_str!("../../migrations/006_add_pre_test_script.sql"),
        include_str!("../../migrations/007_test_groups.sql"),
        include_str!("../../migrations/008_dataset.sql"),
        include_str!("../../migrations/009_runs.sql"),
        include_str!("../../migrations/010_body_type.sql"),
        include_str!("../../migrations/011_file_stores.sql"),
        include_str!("../../migrations/012_iterations_of.sql"),
        include_str!("../../migrations/013_flow_groups.sql"),
    ];

    for sql in migrations {
        // Split by semicolon and run each statement
        for statement in sql.split(';') {
            let stmt = statement.trim();
            // Skip empty or comment-only statements
            let first_line = stmt.lines().find(|l| !l.trim().is_empty() && !l.trim().starts_with("--"));
            if let Some(_) = first_line {
                info!("Executing: {}", &stmt[..stmt.len().min(60)]);
                match sqlx::query(stmt).execute(pool).await {
                    Ok(_) => {}
                    Err(e) => {
                        let err_msg = e.to_string();
                        // Ignore "duplicate column" errors from re-running ALTER TABLE migrations
                        if err_msg.contains("duplicate column") {
                            warn!("Skipping (already applied): {}", &stmt[..stmt.len().min(60)]);
                        } else {
                            return Err(e);
                        }
                    }
                }
            }
        }
    }

    info!("Migrations complete");
    Ok(())
}

/// The run-history schema, for tests that need it without the rest of the app's tables.
///
/// Four test modules used to inline `include_str!("…/009_runs.sql")` and split it
/// themselves. Adding a column in a later migration then left the running app and every one
/// of those four disagreeing, and the symptom was "table run_results has no column named …"
/// from a test that never mentions the column. One list, in the same file as the real one,
/// so the two are seen together.
///
/// Deliberately not `run_migrations`: these tests stand up three stub tables to hang the
/// foreign keys on, and creating the real `projects`/`flows`/`test_cases` alongside them
/// would make each test carry schema it has no interest in.
#[cfg(test)]
pub(crate) async fn apply_run_schema(pool: &AnyPool) {
    for sql in [
        include_str!("../../migrations/009_runs.sql"),
        include_str!("../../migrations/012_iterations_of.sql"),
    ] {
        for statement in sql.split(';') {
            let stmt = statement.trim();
            if stmt.lines().any(|l| !l.trim().is_empty() && !l.trim().starts_with("--")) {
                sqlx::query(stmt).execute(pool).await.unwrap_or_else(|e| {
                    panic!("test schema: {} — {}", &stmt[..stmt.len().min(60)], e)
                });
            }
        }
    }
}
