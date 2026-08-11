//! Application configuration

use std::env;

/// Application configuration loaded from environment variables
#[derive(Debug, Clone)]
pub struct Config {
    /// Database URL (supports sqlite:// and postgres://)
    pub database_url: String,

    /// Server host
    pub host: String,

    /// Server port
    pub port: u16,

    /// Log level (trace, debug, info, warn, error)
    pub log_level: String,

    /// Port for the callback receiver.
    ///
    /// Its own listener, bound `0.0.0.0` whatever `BIND_HOST` says, because the sender is in a
    /// cluster and cannot reach loopback. Only *recording* is on it — reading stays on the main
    /// API, which is why the main API can go on staying local.
    pub hook_port: u16,
}

impl Config {
    /// Load configuration from environment variables with defaults
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "sqlite:satyanaash.db?mode=rwc".to_string()),

            host: env::var("BIND_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),

            port: env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(3001),

            log_level: env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),

            hook_port: env::var("HOOK_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(3002),
        }
    }
}
