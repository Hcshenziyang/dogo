//! In-memory, bounded relay. Conversation data remains on the desktop.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::{auth, error::ApiError, schema::devices, ApiJson, AppState};

type Key = (String, String);
type Answer = Result<Value, &'static str>;

struct Host {
    generation: String,
    sender: mpsc::Sender<Value>,
}
struct Pending {
    target: Key,
    sender: oneshot::Sender<Answer>,
}
#[derive(Default)]
struct Registry {
    hosts: HashMap<Key, Host>,
    pending: HashMap<String, Pending>,
}
#[derive(Default)]
pub struct Relay {
    registry: Mutex<Registry>,
}

impl Relay {
    pub fn is_online(&self, account: &str, device: &str) -> bool {
        self.registry
            .lock()
            .unwrap()
            .hosts
            .contains_key(&(account.into(), device.into()))
    }
    fn attach(self: &Arc<Self>, key: Key) -> Result<(HostGuard, mpsc::Receiver<Value>), ApiError> {
        let mut registry = self.registry.lock().unwrap();
        if registry.hosts.contains_key(&key) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "device_connected",
                "Device already connected",
            ));
        }
        let generation = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel(16);
        registry.hosts.insert(
            key.clone(),
            Host {
                generation: generation.clone(),
                sender,
            },
        );
        Ok((
            HostGuard {
                relay: self.clone(),
                key,
                generation,
            },
            receiver,
        ))
    }
    async fn forward(
        self: &Arc<Self>,
        key: Key,
        method: String,
        args: Value,
    ) -> Result<Value, ApiError> {
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut registry = self.registry.lock().unwrap();
            let host = registry
                .hosts
                .get(&key)
                .ok_or_else(|| relay_error("host_offline"))?;
            let channel = host.sender.clone();
            if registry.pending.len() >= 128
                || registry
                    .pending
                    .values()
                    .filter(|p| p.target == key)
                    .count()
                    >= 16
            {
                return Err(relay_error("remote_busy"));
            }
            registry.pending.insert(
                id.clone(),
                Pending {
                    target: key,
                    sender,
                },
            );
            if channel
                .try_send(
                    json!({"type":"remote.call", "id":id, "call":{"method":method,"args":args}}),
                )
                .is_err()
            {
                registry.pending.remove(&id);
                return Err(relay_error("remote_busy"));
            }
        }
        let _pending = PendingGuard {
            relay: self.clone(),
            id,
        };
        match tokio::time::timeout(Duration::from_secs(12), receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(code))) => Err(relay_error(code)),
            Ok(Err(_)) => Err(relay_error("host_disconnected")),
            Err(_) => Err(relay_error("remote_timeout")),
        }
    }
    fn resolve(&self, key: &Key, id: &str, answer: Answer) -> Result<(), ApiError> {
        let mut registry = self.registry.lock().unwrap();
        if let Some(pending) = registry.pending.get(id) {
            if &pending.target != key {
                return Err(relay_error("wrong_remote_peer"));
            }
        }
        if let Some(pending) = registry.pending.remove(id) {
            let _ = pending.sender.send(answer);
        }
        Ok(())
    }
}

struct PendingGuard {
    relay: Arc<Relay>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.relay.registry.lock().unwrap().pending.remove(&self.id);
    }
}
struct HostGuard {
    relay: Arc<Relay>,
    key: Key,
    generation: String,
}
impl Drop for HostGuard {
    fn drop(&mut self) {
        let mut registry = self.relay.registry.lock().unwrap();
        if registry
            .hosts
            .get(&self.key)
            .is_some_and(|h| h.generation == self.generation)
        {
            registry.hosts.remove(&self.key);
            let ids: Vec<_> = registry
                .pending
                .iter()
                .filter(|(_, p)| p.target == self.key)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(pending) = registry.pending.remove(&id) {
                    let _ = pending.sender.send(Err("host_disconnected"));
                }
            }
        }
    }
}
fn relay_error(code: &'static str) -> ApiError {
    let (status, message) = match code {
        "host_offline" => (StatusCode::CONFLICT, "Target device is offline"),
        "host_disconnected" => (
            StatusCode::CONFLICT,
            "Host disconnected; result may be unknown",
        ),
        "remote_busy" => (StatusCode::TOO_MANY_REQUESTS, "Too many remote calls"),
        "remote_timeout" => (
            StatusCode::GATEWAY_TIMEOUT,
            "Result unknown; retry with the same request ID",
        ),
        "wrong_remote_peer" => (StatusCode::FORBIDDEN, "Response belongs to another device"),
        _ => (
            StatusCode::CONFLICT,
            "Desktop could not complete the request",
        ),
    };
    ApiError::new(status, code, message)
}

