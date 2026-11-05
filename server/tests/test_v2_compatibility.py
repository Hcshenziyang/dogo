"""An existing v2 database and its request hashes survive the new adapters."""

import hashlib
import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from dogo_server.app import create_app
from dogo_server.application.commands import MemoCreate
from dogo_server.application.memos import request_digest


def test_existing_v2_memo_retry_preserves_metadata_through_migration(settings):
    path = settings.data_dir / "dogo.sqlite"
    payload = {
        "request_id": "original-request",
        "content": "午饭 35 元",
        "project": "账本",
        "category": "餐饮",
        "tags": ["中文", "🍜"],
        "active": True,
        "dispatch": None,
    }
    # Original Pydantic model_dump -> canonical JSON algorithm, independent of new commands.
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    assert request_digest(payload) == digest
    with sqlite3.connect(path) as db:
        db.executescript((Path(__file__).parent / "fixtures/v2.sql").read_text())
        db.execute("INSERT INTO accounts VALUES ('account','alice','unused-test-hash',1,100)")
        db.execute(
            "INSERT INTO devices VALUES ('phone','account','Phone','mobile',1,1,NULL,4102444800,100)"
        )
        db.execute(
            "INSERT INTO memos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "memo",
                "account",
                "账本",
                payload["request_id"],
                digest,
                payload["content"],
                "餐饮",
                json.dumps(payload["tags"], ensure_ascii=False),
                1,
                "phone",
                1,
                100,
                100,
                None,
            ),
        )
    app = create_app(settings)
    container = app.state.container
    from dogo_server.domain.identity import Principal

    principal = Principal("account", "phone", 1)
    token = container.identity.access_token(principal)
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer " + token}
        original = client.get("/api/memos/memo", headers=headers).json()
        retried = client.post("/api/memos", headers=headers, json=payload)
        assert retried.status_code == 201
        assert retried.json() == original
        assert original["content"] == payload["content"] and original["tags"] == payload["tags"]
        assert "request_hash" not in original
        assert (
            client.post(
                "/api/memos", headers=headers, json={**payload, "content": "different"}
            ).status_code
            == 409
        )
        deleted = client.request("DELETE", "/api/memos/memo", headers=headers, json={"revision": 1})
        assert deleted.status_code == 200
        assert client.post("/api/memos", headers=headers, json=payload).json() == deleted.json()
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
        assert db.execute("SELECT plan,next_run_at FROM memos").fetchone() == (None, None)
        assert db.execute("SELECT count(*) FROM memos").fetchone()[0] == 1


def test_application_create_hash_matches_original_default_payload():
    from dataclasses import asdict

    old_payload = {
        "request_id": "same",
        "content": "text",
        "project": "",
        "category": "",
        "tags": [],
        "active": True,
        "dispatch": None,
    }
    assert request_digest(asdict(MemoCreate(request_id="same", content="text"))) == request_digest(
        old_payload
    )
