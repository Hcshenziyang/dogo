use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{auth, error::ApiError, now_millis, ApiJson, AppState};

macro_rules! memo_sql {
    ($prefix:literal, $suffix:literal) => {
        concat!($prefix, "id,account_id,request_id,request_hash,content,project,category,tags,active,created_device_id,revision,created_at,updated_at,deleted_at", $suffix)
    };
}
const MAX_CONTENT: usize = 256_000;
fn active_default() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    request_id: String,
    content: String,
    #[serde(default)]
    project: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "active_default")]
    active: bool,
    #[serde(default)]
    plan: Option<serde_json::Value>,
    #[serde(default)]
    dispatch: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    revision: i64,
    content: String,
    #[serde(default)]
    project: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "active_default")]
    active: bool,
    #[serde(default)]
    plan: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delete {
    revision: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Append {
    revision: i64,
    content: String,
}

#[derive(Deserialize)]
pub struct ListQuery {
    project: Option<String>,
    #[serde(default)]
    cursor: String,
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    include_deleted: bool,
}
fn default_limit() -> i64 {
    100
}

#[derive(Serialize)]
struct Fields {
    content: String,
    project: String,
    category: String,
    tags: Vec<String>,
    active: bool,
}

fn fields(
    content: String,
    project: String,
    category: String,
    tags: Vec<String>,
    active: bool,
) -> Result<Fields, ApiError> {
    let project = project.trim().to_string();
    let tags: Vec<_> = tags.into_iter().map(|tag| tag.trim().to_string()).collect();
    if content.chars().count() > MAX_CONTENT {
        return Err(ApiError::invalid("Memo content is too large"));
    }
    if project.chars().count() > 100
        || category.chars().count() > 100
        || tags.len() > 30
        || tags.iter().any(|t| t.is_empty() || t.chars().count() > 100)
    {
        return Err(ApiError::invalid("Invalid memo fields"));
    }
    Ok(Fields {
        content,
        project,
        category,
        tags,
        active,
    })
}

fn unsupported() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "unsupported_feature",
        "Scheduled plans and device dispatch are not supported by this memo service",
    )
}

#[derive(sqlx::FromRow)]
struct MemoRow {
    id: String,
    account_id: String,
    request_id: String,
    request_hash: String,
    content: String,
    project: String,
    category: String,
    tags: String,
    active: bool,
    created_device_id: String,
    revision: i64,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
}

#[derive(Serialize)]
pub struct MemoView {
    id: String,
    account_id: String,
    request_id: String,
    content: String,
    project: String,
    category: String,
    tags: Vec<String>,
    active: bool,
    created_device_id: String,
    revision: i64,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    dispatch: Option<serde_json::Value>,
}

impl TryFrom<MemoRow> for MemoView {
    type Error = ApiError;
    fn try_from(row: MemoRow) -> Result<Self, Self::Error> {
        Ok(Self {
            id: row.id,
            account_id: row.account_id,
            request_id: row.request_id,
            content: row.content,
            project: row.project,
            category: row.category,
            tags: serde_json::from_str(&row.tags).map_err(|_| ApiError::internal())?,
            active: row.active,
            created_device_id: row.created_device_id,
            revision: row.revision,
            created_at: row.created_at,
            updated_at: row.updated_at,
            deleted_at: row.deleted_at,
            dispatch: None,
        })
    }
}

#[derive(Serialize)]
pub struct MemoPage {
    items: Vec<MemoView>,
    next_cursor: Option<String>,
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "Record not found")
}

async fn get_row(state: &AppState, account_id: &str, id: &str) -> Result<MemoRow, ApiError> {
    sqlx::query_as::<_, MemoRow>(memo_sql!(
        "SELECT ",
        " FROM memos WHERE account_id=? AND id=?"
    ))
    .bind(account_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)
}

