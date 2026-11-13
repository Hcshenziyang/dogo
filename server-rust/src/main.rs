use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use dogo_memo_server::{router, AppState};
use rand::{rngs::OsRng, RngCore};

fn private_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn signing_secret(dir: &Path) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if let Ok(value) = env::var("DOGO_RUST_JWT_SECRET") {
        if value.chars().count() < 32 {
            return Err("DOGO_RUST_JWT_SECRET must be at least 32 characters".into());
        }
        return Ok(value);
    }
    let path = dir.join("rust-jwt-secret");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let secret = match options.open(&path) {
        Ok(mut file) => {
            let mut bytes = [0u8; 48];
            OsRng.fill_bytes(&mut bytes);
            let secret = URL_SAFE_NO_PAD.encode(bytes);
            writeln!(file, "{secret}")?;
            file.sync_all()?;
            secret
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            fs::read_to_string(path)?.trim().to_string()
        }
        Err(error) => return Err(error.into()),
    };
    if secret.chars().count() < 32 {
        return Err("Invalid persisted Rust server signing key".into());
    }
    Ok(secret)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let data_dir =
        PathBuf::from(env::var_os("DOGO_RUST_DATA_DIR").unwrap_or_else(|| "data-rust".into()));
    private_directory(&data_dir)?;
    let secret = signing_secret(&data_dir)?;
    let invite = env::var("DOGO_RUST_INVITE_CODE").ok();
    let state = AppState::open(
        &data_dir.join("dogo-memo.sqlite3"),
        &secret,
        invite.as_deref(),
    )
    .await?;
    let address = env::var("DOGO_RUST_LISTEN").unwrap_or_else(|_| "127.0.0.1:8789".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    eprintln!("DogO server listening on {}", listener.local_addr()?);
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
