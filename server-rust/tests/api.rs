use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    Router,
};
use dogo_memo_server::{router, AppState};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

const SECRET: &str = "synthetic-test-secret-at-least-32-characters";
const INVITE: &str = "synthetic-invitation";
const PASSWORD: &str = "synthetic-password";

async fn setup(invite: Option<&str>) -> (TempDir, Router) {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::open(&dir.path().join("memo.sqlite3"), SECRET, invite)
        .await
        .unwrap();
    (dir, router(state))
}

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    let response = app
        .clone()
        .oneshot(
            req.body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, json)
}

async fn register(app: &Router, username: &str, invite: &str) -> (StatusCode, Value) {
    request(
        app,
        Method::POST,
        "/api/auth/register",
        Some(json!({"username":username,"password":PASSWORD,"invite_code":invite})),
        None,
    )
    .await
}

async fn login(app: &Router, username: &str, device: &str) -> Value {
    let (status, value) = request(app, Method::POST, "/api/auth/login", Some(json!({
        "username":username,"password":PASSWORD,"device_id":device,"device_name":"Test device","device_kind":"desktop"
    })), None).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

fn token(value: &Value) -> &str {
    value["access_token"].as_str().unwrap()
}

#[tokio::test]
async fn invitation_registration_refresh_and_revocation() {
    let (_disabled_dir, disabled) = setup(None).await;
    assert_eq!(
        register(&disabled, "alice", INVITE).await.0,
        StatusCode::FORBIDDEN
    );
    let (_dir, app) = setup(Some(INVITE)).await;
    assert_eq!(
        register(&app, "alice", "wrong").await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(register(&app, "Alice", INVITE).await.0, StatusCode::CREATED);
    assert_eq!(
        register(&app, "alice", INVITE).await.0,
        StatusCode::CONFLICT
    );
    let invalid = request(
        &app,
        Method::POST,
        "/api/auth/login",
        Some(json!({"username":"alice","password":"wrong","device_id":"a","device_name":"A"})),
        None,
    )
    .await;
    assert_eq!(invalid.0, StatusCode::UNAUTHORIZED);
    let first = login(&app, "ALICE", "device-a").await;
    let second = login(&app, "alice", "device-b").await;
    let (status, profile) =
        request(&app, Method::GET, "/api/auth/me", None, Some(token(&first))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(profile["username"], "alice");
    let original_refresh = first["refresh_token"].as_str().unwrap();
    let (status, renewed) = request(
        &app,
        Method::POST,
        "/api/auth/refresh",
        Some(json!({"refresh_token":original_refresh})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/auth/refresh",
            Some(json!({"refresh_token":original_refresh})),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/auth/logout",
            None,
            Some(token(&renewed))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/auth/me",
            None,
            Some(token(&renewed))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/auth/me",
            None,
            Some(token(&second))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, Method::GET, "/api/memos", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn memo_sync_preserves_versions_tombstones_and_account_boundaries() {
    let (_dir, app) = setup(Some(INVITE)).await;
    assert_eq!(register(&app, "alice", INVITE).await.0, StatusCode::CREATED);
    assert_eq!(register(&app, "bob", INVITE).await.0, StatusCode::CREATED);
    let a = login(&app, "alice", "device-a").await;
    let b = login(&app, "alice", "device-b").await;
    let other = login(&app, "bob", "device-c").await;
    let create = json!({"request_id":"request-1","content":"第一条","project":"工作","category":"原分类","tags":["a,b"],"active":true});
    let (status, saved) = request(
        &app,
        Method::POST,
        "/api/memos",
        Some(create.clone()),
        Some(token(&a)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = saved["id"].as_str().unwrap();
    let path = format!("/api/memos/{id}");
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/memos",
            Some(create.clone()),
            Some(token(&a))
        )
        .await
        .1["id"],
        id
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/memos",
            Some(json!({"request_id":"request-1","content":"other"})),
            Some(token(&a))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(&app, Method::GET, &path, None, Some(token(&other)))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, Method::GET, &path, None, Some(token(&b)))
            .await
            .1["tags"],
        json!(["a,b"])
    );
    let update = json!({"revision":1,"content":"第二条","project":"工作","category":"原分类","tags":["a,b"],"active":true});
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &path,
            Some(update.clone()),
            Some(token(&b))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, Method::PUT, &path, Some(update), Some(token(&a)))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let append_path = format!("{path}/append");
    let append = json!({"revision":2,"content":"\n追加"});
    assert_eq!(
        request(
            &app,
            Method::POST,
            &append_path,
            Some(append.clone()),
            Some(token(&a))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &append_path,
            Some(append),
            Some(token(&a))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &path,
            Some(json!({"revision":3})),
            Some(token(&b))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        request(&app, Method::GET, "/api/memos", None, Some(token(&a)))
            .await
            .1["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let deleted = request(
        &app,
        Method::GET,
        "/api/memos?include_deleted=true",
        None,
        Some(token(&a)),
    )
    .await
    .1;
    assert_eq!(deleted["items"][0]["content"], "第二条\n追加");
    assert!(!deleted["items"][0]["deleted_at"].is_null());
    assert_eq!(
        request(&app, Method::GET, "/api/memos", None, Some(token(&other)))
            .await
            .1["items"],
        json!([])
    );
}

#[tokio::test]
async fn concurrent_create_and_update_do_not_duplicate_or_overwrite() {
    let (_dir, app) = setup(Some(INVITE)).await;
    register(&app, "alice", INVITE).await;
    let login = login(&app, "alice", "device-a").await;
    let access = token(&login);
    let input = json!({"request_id":"concurrent","content":"original"});
    let (a, b) = tokio::join!(
        request(
            &app,
            Method::POST,
            "/api/memos",
            Some(input.clone()),
            Some(access)
        ),
        request(&app, Method::POST, "/api/memos", Some(input), Some(access))
    );
    assert_eq!(a.0, StatusCode::CREATED);
    assert_eq!(b.0, StatusCode::CREATED);
    assert_eq!(a.1["id"], b.1["id"]);
    let path = format!("/api/memos/{}", a.1["id"].as_str().unwrap());
    let (a, b) = tokio::join!(
        request(
            &app,
            Method::PUT,
            &path,
            Some(json!({"revision":1,"content":"first"})),
            Some(access)
        ),
        request(
            &app,
            Method::PUT,
            &path,
            Some(json!({"revision":1,"content":"second"})),
            Some(access)
        )
    );
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
}

#[tokio::test]
async fn restart_persists_data_and_unsupported_work_is_not_silently_accepted() {
    let (dir, app) = setup(Some(INVITE)).await;
    register(&app, "alice", INVITE).await;
    let login = login(&app, "alice", "device-a").await;
    let access = token(&login);
    let denied = request(&app, Method::POST, "/api/memos", Some(json!({"request_id":"bad","content":"x","dispatch":{"instruction":"run","target_device_id":"other"}})), Some(access)).await;
    assert_eq!(denied.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(denied.1["error"]["code"], "unsupported_feature");
    let created = request(
        &app,
        Method::POST,
        "/api/memos",
        Some(json!({"request_id":"ok","content":"persisted"})),
        Some(access),
    )
    .await
    .1;
    drop(app);
    let state = AppState::open(&dir.path().join("memo.sqlite3"), SECRET, Some(INVITE))
        .await
        .unwrap();
    let restarted = router(state);
    let path = format!("/api/memos/{}", created["id"].as_str().unwrap());
    assert_eq!(
        request(&restarted, Method::GET, &path, None, Some(access))
            .await
            .1["content"],
        "persisted"
    );
}

#[tokio::test]
async fn refuses_an_unrelated_database_without_replacing_its_contents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unrelated.sqlite3");
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
    sqlx::query("CREATE TABLE witness(value TEXT NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO witness(value) VALUES('untouched')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    assert!(AppState::open(&path, SECRET, Some(INVITE)).await.is_err());
    let pool =
        sqlx::SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
    let value: String = sqlx::query_scalar("SELECT value FROM witness")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(value, "untouched");
}

#[cfg(unix)]
#[tokio::test]
async fn creates_a_private_database_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private.sqlite3");
    let _state = AppState::open(&path, SECRET, Some(INVITE)).await.unwrap();
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
