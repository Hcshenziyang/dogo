import uuid

import pytest
from fastapi.testclient import TestClient

from dogo_server.app import create_app
from dogo_server.config import Settings


@pytest.fixture
def settings(tmp_path):
    return Settings(
        data_dir=tmp_path,
        jwt_secret="synthetic-test-key-not-a-production-secret",
        allowed_hosts=("testserver", "127.0.0.1", "localhost"),
    )


@pytest.fixture
def app(settings):
    application = create_app(settings)
    application.state.container.identity.create_account("alice", "alice-test-password")
    application.state.container.identity.create_account("bob", "bob-test-password")
    return application


@pytest.fixture
def client(app):
    with TestClient(app) as http:
        yield http


def login(client, username="alice", device_id=None, name="Phone", kind="mobile"):
    response = client.post(
        "/api/auth/login",
        json={
            "username": username,
            "password": f"{username}-test-password",
            "device_id": device_id or str(uuid.uuid4()),
            "device_name": name,
            "device_kind": kind,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def headers(client):
    return {"Authorization": "Bearer " + login(client)["access_token"]}


def device(client, headers, name="Computer B", kind="desktop"):
    username = client.get("/api/auth/me", headers=headers).json()["username"]
    result = login(client, username, name=name, kind=kind)
    bound = {"Authorization": "Bearer " + result["access_token"]}
    row = next(
        row
        for row in client.get("/api/devices", headers=bound).json()
        if row["id"] == result["device_id"]
    )
    return row, bound
