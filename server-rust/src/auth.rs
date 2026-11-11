use std::sync::Arc;

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{error::ApiError, now_millis, now_seconds, ApiJson, AppState};

const ACCESS_SECONDS: i64 = 900;
const REFRESH_SECONDS: i64 = 30 * 86400;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    username: String,
    password: String,
    invite_code: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    username: String,
    password: String,
    device_id: String,
    device_name: String,
    #[serde(default = "desktop")]
    device_kind: String,
}

fn desktop() -> String {
    "desktop".into()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refresh {
    refresh_token: String,
}

#[derive(Serialize)]
pub struct AccountView {
    id: String,
    username: String,
}

#[derive(Serialize)]
pub struct Tokens {
    access_token: String,
    refresh_token: String,
    device_id: String,
    token_type: &'static str,
    expires_in: i64,
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    did: String,
    ver: i64,
    iat: i64,
    exp: i64,
    iss: String,
    aud: String,
    #[serde(rename = "type")]
    token_type: String,
}

pub struct Principal {
    pub account_id: String,
    pub device_id: String,
    version: i64,
}

fn auth_error(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, code, message)
}

fn normalize_username(username: &str) -> Result<String, ApiError> {
    let name = username.trim().to_lowercase();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::invalid("Invalid username"));
    }
    Ok(name)
}

fn valid_identifier(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max
}

fn random_token() -> String {
    let mut bytes = [0u8; 48];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn token_hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn tokens(
    state: &AppState,
    account_id: String,
    device_id: String,
    version: i64,
    refresh: String,
) -> Result<Tokens, ApiError> {
    let now = now_seconds();
    let claims = Claims {
        sub: account_id,
        did: device_id.clone(),
        ver: version,
        iat: now,
        exp: now + ACCESS_SECONDS,
        iss: "dogo-rust".into(),
        aud: "dogo-rust".into(),
        token_type: "access".into(),
    };
    let access_token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(&state.jwt_secret),
    )
    .map_err(|_| ApiError::internal())?;
    Ok(Tokens {
        access_token,
        refresh_token: refresh,
        device_id,
        token_type: "bearer",
        expires_in: ACCESS_SECONDS,
    })
}

pub async fn register(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<Register>,
) -> Result<(StatusCode, Json<AccountView>), ApiError> {
    let expected = state.invite_hash.ok_or_else(|| {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "registration_disabled",
            "Registration is disabled",
        )
    })?;
    let supplied: [u8; 32] = Sha256::digest(input.invite_code.as_bytes()).into();
    if !bool::from(expected.ct_eq(&supplied)) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "invalid_invite",
            "Invalid invitation code",
        ));
    }
    let username = normalize_username(&input.username)?;
    if !(10..=256).contains(&input.password.chars().count()) {
        return Err(ApiError::invalid(
            "Password must contain 10 to 256 characters",
        ));
    }
    let password = input.password;
    let hashed = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|value| value.to_string())
            .map_err(|_| ApiError::internal())
    })
    .await
    .map_err(|_| ApiError::internal())??;
    let id = Uuid::new_v4().to_string();
    let result = sqlx::query(
        "INSERT INTO accounts(id, username, password_hash, active, created_at) VALUES(?,?,?,1,?)",
    )
    .bind(&id)
    .bind(&username)
    .bind(hashed)
    .bind(now_millis())
    .execute(&state.pool)
    .await;
    if let Err(error) = result {
        if error
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "username_exists",
                "Username already exists",
            ));
        }
        return Err(ApiError::internal());
    }
    Ok((StatusCode::CREATED, Json(AccountView { id, username })))
}

pub async fn login(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<Login>,
) -> Result<Json<Tokens>, ApiError> {
    let username = normalize_username(&input.username)?;
    let device_name = input.device_name.trim().to_string();
    if !valid_identifier(&input.device_id, 128)
        || !valid_identifier(&device_name, 100)
        || !matches!(input.device_kind.as_str(), "desktop" | "mobile")
        || !valid_identifier(&input.password, 256)
    {
        return Err(ApiError::invalid("Invalid login fields"));
    }
    let account: Option<(String, String, bool)> =
        sqlx::query_as("SELECT id, password_hash, active FROM accounts WHERE username=?")
            .bind(username)
            .fetch_optional(&state.pool)
            .await?;
    let hash: Arc<str> = account
        .as_ref()
        .map(|a| Arc::from(a.1.as_str()))
        .unwrap_or_else(|| state.dummy_hash.clone());
    let password = input.password;
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(|_| ApiError::internal())?;
    let (account_id, _, active) =
        account.ok_or_else(|| auth_error("invalid_credentials", "Invalid username or password"))?;
    if !active || !valid {
        return Err(auth_error(
            "invalid_credentials",
            "Invalid username or password",
        ));
    }
    let refresh = random_token();
    let version: Option<(i64,)> = sqlx::query_as(
        "INSERT INTO devices(id,account_id,name,kind,active,token_version,refresh_hash,refresh_expires_at,created_at) \
         VALUES(?,?,?,?,1,1,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,active=1, \
         token_version=devices.token_version+1,refresh_hash=excluded.refresh_hash,refresh_expires_at=excluded.refresh_expires_at \
         WHERE devices.account_id=excluded.account_id RETURNING token_version")
        .bind(&input.device_id).bind(&account_id).bind(device_name).bind(input.device_kind)
        .bind(token_hash(&refresh)).bind(now_seconds() + REFRESH_SECONDS).bind(now_millis())
        .fetch_optional(&state.pool).await?;
    let version = version
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "device_id_in_use",
                "Choose a different device ID",
            )
        })?
        .0;
    Ok(Json(tokens(
        &state,
        account_id,
        input.device_id,
        version,
        refresh,
    )?))
}

