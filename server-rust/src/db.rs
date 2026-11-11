use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    SqlitePool,
};
use std::{fs::OpenOptions, path::Path, str::FromStr, time::Duration};

const APPLICATION_ID: i64 = 0x444f474f;

pub async fn open(path: &Path) -> Result<SqlitePool, Box<dyn std::error::Error + Send + Sync>> {
    let mut create = OpenOptions::new();
    create.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        create.mode(0o600);
    }
    match create.open(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let options = SqliteConnectOptions::from_str("sqlite::memory:")?
        .filename(path)
        .in_memory(false)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    let mut tx = pool.begin().await?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *tx)
        .await?;
    let app_id: i64 = sqlx::query_scalar("PRAGMA application_id")
        .fetch_one(&mut *tx)
        .await?;
    if version == 0 && app_id == 0 {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .fetch_one(&mut *tx)
        .await?;
        if count != 0 {
            return Err("Refusing to initialize a nonempty database".into());
        }
        for statement in SCHEMA.split(';').filter(|s| !s.trim().is_empty()) {
            sqlx::query(statement).execute(&mut *tx).await?;
        }
        sqlx::query("PRAGMA application_id = 1146046287")
            .execute(&mut *tx)
            .await?;
        sqlx::query("PRAGMA user_version = 1")
            .execute(&mut *tx)
            .await?;
    } else if version != 1 || app_id != APPLICATION_ID {
        return Err("Unsupported database; use a separate DogO Rust data directory".into());
    }
    tx.commit().await?;
    Ok(pool)
}

const SCHEMA: &str = r#"
CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('desktop', 'mobile')),
    active INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    refresh_hash TEXT UNIQUE,
    refresh_expires_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX devices_account ON devices(account_id);
CREATE TABLE memos (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_device_id TEXT NOT NULL REFERENCES devices(id),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE(account_id, request_id)
);
CREATE INDEX memos_account ON memos(account_id, id);
"#;