async fn require_desktop(state: &AppState, account: &str, device: &str) -> Result<(), ApiError> {
    let mut conn = state.pool.get().await.map_err(|_| ApiError::internal())?;
    let found: Option<String> = devices::table
        .filter(devices::account_id.eq(account))
        .filter(devices::id.eq(device))
        .filter(devices::active.eq(true))
        .filter(devices::kind.eq("desktop"))
        .select(devices::id)
        .first(&mut conn)
        .await
        .optional()?;
    found.ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Target device not found",
        )
    })?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteCall {
    device_id: String,
    method: String,
    #[serde(default = "empty_object")]
    args: Value,
}
fn empty_object() -> Value {
    json!({})
}
pub async fn call(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<RemoteCall>,
) -> Result<Json<Value>, ApiError> {
    let principal = auth::principal(&state, &headers).await?;
    if input.device_id.is_empty()
        || input.device_id.chars().count() > 128
        || !input.args.is_object()
        || !matches!(
            input.method.as_str(),
            "list"
                | "snapshot"
                | "create"
                | "prompt"
                | "cancel"
                | "workspaces"
                | "models"
                | "selectModel"
                | "respondApproval"
        )
    {
        return Err(ApiError::invalid("Invalid remote call"));
    }
    if serde_json::to_vec(&input.args)
        .map_err(|_| ApiError::internal())?
        .len()
        > 1024 * 1024
    {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "remote_too_large",
            "Remote request too large",
        ));
    }
    require_desktop(&state, &principal.account_id, &input.device_id).await?;
    let value = state
        .relay
        .forward(
            (principal.account_id, input.device_id),
            input.method,
            input.args,
        )
        .await?;
    auth::principal(&state, &headers).await?;
    Ok(Json(json!({"value":value})))
}

pub async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin = origin
            .to_str()
            .map_err(|_| ApiError::invalid("Invalid origin"))?;
        let authority = origin
            .strip_prefix("https://")
            .or_else(|| origin.strip_prefix("http://"));
        if authority != headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "invalid_origin",
                "Origin is not permitted",
            ));
        }
    }
    let principal = auth::principal(&state, &headers).await?;
    require_desktop(&state, &principal.account_id, &principal.device_id).await?;
    let key = (principal.account_id, principal.device_id);
    let (guard, receiver) = state.relay.attach(key.clone())?;
    Ok(upgrade
        .max_message_size(2 * 1024 * 1024)
        .max_frame_size(2 * 1024 * 1024)
        .on_upgrade(move |socket| serve(socket, state, headers, key, guard, receiver)))
}

async fn send(socket: &mut WebSocket, value: Value) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(value.to_string().into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn serve(
    mut socket: WebSocket,
    state: AppState,
    headers: HeaderMap,
    key: Key,
    _guard: HostGuard,
    mut receiver: mpsc::Receiver<Value>,
) {
    if !send(&mut socket, json!({"type":"connected","device_id":key.1})).await {
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.tick().await;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if auth::principal(&state, &headers).await.is_err() {
                    let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame { code: 4401, reason: "Session expired".into() }))).await;
                    break;
                }
                if !send(&mut socket, json!({"type":"ping"})).await { break; }
            }
            outbound = receiver.recv() => {
                let Some(frame) = outbound else { break; };
                let id = frame["id"].as_str().unwrap_or("");
                let pending = state.relay.registry.lock().unwrap().pending.contains_key(id);
                if pending && !send(&mut socket, frame).await { break; }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break; };
                if matches!(message, Message::Close(_)) { break; }
                let Message::Text(text) = message else { continue; };
                if auth::principal(&state, &headers).await.is_err() { break; }
                let Ok(value) = serde_json::from_str::<Value>(&text) else { break; };
                match value.get("type").and_then(Value::as_str) {
                    Some("ping") => { if !send(&mut socket, json!({"type":"pong"})).await { break; } },
                    Some("pong") => (),
                    Some("remote.result") => {
                        let (Some(id), Some(ok)) = (value.get("id").and_then(Value::as_str), value.get("ok").and_then(Value::as_bool)) else { break; };
                        if id.is_empty() || id.len() > 128 { break; }
                        let answer = if ok { Ok(value.get("value").cloned().unwrap_or(Value::Null)) } else { Err("native_error") };
                        if state.relay.resolve(&key, id, answer).is_err() { break; }
                    },
                    _ => { if !send(&mut socket, json!({"type":"error","code":"invalid_message"})).await { break; } }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_calls_release_capacity_and_foreign_peers_cannot_answer() {
        let relay = Arc::new(Relay::default());
        let key = ("account".to_string(), "desktop".to_string());
        let (host, mut receiver) = relay.attach(key.clone()).unwrap();
        let mut tasks = Vec::new();
        let mut first_id = String::new();
        for _ in 0..16 {
            let relay = relay.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                relay.forward(key, "list".into(), json!({})).await
            }));
            let frame = receiver.recv().await.unwrap();
            if first_id.is_empty() {
                first_id = frame["id"].as_str().unwrap().to_string();
            }
        }
        let error = relay
            .forward(key.clone(), "list".into(), json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "remote_busy");
        let error = relay
            .resolve(
                &("other".into(), "desktop".into()),
                &first_id,
                Ok(json!({})),
            )
            .unwrap_err();
        assert_eq!(error.code, "wrong_remote_peer");
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        assert!(relay.registry.lock().unwrap().pending.is_empty());
        drop(host);
        assert!(!relay.is_online("account", "desktop"));
    }

    #[tokio::test]
    async fn disconnect_fails_waiting_calls_with_an_unknown_result() {
        let relay = Arc::new(Relay::default());
        let key = ("account".to_string(), "desktop".to_string());
        let (host, mut receiver) = relay.attach(key.clone()).unwrap();
        let task = tokio::spawn({
            let relay = relay.clone();
            async move {
                relay
                    .forward(key, "prompt".into(), json!({"requestId":"stable"}))
                    .await
            }
        });
        receiver.recv().await.unwrap();
        drop(host);
        assert_eq!(task.await.unwrap().unwrap_err().code, "host_disconnected");
    }
}
