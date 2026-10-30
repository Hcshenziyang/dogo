from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import device, queued_memo, receipt
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from dogo_server.app import create_app
from dogo_server.schemas import DispatchAck


def test_offline_delivery_survives_server_restart(client, headers, settings):
    target, bound = device(client, headers)
    memo = queued_memo(client, headers, target["id"]).json()
    restarted = create_app(settings)
    with TestClient(restarted) as other:
        with other.websocket_connect("/api/device/connect", headers=bound) as ws:
            assert ws.receive_json()["type"] == "connected"
            event = ws.receive_json()
            assert event["type"] == "dispatch"
            delivery = event["dispatch"]
            assert delivery["id"] == memo["dispatch"]["id"]
            ws.send_json(receipt(delivery))
            assert ws.receive_json()["type"] == "dispatch.acknowledged"
        state = other.get(f"/api/memos/{memo['id']}", headers=headers).json()
        assert state["dispatch"]["status"] == "accepted"


def test_concurrent_delivery_resumes_one_outstanding_receipt(client, headers, app):
    target, bound = device(client, headers)
    first = queued_memo(client, headers, target["id"]).json()
    second = queued_memo(client, headers, target["id"], request_id="second").json()
    principal = app.state.auth.bearer(bound["Authorization"])
    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(lambda _: app.state.service.next_delivery(principal), range(6)))
    assert len({result["id"] for result in results}) == 1
    assert len({result["lease_token"] for result in results}) == 1
    assert {result["attempts"] for result in results} == {1}
    delivered = results[0]
    app.state.service.acknowledge(principal, DispatchAck(**receipt(delivered)))
    next_delivery = app.state.service.next_delivery(principal)
    assert {delivered["id"], next_delivery["id"]} == {
        first["dispatch"]["id"],
        second["dispatch"]["id"],
    }


def test_lease_retry_keeps_command_id_and_ack_is_idempotent(client, headers, app):
    target, bound = device(client, headers)
    memo = queued_memo(client, headers, target["id"]).json()
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        first = ws.receive_json()["dispatch"]
        app.state.service.clock = lambda: first["lease_until"] + 1
        retried = ws.receive_json()["dispatch"]
        assert retried["id"] == first["id"]
        assert retried["lease_token"] != first["lease_token"]
        assert retried["attempts"] == 2
        ws.send_json(receipt(first))
        assert ws.receive_json()["code"] == "lease_mismatch"
        for _ in range(2):
            ws.send_json(receipt(retried))
            assert ws.receive_json() == {
                "type": "dispatch.acknowledged",
                "dispatch_id": first["id"],
            }
        ws.send_json(receipt(retried, "different"))
        assert ws.receive_json()["code"] == "lease_mismatch"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"
    assert (
        client.get(f"/api/memos/{memo['id']}", headers=headers).json()["dispatch"]["status"]
        == "accepted"
    )


def test_only_target_device_can_ack(client, headers):
    target, bound = device(client, headers)
    _, other_bound = device(client, headers, "Computer C")
    memo = queued_memo(client, headers, target["id"]).json()
    with client.websocket_connect("/api/device/connect", headers=bound) as first:
        assert first.receive_json()["type"] == "connected"
        delivery = first.receive_json()["dispatch"]
        with client.websocket_connect("/api/device/connect", headers=other_bound) as other:
            assert other.receive_json()["type"] == "connected"
            other.send_json(receipt(delivery))
            assert other.receive_json()["code"] == "not_found"
        assert (
            client.get(f"/api/memos/{memo['id']}", headers=headers).json()["dispatch"]["status"]
            == "leased"
        )
        first.send_json(receipt(delivery))
        assert first.receive_json()["type"] == "dispatch.acknowledged"


def test_immediate_push_disconnect_and_reconnect_preserve_delivery(client, headers):
    target, bound = device(client, headers)
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        memo = queued_memo(client, headers, target["id"]).json()
        first = ws.receive_json()["dispatch"]
    assert (
        client.get(f"/api/memos/{memo['id']}", headers=headers).json()["dispatch"]["status"]
        == "leased"
    )
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        resumed = ws.receive_json()["dispatch"]
        assert resumed["id"] == first["id"]
        assert resumed["lease_token"] == first["lease_token"]
        ws.send_json(receipt(resumed))
        assert ws.receive_json()["type"] == "dispatch.acknowledged"


def test_sweep_recovers_a_missed_wakeup(client, headers, app):
    target, bound = device(client, headers)
    app.state.service.notify = lambda *_: None
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        memo = queued_memo(client, headers, target["id"]).json()
        event = ws.receive_json()
        assert event["type"] == "dispatch"
        assert event["dispatch"]["id"] == memo["dispatch"]["id"]


def test_device_can_authenticate_without_token_in_websocket_url(client, headers):
    _, bound = device(client, headers)
    with client.websocket_connect("/api/device/connect") as ws:
        ws.send_json({"type": "auth", "token": bound["Authorization"].split(" ", 1)[1]})
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_ack_advances_queue_without_another_http_request(client, headers):
    target, bound = device(client, headers)
    memos = [
        queued_memo(client, headers, target["id"], request_id=f"memo-{i}").json() for i in range(3)
    ]
    delivered = set()
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        for _ in memos:
            command = ws.receive_json()["dispatch"]
            delivered.add(command["id"])
            ws.send_json({"type": "ping"})
            assert ws.receive_json()["type"] == "pong"
            ws.send_json(receipt(command, "native-" + command["id"]))
            assert ws.receive_json()["type"] == "dispatch.acknowledged"
    assert delivered == {memo["dispatch"]["id"] for memo in memos}
    listed = client.get("/api/memos", headers=headers).json()["items"]
    assert {memo["dispatch"]["status"] for memo in listed} == {"accepted"}
    assert all(
        not ({"lease_token", "lease_until", "attempts", "request_hash"} & memo["dispatch"].keys())
        for memo in listed
    )


def test_invalid_receipt_does_not_accept_work_or_break_connection(client, headers):
    target, bound = device(client, headers)
    memo = queued_memo(client, headers, target["id"]).json()
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        delivery = ws.receive_json()["dispatch"]
        ws.send_json({"type": "dispatch.ack", "dispatch_id": delivery["id"]})
        assert ws.receive_json()["code"] == "invalid_message"
        assert (
            client.get(f"/api/memos/{memo['id']}", headers=headers).json()["dispatch"]["status"]
            == "leased"
        )
        ws.send_json(receipt(delivery))
        assert ws.receive_json()["type"] == "dispatch.acknowledged"


def test_revocation_closes_connection_and_cannot_receive_new_work(client, headers):
    target, bound = device(client, headers)
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        assert client.delete(f"/api/devices/{target['id']}", headers=headers).status_code == 200
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    assert queued_memo(client, headers, target["id"]).status_code == 409


def test_only_one_live_connection_per_device(client, headers):
    _, bound = device(client, headers)
    with client.websocket_connect("/api/device/connect", headers=bound) as first:
        assert first.receive_json()["type"] == "connected"
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/device/connect", headers=bound) as second:
                second.receive_json()
        first.send_json({"type": "ping"})
        assert first.receive_json()["type"] == "pong"
