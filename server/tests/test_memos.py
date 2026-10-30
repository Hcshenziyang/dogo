from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from conftest import device, login, queued_memo, receipt

from dogo_server.errors import ServiceError
from dogo_server.schemas import MemoCreate, MemoDelete


def test_create_is_atomic_and_idempotent(client, headers, app):
    target, _ = device(client, headers)
    failure = queued_memo(client, headers, "missing-device")
    assert failure.status_code == 404
    assert client.get("/api/memos", headers=headers).json()["items"] == []
    first = queued_memo(client, headers, target["id"])
    second = queued_memo(client, headers, target["id"])
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert len(client.get("/api/memos", headers=headers).json()["items"]) == 1
    with app.state.service.db.connect() as db:
        assert db.execute("SELECT count(*) FROM dispatches").fetchone()[0] == 1
    assert queued_memo(client, headers, target["id"], content="different").status_code == 409


def test_snapshot_and_edit_do_not_change_or_redispatch_work(client, headers, app):
    target, bound = device(client, headers)
    created = queued_memo(client, headers, target["id"], project="个人账本").json()
    memo, dispatch = created, created["dispatch"]
    changed = client.put(
        f"/api/memos/{memo['id']}",
        headers=headers,
        json={
            "revision": 1,
            "content": "午饭 40 元",
            "tags": ["修正"],
            "project": "新名称",
        },
    )
    assert changed.status_code == 200
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        frozen = ws.receive_json()["dispatch"]
        assert frozen["id"] == dispatch["id"]
        assert frozen["session_mode"] == "new"
        assert frozen["content_snapshot"] == "午饭 35 元"
        assert frozen["project"] == "个人账本"
    assert (
        client.get("/api/memos", headers=headers, params={"project": "个人账本"}).json()["items"]
        == []
    )
    assert (
        len(client.get("/api/memos", headers=headers, params={"project": "新名称"}).json()["items"])
        == 1
    )
    with app.state.service.db.connect() as db:
        assert db.execute("SELECT count(*) FROM dispatches").fetchone()[0] == 1


def test_revision_conflict_and_delete_tombstone(client, headers):
    memo = client.post(
        "/api/memos", headers=headers, json={"request_id": "create", "content": "first"}
    ).json()
    update = {"revision": 1, "content": "second"}
    path = f"/api/memos/{memo['id']}"
    first = client.put(path, headers=headers, json=update)
    assert first.status_code == 200
    assert client.put(path, headers=headers, json=update).status_code == 409
    conflict = client.put(path, headers=headers, json={**update, "content": "overwritten"})
    assert conflict.status_code == 409
    assert client.get(path, headers=headers).json()["content"] == "second"
    deleted = client.request("DELETE", path, headers=headers, json={"revision": 2})
    assert deleted.status_code == 200
    assert deleted.json()["deleted_at"] is not None
    assert client.get("/api/memos", headers=headers).json()["items"] == []
    assert len(client.get("/api/memos?include_deleted=true", headers=headers).json()["items"]) == 1


def test_delete_cancels_unsent_work_atomically(client, headers):
    target, bound = device(client, headers)
    memo = queued_memo(client, headers, target["id"]).json()
    result = client.request(
        "DELETE", f"/api/memos/{memo['id']}", headers=headers, json={"revision": 1}
    )
    assert result.status_code == 200
    assert result.json()["dispatch"]["status"] == "cancelled"
    assert result.json()["deleted_at"] is not None
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_delete_does_not_recall_sent_work_even_after_receipt_timeout(client, headers, app):
    target, bound = device(client, headers)
    memo = queued_memo(client, headers, target["id"]).json()
    path = f"/api/memos/{memo['id']}"
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        delivery = ws.receive_json()["dispatch"]
        first = client.request("DELETE", path, headers=headers, json={"revision": 1})
        assert first.status_code == 409
        assert first.json()["error"]["code"] == "dispatch_in_flight"
        app.state.service.clock = lambda: delivery["lease_until"] + 1
        retried = ws.receive_json()["dispatch"]
        assert (
            client.request("DELETE", path, headers=headers, json={"revision": 1}).status_code == 409
        )
        ws.send_json(receipt(retried))
        assert ws.receive_json()["type"] == "dispatch.acknowledged"
        deleted = client.request("DELETE", path, headers=headers, json={"revision": 1})
        assert deleted.status_code == 200
        assert deleted.json()["dispatch"]["status"] == "accepted"
        assert deleted.json()["dispatch"]["native_session_id"] == "native-1"


