mod auth;
mod db;
mod error;
mod memos;

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHasher, SaltString},
    Argon2,
};
use axum::{
    extract::{DefaultBodyLimit, FromRequest, Request},
    routing::{delete, get, post},
    Json, Router,
};
use error::ApiError;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct AppState {
    pool: SqlitePool,
    jwt_secret: Arc<[u8]>,
    invite_hash: Option<[u8; 32]>,
    dummy_hash: Arc<str>,
}

impl AppState {
    pub async fn open(
        path: &Path,
        jwt_secret: &str,
        invite: Option<&str>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        if jwt_secret.chars().count() < 32 {
            return Err("JWT secret must be at least 32 characters".into());
        }
        let pool = db::open(path).await?;
        let dummy_hash = tokio::task::spawn_blocking(|| {
            Argon2::default()
                .hash_password(
                    b"dogo-invalid-user-password",
                    &SaltString::generate(&mut OsRng),
                )
                .map(|v| v.to_string())
                .map_err(|_| "Unable to initialize password hashing")
        })
        .await??;
        Ok(Self {
            pool,
            jwt_secret: Arc::from(jwt_secret.as_bytes()),
            invite_hash: invite
                .filter(|v| !v.is_empty())
                .map(|v| Sha256::digest(v.as_bytes()).into()),
            dummy_hash: Arc::from(dummy_hash),
        })
    }
}

pub struct ApiJson<T>(pub T);
impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;
    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|_| ApiError::invalid("Invalid JSON request"))
    }
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/refresh", post(auth::refresh))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/me", get(auth::me))
        .route("/api/devices", get(auth::devices))
        .route("/api/devices/{device_id}", delete(auth::revoke_device))
        .route("/api/memos", get(memos::list).post(memos::create))
        .route(
            "/api/memos/{memo_id}",
            get(memos::get).put(memos::update).delete(memos::remove),
        )
        .route("/api/memos/{memo_id}/append", post(memos::append))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(state)
}