async fn update_failure(state: &AppState, account_id: &str, id: &str, revision: i64) -> ApiError {
    match get_row(state, account_id, id).await {
        Err(error) => error,
        Ok(row) if row.deleted_at.is_some() => ApiError::new(
            StatusCode::CONFLICT,
            "memo_deleted",
            "Memo has been deleted",
        ),
        Ok(row) if row.revision != revision => ApiError::new(
            StatusCode::CONFLICT,
            "revision_conflict",
            "Read the latest version before writing",
        ),
        Ok(_) => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "memo_too_large",
            "Combined content exceeds the memo limit",
        ),
    }
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Create>,
) -> Result<(StatusCode, Json<MemoView>), ApiError> {
    let p = auth::principal(&state, &headers).await?;
    if input.plan.is_some() || input.dispatch.is_some() {
        return Err(unsupported());
    }
    if input.request_id.is_empty() || input.request_id.chars().count() > 128 {
        return Err(ApiError::invalid("Invalid request ID"));
    }
    let fields = fields(
        input.content,
        input.project,
        input.category,
        input.tags,
        input.active,
    )?;
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&fields).map_err(|_| ApiError::internal())?,
    ));
    let tags = serde_json::to_string(&fields.tags).map_err(|_| ApiError::internal())?;
    let id = Uuid::new_v4().to_string();
    let now = now_millis();
    sqlx::query("INSERT INTO memos(id,account_id,request_id,request_hash,content,project,category,tags,active,created_device_id,revision,created_at,updated_at) \
         VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(account_id,request_id) DO NOTHING")
        .bind(id).bind(&p.account_id).bind(&input.request_id).bind(&digest)
        .bind(fields.content).bind(fields.project).bind(fields.category).bind(tags).bind(fields.active)
        .bind(p.device_id).bind(now).bind(now).execute(&state.pool).await?;
    let row: MemoRow = sqlx::query_as(memo_sql!(
        "SELECT ",
        " FROM memos WHERE account_id=? AND request_id=?"
    ))
    .bind(&p.account_id)
    .bind(input.request_id)
    .fetch_one(&state.pool)
    .await?;
    if row.request_hash != digest {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "request_id_reused",
            "Request ID has different input",
        ));
    }
    Ok((StatusCode::CREATED, Json(row.try_into()?)))
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<MemoPage>, ApiError> {
    let p = auth::principal(&state, &headers).await?;
    if !(1..=200).contains(&query.limit) || query.cursor.chars().count() > 128 {
        return Err(ApiError::invalid("Invalid pagination"));
    }
    let mut rows: Vec<MemoRow> = sqlx::query_as(memo_sql!("SELECT ", " FROM memos WHERE account_id=? AND id>? AND (? IS NULL OR project=?) AND (? OR deleted_at IS NULL) ORDER BY id LIMIT ?"))
        .bind(p.account_id).bind(query.cursor).bind(&query.project).bind(&query.project)
        .bind(query.include_deleted).bind(query.limit + 1).fetch_all(&state.pool).await?;
    let next_cursor = if rows.len() > query.limit as usize {
        Some(rows[query.limit as usize - 1].id.clone())
    } else {
        None
    };
    rows.truncate(query.limit as usize);
    let items = rows
        .into_iter()
        .map(MemoView::try_from)
        .collect::<Result<_, _>>()?;
    Ok(Json(MemoPage { items, next_cursor }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<MemoView>, ApiError> {
    let p = auth::principal(&state, &headers).await?;
    Ok(Json(get_row(&state, &p.account_id, &id).await?.try_into()?))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Update>,
) -> Result<Json<MemoView>, ApiError> {
    let p = auth::principal(&state, &headers).await?;
    if input.revision < 1 {
        return Err(ApiError::invalid("Invalid revision"));
    }
    if input.plan.is_some() {
        return Err(unsupported());
    }
    let values = fields(
        input.content,
        input.project,
        input.category,
        input.tags,
        input.active,
    )?;
    let tags = serde_json::to_string(&values.tags).map_err(|_| ApiError::internal())?;
    let row: Option<MemoRow> = sqlx::query_as(memo_sql!("UPDATE memos SET content=?,project=?,category=?,tags=?,active=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL RETURNING ", ""))
        .bind(values.content).bind(values.project).bind(values.category).bind(tags).bind(values.active).bind(now_millis())
        .bind(&p.account_id).bind(&id).bind(input.revision).fetch_optional(&state.pool).await?;
    match row {
        Some(row) => Ok(Json(row.try_into()?)),
        None => Err(update_failure(&state, &p.account_id, &id, input.revision).await),
    }
}

pub async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Delete>,
) -> Result<Json<MemoView>, ApiError> {
    let p = auth::principal(&state, &headers).await?;
    if input.revision < 1 {
        return Err(ApiError::invalid("Invalid revision"));
    }
    let now = now_millis();
    let row: Option<MemoRow> = sqlx::query_as(memo_sql!("UPDATE memos SET active=0,revision=revision+1,updated_at=?,deleted_at=? WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL RETURNING ", ""))
        .bind(now).bind(now).bind(&p.account_id).bind(&id).bind(input.revision).fetch_optional(&state.pool).await?;
    match row {
        Some(row) => Ok(Json(row.try_into()?)),
        None => Err(update_failure(&state, &p.account_id, &id, input.revision).await),
    }
}

pub async fn append(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<Append>,
) -> Result<Json<MemoView>, ApiError> {
    let p = auth::principal(&state, &headers).await?;
    if input.revision < 1 || input.content.chars().count() > MAX_CONTENT {
        return Err(ApiError::invalid("Invalid content or revision"));
    }
    let current = get_row(&state, &p.account_id, &id).await?;
    if current.deleted_at.is_some() || current.revision != input.revision {
        return Err(update_failure(&state, &p.account_id, &id, input.revision).await);
    }
    if current.content.chars().count() + input.content.chars().count() > MAX_CONTENT {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "memo_too_large",
            "Combined content exceeds the memo limit",
        ));
    }
    let row: Option<MemoRow> = sqlx::query_as(memo_sql!("UPDATE memos SET content=content || ?,revision=revision+1,updated_at=? WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL RETURNING ", ""))
        .bind(&input.content).bind(now_millis()).bind(&p.account_id).bind(&id).bind(input.revision)
        .fetch_optional(&state.pool).await?;
    match row {
        Some(row) => Ok(Json(row.try_into()?)),
        None => Err(update_failure(&state, &p.account_id, &id, input.revision).await),
    }
}