def test_account_isolation_and_account_id_not_accepted(client, headers):
    target, _ = device(client, headers)
    result = queued_memo(client, headers, target["id"], project="private").json()
    bob = {"Authorization": "Bearer " + login(client, "bob")["access_token"]}
    assert client.get(f"/api/memos/{result['id']}", headers=bob).status_code == 404
    assert queued_memo(client, bob, target["id"]).status_code == 404
    assert client.get("/api/memos", headers=bob).json()["items"] == []
    assert (
        client.post(
            "/api/memos",
            headers=bob,
            json={
                "request_id": "spoof",
                "content": "bad",
                "account_id": result["account_id"],
            },
        ).status_code
        == 422
    )


def test_inactive_memo_and_mobile_target_cannot_dispatch(client, headers):
    target, _ = device(client, headers)
    assert queued_memo(client, headers, target["id"], active=False).status_code == 409
    phone, _ = device(client, headers, "Phone", kind="mobile")
    assert queued_memo(client, headers, phone["id"]).status_code == 409
    assert client.get("/api/memos", headers=headers).json()["items"] == []


def test_append_is_versioned_and_retry_does_not_duplicate_entry(client, headers):
    memo = client.post(
        "/api/memos", headers=headers, json={"request_id": "ledger", "content": "账本\n"}
    ).json()
    path = f"/api/memos/{memo['id']}/append"
    entry = {"revision": 1, "content": "午饭 35 元\n"}
    saved = client.post(path, headers=headers, json=entry)
    assert saved.status_code == 200
    assert client.post(path, headers=headers, json=entry).status_code == 409
    assert (
        client.post(
            path, headers=headers, json={"revision": 2, "content": "晚饭 20 元\n"}
        ).status_code
        == 200
    )
    assert client.post(path, headers=headers, json=entry).status_code == 409
    assert (
        client.get(f"/api/memos/{memo['id']}", headers=headers).json()["content"]
        == "账本\n午饭 35 元\n晚饭 20 元\n"
    )
    assert client.post(path, headers=headers, json=entry).status_code == 409


def test_concurrent_create_uses_business_record_for_deduplication(app, headers, client):
    target, _ = device(client, headers)
    principal = app.state.auth.bearer(headers["Authorization"])
    data = MemoCreate(
        request_id="concurrent-create",
        content="one memo",
        dispatch={"instruction": "process", "target_device_id": target["id"]},
    )
    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(
            executor.map(lambda _: app.state.service.create_memo(principal, data), range(6))
        )
    assert len({result["id"] for result in results}) == 1
    assert len({result["dispatch"]["id"] for result in results}) == 1
    assert len(client.get("/api/memos", headers=headers).json()["items"]) == 1
    with app.state.service.db.connect() as db:
        assert db.execute("SELECT count(*) FROM dispatches").fetchone()[0] == 1


def test_delayed_create_retry_returns_current_records_without_recreating(client, headers):
    target, _ = device(client, headers)
    created = queued_memo(client, headers, target["id"]).json()
    path = f"/api/memos/{created['id']}"
    assert (
        client.put(path, headers=headers, json={"revision": 1, "content": "edited"}).status_code
        == 200
    )
    assert client.request("DELETE", path, headers=headers, json={"revision": 2}).status_code == 200
    retried = queued_memo(client, headers, target["id"]).json()
    assert retried["id"] == created["id"]
    assert retried["content"] == "edited"
    assert retried["deleted_at"] is not None
    assert retried["dispatch"]["id"] == created["dispatch"]["id"]
    assert retried["dispatch"]["status"] == "cancelled"
    assert "request_hash" not in retried
    assert "request_hash" not in retried["dispatch"]
    assert client.get("/api/memos", headers=headers).json()["items"] == []


def test_delete_and_send_race_has_one_consistent_outcome(client, headers, app):
    target, bound = device(client, headers)
    memo = queued_memo(client, headers, target["id"]).json()
    owner = app.state.auth.bearer(headers["Authorization"])
    consumer = app.state.auth.bearer(bound["Authorization"])
    start = Barrier(2)

    def delete():
        start.wait(timeout=5)
        try:
            return app.state.service.delete_memo(owner, memo["id"], MemoDelete(revision=1))
        except ServiceError as error:
            return error

    def send():
        start.wait(timeout=5)
        return app.state.service.next_delivery(consumer)

    with ThreadPoolExecutor(max_workers=2) as pool:
        deletion, sending = pool.submit(delete), pool.submit(send)
        deleted, delivered = deletion.result(), sending.result()
    current = client.get(f"/api/memos/{memo['id']}", headers=headers).json()
    if delivered is None:
        assert not isinstance(deleted, ServiceError)
        assert current["deleted_at"] is not None
        assert current["dispatch"]["status"] == "cancelled"
    else:
        assert isinstance(deleted, ServiceError)
        assert deleted.code == "dispatch_in_flight"
        assert current["deleted_at"] is None
        assert current["dispatch"]["status"] == "leased"