pub async fn refresh(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<Refresh>,
) -> Result<Json<Tokens>, ApiError> {
    if !(32..=256).contains(&input.refresh_token.len()) {
        return Err(auth_error(
            "invalid_refresh",
            "Refresh token expired or revoked",
        ));
    }
    let next = random_token();
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "UPDATE devices SET refresh_hash=? WHERE refresh_hash=? AND active=1 AND refresh_expires_at>? \
         AND EXISTS (SELECT 1 FROM accounts WHERE accounts.id=devices.account_id AND accounts.active=1) \
         RETURNING account_id,id,token_version")
        .bind(token_hash(&next)).bind(token_hash(&input.refresh_token)).bind(now_seconds())
        .fetch_optional(&state.pool).await?;
    let (account_id, device_id, version) =
        row.ok_or_else(|| auth_error("invalid_refresh", "Refresh token expired or revoked"))?;
    Ok(Json(tokens(&state, account_id, device_id, version, next)?))
}

pub async fn principal(state: &AppState, headers: &HeaderMap) -> Result<Principal, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let (scheme, token) = value.split_once(' ').unwrap_or(("", ""));
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() || token.len() > 8192 {
        return Err(auth_error(
            "missing_token",
            "Bearer authentication required",
        ));
    }
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.set_issuer(&["dogo-rust"]);
    validation.set_audience(&["dogo-rust"]);
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(&state.jwt_secret),
        &validation,
    )
    .map_err(|_| auth_error("invalid_token", "Invalid or expired access token"))?
    .claims;
    if claims.token_type != "access" {
        return Err(auth_error(
            "invalid_token",
            "Invalid or expired access token",
        ));
    }
    let valid: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM devices d JOIN accounts a ON a.id=d.account_id \
         WHERE d.id=? AND d.account_id=? AND d.token_version=? AND d.active=1 AND a.active=1 AND d.refresh_expires_at>?")
        .bind(&claims.did).bind(&claims.sub).bind(claims.ver).bind(now_seconds()).fetch_optional(&state.pool).await?;
    if valid.is_none() {
        return Err(auth_error(
            "revoked_token",
            "Device login expired or revoked",
        ));
    }
    Ok(Principal {
        account_id: claims.sub,
        device_id: claims.did,
        version: claims.ver,
    })
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let p = principal(&state, &headers).await?;
    sqlx::query("UPDATE devices SET token_version=token_version+1,refresh_hash=NULL,refresh_expires_at=NULL WHERE id=? AND account_id=? AND token_version=?")
        .bind(&p.device_id).bind(&p.account_id).bind(p.version).execute(&state.pool).await?;
    Ok(Json(serde_json::json!({"logged_out":true})))
}

pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AccountView>, ApiError> {
    let p = principal(&state, &headers).await?;
    let (id, username): (String, String) =
        sqlx::query_as("SELECT id,username FROM accounts WHERE id=?")
            .bind(p.account_id)
            .fetch_one(&state.pool)
            .await?;
    Ok(Json(AccountView { id, username }))
}

#[derive(sqlx::FromRow, Serialize)]
pub struct DeviceView {
    id: String,
    account_id: String,
    name: String,
    kind: String,
    active: bool,
    created_at: i64,
}

pub async fn devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<DeviceView>>, ApiError> {
    let p = principal(&state, &headers).await?;
    let result = sqlx::query_as::<_, DeviceView>("SELECT id,account_id,name,kind,active,created_at FROM devices WHERE account_id=? ORDER BY created_at,id")
        .bind(p.account_id).fetch_all(&state.pool).await?;
    Ok(Json(result))
}

pub async fn revoke_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let p = principal(&state, &headers).await?;
    let updated = sqlx::query("UPDATE devices SET active=0,token_version=token_version+1,refresh_hash=NULL,refresh_expires_at=NULL WHERE id=? AND account_id=?")
        .bind(device_id).bind(p.account_id).execute(&state.pool).await?;
    if updated.rows_affected() == 0 {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Record not found",
        ));
    }
    Ok(Json(serde_json::json!({"revoked":true})))
}
