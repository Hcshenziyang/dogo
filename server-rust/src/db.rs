use std::{fs::OpenOptions, path::Path};

use diesel::{sql_types::BigInt, QueryableByName, SqliteConnection};
use diesel_async::{
    pooled_connection::{bb8, AsyncDieselConnectionManager, ManagerConfig},
    sync_connection_wrapper::SyncConnectionWrapper,
    AsyncConnection, RunQueryDsl, SimpleAsyncConnection,
};

const APPLICATION_ID: i64 = 0x444f474f;
type Connection = SyncConnectionWrapper<SqliteConnection>;
pub type Pool = bb8::Pool<Connection>;
type Error = Box<dyn std::error::Error + Send + Sync>;

#[derive(QueryableByName)]
struct Version {
    #[diesel(sql_type = BigInt)]
    user_version: i64,
}

#[derive(QueryableByName)]
struct ApplicationId {
    #[diesel(sql_type = BigInt)]
    application_id: i64,
}

#[derive(QueryableByName)]
struct TableCount {
    #[diesel(sql_type = BigInt)]
    count: i64,
}

pub async fn open(path: &Path) -> Result<Pool, Error> {
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

    let mut config = ManagerConfig::default();
    config.custom_setup = Box::new(|url| {
        Box::pin(async move {
            let mut connection = Connection::establish(url).await?;
            connection
                .batch_execute("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
                .await
                .map_err(|error| diesel::ConnectionError::BadConnection(error.to_string()))?;
            Ok(connection)
        })
    });
    let database_url = path.to_str().ok_or("Database path is not valid UTF-8")?;
    let manager = AsyncDieselConnectionManager::<Connection>::new_with_config(database_url, config);
    let pool = Pool::builder().max_size(4).build(manager).await?;
    let mut connection = pool.get().await?;
    connection
        .transaction::<(), Error, _>(async |connection| {
            let version = diesel::sql_query("PRAGMA user_version")
                .get_result::<Version>(connection)
                .await?
                .user_version;
            let app_id = diesel::sql_query("PRAGMA application_id")
                .get_result::<ApplicationId>(connection)
                .await?
                .application_id;
            if version == 0 && app_id == 0 {
                let count = diesel::sql_query(
                    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                )
                .get_result::<TableCount>(connection)
                .await?
                .count;
                if count != 0 {
                    return Err("Refusing to initialize a nonempty database".into());
                }
                connection.batch_execute(include_str!("initial_schema.sql")).await?;
                connection.batch_execute("PRAGMA application_id = 1146046287; PRAGMA user_version = 2;").await?;
            } else if app_id != APPLICATION_ID || ![1, 2].contains(&version) {
                return Err("Unsupported database; use a separate DogO Rust data directory".into());
            } else if version == 1 {
                // The retired memo table is removed atomically; account and device rows remain.
                connection.batch_execute("DROP TABLE IF EXISTS memos; PRAGMA user_version = 2;").await?;
            }
            Ok(())
        })
        .await?;
    drop(connection);
    Ok(pool)
}
