import jwt
import pytest
from conftest import device, login
from starlette.websockets import WebSocketDisconnect


def test_rest_and_mcp_require_authentication(client):
    assert client.get("/api/memos").status_code == 401
    assert client.post("/api/memos", json={}).status_code == 401
    assert client.post("/mcp/", json={}).status_code == 401
    assert client.get("/health").status_code == 200
    assert (
        client.post(
            "/api/auth/login",
            json={
                "username": "alice",
                "password": "incorrect",
                "device_id": "invalid-password-device",
                "device_name": "Test",
            },
        ).status_code
        == 401
    )


@pytest.mark.parametrize("change", [{"exp": 1}, {"aud": "another-service"}, {"iss": "other"}])
def test_invalid_jwt_claims_are_rejected(client, settings, change):
    token = login(client)["access_token"]
    payload = jwt.decode(token, options={"verify_signature": False})
    payload.update(change)
    forged = jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
    assert (
        client.get("/api/memos", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
    )


def test_refresh_rotation_and_logout_affect_only_current_device(client):
    original = login(client)
    renewed = client.post("/api/auth/refresh", json={"refresh_token": original["refresh_token"]})
    assert renewed.status_code == 200
    assert (
        client.post(
            "/api/auth/refresh", json={"refresh_token": original["refresh_token"]}
        ).status_code
        == 401
    )
    new_tokens = renewed.json()
    headers = {"Authorization": "Bearer " + new_tokens["access_token"]}
    _, device_headers = device(client, headers)
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert client.get("/api/auth/me", headers=device_headers).status_code == 200
    assert (
        client.post(
            "/api/auth/refresh", json={"refresh_token": new_tokens["refresh_token"]}
        ).status_code
        == 401
    )


def test_device_revocation_and_credentials_are_not_exposed(client, headers):
    first, bound = device(client, headers)
    rows = client.get("/api/devices", headers=headers).json()
    assert all(
        not ({"refresh_hash", "refresh_expires_at", "token_version"} & row.keys()) for row in rows
    )
    assert client.delete(f"/api/devices/{first['id']}", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=bound).status_code == 401


def test_device_id_cannot_be_reassigned_to_another_account(client, headers):
    row, _ = device(client, headers)
    bob = {"Authorization": "Bearer " + login(client, "bob")["access_token"]}
    assert client.delete(f"/api/devices/{row['id']}", headers=bob).status_code == 404
    assert (
        client.post(
            "/api/auth/login",
            json={
                "username": "bob",
                "password": "bob-test-password",
                "device_id": row["id"],
                "device_name": "Impersonated",
            },
        ).status_code
        == 409
    )


def test_relogin_replaces_only_that_devices_credentials(client):
    original = login(client, device_id="same-phone")
    other = login(client)
    replacement = login(client, device_id="same-phone")
    assert (
        client.get(
            "/api/auth/me", headers={"Authorization": "Bearer " + original["access_token"]}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/refresh", json={"refresh_token": original["refresh_token"]}
        ).status_code
        == 401
    )
    for tokens in (other, replacement):
        assert (
            client.get(
                "/api/auth/me", headers={"Authorization": "Bearer " + tokens["access_token"]}
            ).status_code
            == 200
        )


def test_revoked_device_cannot_refresh_but_can_log_in_again(client, headers):
    original = login(client, device_id="revoked-phone")
    client.delete("/api/devices/revoked-phone", headers=headers)
    assert (
        client.post(
            "/api/auth/refresh", json={"refresh_token": original["refresh_token"]}
        ).status_code
        == 401
    )
    replacement = login(client, device_id="revoked-phone")
    assert (
        client.get(
            "/api/auth/me", headers={"Authorization": "Bearer " + original["access_token"]}
        ).status_code
        == 401
    )
    assert (
        client.get(
            "/api/auth/me", headers={"Authorization": "Bearer " + replacement["access_token"]}
        ).status_code
        == 200
    )


def test_websocket_requires_device_auth_and_checks_origin(client, headers):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/device/connect") as ws:
            ws.send_json({"type": "auth", "token": "invalid"})
            ws.receive_json()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/device/connect", headers=headers) as ws:
            ws.receive_json()
    _, bound = device(client, headers)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/api/device/connect", headers={**bound, "Origin": "https://untrusted.invalid"}
        ) as ws:
            ws.receive_json()
