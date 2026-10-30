import asyncio
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import device, login

from dogo_server.errors import ServiceError
from dogo_server.remote import RemoteRelay
from dogo_server.schemas import RemoteResult


@pytest.mark.parametrize("method", ["list", "workspaces", "models", "selectModel"])
def test_remote_requires_auth_owner_online_and_fixed_methods(client, headers, method):
    target, _ = device(client, headers)
    request = {"device_id": target["id"], "method": method, "args": {}}
    assert client.post("/api/remote/call", json=request).status_code == 401
    assert (
        client.post("/api/remote/call", json=request, headers=headers).json()["error"]["code"]
        == "host_offline"
    )
    bob = {"Authorization": "Bearer " + login(client, "bob")["access_token"]}
    assert client.post("/api/remote/call", json=request, headers=bob).status_code == 404
    request["method"] = "exec"
    assert client.post("/api/remote/call", json=request, headers=headers).status_code == 422


def test_online_forwarding_reply_and_revocation(client, headers):
    target, bound = device(client, headers)
    with client.websocket_connect("/api/device/connect", headers=bound) as ws:
        assert ws.receive_json()["type"] == "connected"
        rows = client.get("/api/devices", headers=headers).json()
        assert next(d for d in rows if d["id"] == target["id"])["online"]
        with ThreadPoolExecutor() as pool:
            future = pool.submit(
                client.post,
                "/api/remote/call",
                headers=headers,
                json={"device_id": target["id"], "method": "list", "args": {}},
            )
            frame = ws.receive_json()
            assert frame["type"] == "remote.call"
            ws.send_json(
                {"type": "remote.result", "id": frame["id"], "ok": True, "value": {"items": []}}
            )
            assert future.result(timeout=5).json() == {"value": {"items": []}}
            future = pool.submit(
                client.post,
                "/api/remote/call",
                headers=headers,
                json={"device_id": target["id"], "method": "list", "args": {}},
            )
            frame = ws.receive_json()
            # The viewer loses its authority while the Host is handling the request.
            assert client.post("/api/auth/logout", headers=headers).status_code == 200
            ws.send_json(
                {"type": "remote.result", "id": frame["id"], "ok": True, "value": "private"}
            )
            assert future.result(timeout=5).status_code == 401


def test_broker_disconnect_wrong_peer_and_bounded_pending():
    async def scenario():
        broker = RemoteRelay(lambda *_: None)
        async with broker.attach("account", "host"):
            task = asyncio.create_task(broker.call("account", "host", {"method": "list"}))
            await asyncio.sleep(0)
            frame = next(broker.drain("account", "host"))
            with pytest.raises(ServiceError, match="another device"):
                broker.resolve(
                    "other-account",
                    "host",
                    RemoteResult(type="remote.result", id=frame["id"], ok=True),
                )
        with pytest.raises(ServiceError, match="disconnected"):
            await task
        assert not broker.pending
        async with broker.attach("account", "host"):
            tasks = [asyncio.create_task(broker.call("account", "host", {})) for _ in range(16)]
            await asyncio.sleep(0)
            with pytest.raises(ServiceError) as error:
                await broker.call("account", "host", {})
            assert error.value.code == "remote_busy"
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        assert not broker.pending

    asyncio.run(scenario())
