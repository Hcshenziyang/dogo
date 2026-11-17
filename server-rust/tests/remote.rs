use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    Router,
};
use dogo_memo_server::{router, AppState};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use tower::ServiceExt;

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
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn register(app: &Router, name: &str) {
    assert_eq!(
        request(
            app,
            Method::POST,
            "/api/auth/register",
            Some(
                json!({"username":name,"password":"synthetic-password","invite_code":"test-invite"})
            ),
            None
        )
        .await
        .0,
        StatusCode::CREATED
    );
}
async fn login(app: &Router, name: &str, device: &str, kind: &str) -> String {
    let (status, value) = request(app, Method::POST, "/api/auth/login", Some(json!({"username":name,"password":"synthetic-password","device_id":device,"device_name":device,"device_kind":kind})), None).await;
    assert_eq!(status, StatusCode::OK);
    value["access_token"].as_str().unwrap().to_owned()
}
fn ws_request(url: &str, token: &str) -> tokio_tungstenite::tungstenite::http::Request<()> {
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    request
}

#[tokio::test]
async fn forwards_existing_session_and_rejects_other_accounts_and_revoked_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::open(
        &dir.path().join("test.sqlite"),
        "synthetic-secret-with-at-least-32-characters",
        Some("test-invite"),
    )
    .await
    .unwrap();
    let app = router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/api/device/connect", listener.local_addr().unwrap());
    let server_app = app.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, server_app).await.unwrap();
    });
    register(&app, "alice").await;
    register(&app, "bob").await;
    let desktop = login(&app, "alice", "desktop-a", "desktop").await;
    let phone = login(&app, "alice", "phone-a", "mobile").await;
    let stranger = login(&app, "bob", "phone-b", "mobile").await;
    assert!(connect_async(ws_request(&url, &phone)).await.is_err());
    let (mut socket, _) = connect_async(ws_request(&url, &desktop)).await.unwrap();
    let connected: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(connected["device_id"], "desktop-a");
    assert!(connect_async(ws_request(&url, &desktop)).await.is_err());
    let (_, devices) = request(&app, Method::GET, "/api/devices", None, Some(&phone)).await;
    assert!(devices
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["id"] == "desktop-a" && d["online"] == true));
    let call = json!({"device_id":"desktop-a","method":"prompt","args":{"sessionId":"existing-session","requestId":"stable-request","text":"run the test"}});
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/remote/call",
            Some(call.clone()),
            Some(&stranger)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let app_clone = app.clone();
    let phone_clone = phone.clone();
    let task = tokio::spawn(async move {
        request(
            &app_clone,
            Method::POST,
            "/api/remote/call",
            Some(call),
            Some(&phone_clone),
        )
        .await
    });
    let frame: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(frame["call"]["args"]["requestId"], "stable-request");
    assert_eq!(frame["call"]["args"]["sessionId"], "existing-session");
    socket
        .send(Message::Text(
            json!({"type":"remote.result","id":frame["id"],"ok":true,"value":{"accepted":true}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let (status, result) = task.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["value"]["accepted"], true);
    let approval = json!({"device_id":"desktop-a","method":"respondApproval","args":{"sessionId":"existing-session","approvalId":"approval-1","decision":"allowed-once"}});
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/remote/call",
            Some(approval.clone()),
            Some(&stranger)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let app_clone = app.clone();
    let phone_clone = phone.clone();
    let task = tokio::spawn(async move {
        request(
            &app_clone,
            Method::POST,
            "/api/remote/call",
            Some(approval),
            Some(&phone_clone),
        )
        .await
    });
    let frame: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(frame["call"]["method"], "respondApproval");
    assert_eq!(frame["call"]["args"]["approvalId"], "approval-1");
    assert_eq!(frame["call"]["args"]["decision"], "allowed-once");
    socket.send(Message::Text(json!({"type":"remote.result","id":frame["id"],"ok":true,"value":{"status":"resolved","outcome":"allowed-once"}}).to_string().into())).await.unwrap();
    let (status, result) = task.await.unwrap();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["value"]["outcome"], "allowed-once");
    let app_clone = app.clone();
    let phone_clone = phone.clone();
    let task = tokio::spawn(async move {
        request(
            &app_clone,
            Method::POST,
            "/api/remote/call",
            Some(json!({"device_id":"desktop-a","method":"list","args":{}})),
            Some(&phone_clone),
        )
        .await
    });
    let pending: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            "/api/devices/desktop-a",
            None,
            Some(&phone)
        )
        .await
        .0,
        StatusCode::OK
    );
    socket
        .send(Message::Text(
            json!({"type":"remote.result","id":pending["id"],"ok":true,"value":{}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let (status, error) = task.await.unwrap();
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "host_disconnected");
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/remote/call",
            Some(json!({"device_id":"desktop-a","method":"list"})),
            Some(&phone)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    server.abort();
}
