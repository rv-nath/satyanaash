//! Database pool initialization with Any driver for SQLite/PostgreSQL

use sqlx::any::{install_default_drivers, AnyPoolOptions};
use sqlx::AnyPool;
use tracing::info;

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
    ];

    for sql in migrations {
        // Split by semicolon and run each statement
        for statement in sql.split(';') {
            let stmt = statement.trim();
            // Skip empty or comment-only statements
            let first_line = stmt.lines().find(|l| !l.trim().is_empty() && !l.trim().starts_with("--"));
            if let Some(_) = first_line {
                info!("Executing: {}", &stmt[..stmt.len().min(60)]);
                sqlx::query(stmt).execute(pool).await?;
            }
        }
    }

    info!("Migrations complete");
    Ok(())
}
