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
use diesel::{prelude::*, result::DatabaseErrorKind, upsert::excluded};
use diesel_async::RunQueryDsl;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{
    error::ApiError,
    now_millis, now_seconds,
    schema::{accounts, devices},
    ApiJson, AppState,
};

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
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let result = diesel::insert_into(accounts::table)
        .values((
            accounts::id.eq(&id),
            accounts::username.eq(&username),
            accounts::password_hash.eq(hashed),
            accounts::active.eq(true),
            accounts::created_at.eq(now_millis()),
        ))
        .execute(&mut conn)
        .await;
    if let Err(error) = result {
        if matches!(
            error,
            diesel::result::Error::DatabaseError(DatabaseErrorKind::UniqueViolation, _)
        ) {
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
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let account: Option<(String, String, bool)> = accounts::table
        .filter(accounts::username.eq(username))
        .select((accounts::id, accounts::password_hash, accounts::active))
        .first(&mut conn)
        .await
        .optional()?;
    drop(conn);
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
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let upsert = diesel::insert_into(devices::table)
        .values((
            devices::id.eq(&input.device_id),
            devices::account_id.eq(&account_id),
            devices::name.eq(device_name),
            devices::kind.eq(input.device_kind),
            devices::active.eq(true),
            devices::token_version.eq(1_i64),
            devices::refresh_hash.eq(Some(token_hash(&refresh))),
            devices::refresh_expires_at.eq(Some(now_seconds() + REFRESH_SECONDS)),
            devices::created_at.eq(now_millis()),
        ))
        .on_conflict(devices::id)
        .do_update()
        .set((
            devices::name.eq(excluded(devices::name)),
            devices::kind.eq(excluded(devices::kind)),
            devices::active.eq(true),
            devices::token_version.eq(devices::token_version + 1_i64),
            devices::refresh_hash.eq(excluded(devices::refresh_hash)),
            devices::refresh_expires_at.eq(excluded(devices::refresh_expires_at)),
        ));
    let version: Option<i64> = {
        use diesel::query_dsl::methods::FilterDsl;
        upsert
            .filter(devices::account_id.eq(excluded(devices::account_id)))
            .returning(devices::token_version)
            .get_result(&mut conn)
            .await
            .optional()?
    };
    let version = version.ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "device_id_in_use",
            "Choose a different device ID",
        )
    })?;
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
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let active_accounts = accounts::table
        .filter(accounts::active.eq(true))
        .select(accounts::id);
    let row: Option<(String, String, i64)> = diesel::update(
        devices::table
            .filter(devices::refresh_hash.eq(Some(token_hash(&input.refresh_token))))
            .filter(devices::active.eq(true))
            .filter(devices::refresh_expires_at.gt(Some(now_seconds())))
            .filter(devices::account_id.eq_any(active_accounts)),
    )
    .set(devices::refresh_hash.eq(Some(token_hash(&next))))
    .returning((devices::account_id, devices::id, devices::token_version))
    .get_result(&mut conn)
    .await
    .optional()?;
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
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let valid: Option<String> = devices::table
        .inner_join(accounts::table)
        .filter(devices::id.eq(&claims.did))
        .filter(devices::account_id.eq(&claims.sub))
        .filter(devices::token_version.eq(claims.ver))
        .filter(devices::active.eq(true))
        .filter(accounts::active.eq(true))
        .filter(devices::refresh_expires_at.gt(Some(now_seconds())))
        .select(devices::id)
        .first(&mut conn)
        .await
        .optional()?;
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
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    diesel::update(
        devices::table
            .filter(devices::id.eq(&p.device_id))
            .filter(devices::account_id.eq(&p.account_id))
            .filter(devices::token_version.eq(p.version)),
    )
    .set((
        devices::token_version.eq(devices::token_version + 1_i64),
        devices::refresh_hash.eq(None::<String>),
        devices::refresh_expires_at.eq(None::<i64>),
    ))
    .execute(&mut conn)
    .await?;
    Ok(Json(serde_json::json!({"logged_out":true})))
}

pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AccountView>, ApiError> {
    let p = principal(&state, &headers).await?;
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let (id, username): (String, String) = accounts::table
        .filter(accounts::id.eq(p.account_id))
        .select((accounts::id, accounts::username))
        .first(&mut conn)
        .await?;
    Ok(Json(AccountView { id, username }))
}

#[derive(Queryable, Selectable, Serialize)]
#[diesel(table_name = devices)]
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
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let result = devices::table
        .filter(devices::account_id.eq(p.account_id))
        .order((devices::created_at, devices::id))
        .select(DeviceView::as_select())
        .load(&mut conn)
        .await?;
    Ok(Json(result))
}

pub async fn revoke_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let p = principal(&state, &headers).await?;
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let updated = diesel::update(
        devices::table
            .filter(devices::id.eq(device_id))
            .filter(devices::account_id.eq(p.account_id)),
    )
    .set((
        devices::active.eq(false),
        devices::token_version.eq(devices::token_version + 1_i64),
        devices::refresh_hash.eq(None::<String>),
        devices::refresh_expires_at.eq(None::<i64>),
    ))
    .execute(&mut conn)
    .await?;
    if updated == 0 {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Record not found",
        ));
    }
    Ok(Json(serde_json::json!({"revoked":true})))
}
