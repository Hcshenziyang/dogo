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
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn device_ownership_and_refresh_rotation_remain_atomic() {
    let (_dir, app) = setup(Some(INVITE)).await;
    register(&app, "alice", INVITE).await;
    register(&app, "bob", INVITE).await;
    let alice = login(&app, "alice", "shared-device").await;
    let bob = request(
        &app,
        Method::POST,
        "/api/auth/login",
        Some(json!({"username":"bob","password":PASSWORD,"device_id":"shared-device","device_name":"B"})),
        None,
    ).await;
    assert_eq!(bob.0, StatusCode::CONFLICT);
    assert_eq!(bob.1["error"]["code"], "device_id_in_use");
    assert_eq!(
        request(&app, Method::GET, "/api/auth/me", None, Some(token(&alice)))
            .await
            .0,
        StatusCode::OK,
    );

    let body = json!({"refresh_token":alice["refresh_token"]});
    let (first, second) = tokio::join!(
        request(
            &app,
            Method::POST,
            "/api/auth/refresh",
            Some(body.clone()),
            None
        ),
        request(&app, Method::POST, "/api/auth/refresh", Some(body), None),
    );
    assert!(matches!(
        (first.0, second.0),
        (StatusCode::OK, StatusCode::UNAUTHORIZED) | (StatusCode::UNAUTHORIZED, StatusCode::OK)
    ));
}

#[tokio::test]
async fn migrates_v1_removing_memos_and_preserving_accounts_and_devices() {
    use argon2::{
        password_hash::{rand_core::OsRng, PasswordHasher, SaltString},
        Argon2,
    };
    use diesel::{connection::SimpleConnection, prelude::*, sql_types::Text};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing.sqlite3");
    let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    conn.batch_execute(include_str!("fixtures/sqlx_v1.sql"))
        .unwrap();
    let hash = Argon2::default()
        .hash_password(PASSWORD.as_bytes(), &SaltString::generate(&mut OsRng))
        .unwrap()
        .to_string();
    diesel::sql_query("INSERT INTO accounts(id,username,password_hash,created_at) VALUES('old-account','legacy-test',?,1)")
        .bind::<Text, _>(hash)
        .execute(&mut conn)
        .unwrap();
    conn.batch_execute(
        "INSERT INTO devices(id,account_id,name,kind,created_at) VALUES('old-device','old-account','Old device','desktop',1);
         INSERT INTO memos(id,account_id,request_id,request_hash,content,created_device_id,created_at,updated_at)
         VALUES('old-memo','old-account','old-request','synthetic-hash','before Diesel','old-device',1,1);",
    ).unwrap();
    drop(conn);

    let app = router(AppState::open(&path, SECRET, Some(INVITE)).await.unwrap());
    let session = login(&app, "legacy-test", "new-device").await;
    let access = token(&session);
    assert_eq!(
        request(&app, Method::GET, "/api/memos/old-memo", None, Some(access))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let devices = request(&app, Method::GET, "/api/devices", None, Some(access)).await;
    assert_eq!(devices.0, StatusCode::OK);
    assert!(devices
        .1
        .as_array()
        .unwrap()
        .iter()
        .any(|device| device["id"] == "old-device"));
    drop(app);
    let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    #[derive(QueryableByName)]
    struct Number {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        value: i64,
    }
    let table = diesel::sql_query(
        "SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table' AND name='memos'",
    )
    .get_result::<Number>(&mut conn)
    .unwrap();
    assert_eq!(table.value, 0);
    let version = diesel::sql_query("SELECT user_version AS value FROM pragma_user_version")
        .get_result::<Number>(&mut conn)
        .unwrap();
    assert_eq!(version.value, 2);
    drop(conn);
    assert!(AppState::open(&path, SECRET, Some(INVITE)).await.is_ok());
}

#[tokio::test]
async fn refuses_an_unrelated_database_without_replacing_its_contents() {
    use diesel::{connection::SimpleConnection, prelude::*, sql_types::Text};
    #[derive(QueryableByName)]
    struct Witness {
        #[diesel(sql_type = Text)]
        value: String,
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unrelated.sqlite3");
    let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    conn.batch_execute("CREATE TABLE witness(value TEXT NOT NULL); INSERT INTO witness(value) VALUES('untouched');")
        .unwrap();
    drop(conn);
    assert!(AppState::open(&path, SECRET, Some(INVITE)).await.is_err());
    let mut conn = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
    let value = diesel::sql_query("SELECT value FROM witness")
        .get_result::<Witness>(&mut conn)
        .unwrap();
    assert_eq!(value.value, "untouched");
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
