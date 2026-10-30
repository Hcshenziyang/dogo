"""Evaluation adapter: real DogO HTTP/WS + real isolated DSH; no production changes.

Reuses the backend's process fixture, but replaces its synthetic native-session
receipt with an actual DSH session/prompt. Local JSON binding stands in for the
future device plugin's durable delivery journal; this is not a shipped plugin.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

import httpx
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server/tests"))
from conftest import device, login, queued_memo, receipt
from test_network import running_server
from dogo_server.app import create_app
from dogo_server.config import Settings

CACHE = Path(os.environ["EVAL_CACHE"])
results = []
native = httpx.Client(base_url="http://127.0.0.1:18181", headers={"Cookie": (CACHE / "browser-cookie").read_text()}, trust_env=False)


def call(method, args):
    response = native.post("/api/session/" + method, json={"type": "client-request", "rpcId": str(uuid.uuid4()), "method": "session/" + method, "payload": {"args": args}})
    response.raise_for_status()
    result = response.json()["result"]
    assert result["ok"], result
    return result.get("value")


def passed(name):
    results.append({"test": name, "passed": True})
    print("PASS", name, flush=True)


with tempfile.TemporaryDirectory(prefix="dogo-native-eval-") as directory:
    tmp = Path(directory)
    settings = Settings(data_dir=tmp / "db", jwt_secret="isolated-evaluation-key-with-no-production-use")
    create_app(settings).state.auth.create_account("alice", "alice-test-password")
    with running_server(settings, tmp) as (http, port):
        owner = {"Authorization": "Bearer " + login(http)["access_token"]}
        target, bound = device(http, owner)
        marker = "queue-" + str(uuid.uuid4())
        memo = queued_memo(http, owner, target["id"], content="evaluation memo", dispatch={"instruction": marker, "target_device_id": target["id"]}).json()
        assert memo["dispatch"]["status"] == "pending"
        assert http.post("/api/v1/auth/login", json={"email": "evaluation@example.test", "password": "unused"}).status_code == 404
        passed("upstream-account-api-not-compatible-with-dogo")
    passed("offline-memo-enqueued-before-server-process-exits")

    with running_server(settings, tmp) as (http, port):
        with connect(f"ws://127.0.0.1:{port}/api/device/connect", additional_headers=bound, proxy=None, open_timeout=5, close_timeout=2) as ws:
            assert json.loads(ws.recv(timeout=5))["type"] == "connected"
            dispatch = json.loads(ws.recv(timeout=5))["dispatch"]
            assert dispatch["id"] == memo["dispatch"]["id"]
            session_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "dogo-dispatch:" + dispatch["id"]))
            created = call("create", {"request": {"sessionId": session_id, "cwd": str(CACHE)}})
            assert created["sessionId"] == session_id
            call("selectModel", {"request": {"sessionId": session_id, "provider": "dogo-eval", "model": "fixture"}})
            request = {"sessionId": session_id, "requestId": dispatch["id"], "mode": "queue", "content": [{"type": "text", "text": dispatch["instruction"]}]}
            (tmp / "binding.json").write_text(json.dumps({"dispatchId": dispatch["id"], "sessionId": session_id, "request": request}))
            assert call("prompt", {"request": request})["accepted"]
            passed("offline-delivery-creates-real-native-session-and-prompt")
            # Deliberately lose ACK, then stop the entire DogO server process.
    time.sleep(2.5)
    with running_server(settings, tmp) as (http, port):
        with connect(f"ws://127.0.0.1:{port}/api/device/connect", additional_headers=bound, proxy=None, open_timeout=5, close_timeout=2) as ws:
            assert json.loads(ws.recv(timeout=5))["type"] == "connected"
            retry = json.loads(ws.recv(timeout=5))["dispatch"]
            binding = json.loads((tmp / "binding.json").read_text())
            assert retry["id"] == binding["dispatchId"]
            assert call("prompt", {"request": binding["request"]})["accepted"]
            ws.send(json.dumps(receipt(retry, binding["sessionId"])))
            assert json.loads(ws.recv(timeout=5))["type"] == "dispatch.acknowledged"
            passed("ack-loss-server-restart-replays-same-native-request")
        saved = http.get(f"/api/memos/{memo['id']}", headers=owner).json()
        assert saved["dispatch"]["status"] == "accepted"
        assert saved["dispatch"]["native_session_id"] == session_id
        time.sleep(2.5)
        attempts = [json.loads(line) for line in (CACHE / "model-attempts.jsonl").read_text().splitlines()]
        assert sum(a["phase"] == "start" and a["text"] == marker for a in attempts) == 1
        passed("one-model-run-and-native-session-id-returned-to-memo")
        (CACHE / "queue-replay.json").write_text(json.dumps({"request": request, "marker": marker}))

native.close()
(CACHE / "dogo-queue-probe.json").write_text(json.dumps(results, indent=2))
