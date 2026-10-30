import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import httpx
import pytest
from conftest import device, login, queued_memo, receipt
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from websockets.sync.client import connect


@contextmanager
def running_server(settings, tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    env = {
        **os.environ,
        "DOGO_DATA_DIR": str(settings.data_dir),
        "DOGO_JWT_SECRET": settings.jwt_secret,
        "DOGO_ALLOWED_HOSTS": "127.0.0.1,localhost",
    }
    with (tmp_path / "server-test.log").open("a+") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "from dogo_server.cli import main; main()",
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            with httpx.Client(
                base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False
            ) as http:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try:
                        if http.get("/health").status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(log.read())
                    time.sleep(0.05)
                else:
                    pytest.fail("Server did not become ready")
                yield http, port
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.mark.timeout(30)
def test_cli_accepts_remote_snapshot_larger_than_32_kib(app, settings, tmp_path):
    with running_server(settings, tmp_path) as (http, port):
        headers = {"Authorization": "Bearer " + login(http)["access_token"]}
        target, bound = device(http, headers)
        with connect(
            f"ws://127.0.0.1:{port}/api/device/connect",
            additional_headers=bound,
            proxy=None,
            open_timeout=5,
            close_timeout=2,
        ) as ws:
            assert json.loads(ws.recv(timeout=5))["type"] == "connected"
            with ThreadPoolExecutor() as pool:
                request = pool.submit(
                    http.post,
                    "/api/remote/call",
                    headers=headers,
                    json={
                        "device_id": target["id"],
                        "method": "snapshot",
                        "args": {"sessionId": "synthetic"},
                    },
                )
                frame = json.loads(ws.recv(timeout=5))
                value = {"history": "x" * 65536}
                ws.send(
                    json.dumps(
                        {"type": "remote.result", "id": frame["id"], "ok": True, "value": value}
                    )
                )
                result = request.result(timeout=5)
                assert result.status_code == 200
                assert result.json() == {"value": value}


@pytest.mark.timeout(30)
def test_real_http_websocket_mcp_and_process_restart(app, settings, tmp_path):
    with running_server(settings, tmp_path) as (http, _):
        headers = {"Authorization": "Bearer " + login(http)["access_token"]}
        target, bound = device(http, headers)
        result = queued_memo(http, headers, target["id"]).json()
    # The first OS process is gone. Work and authentication survive in SQLite.
    with running_server(settings, tmp_path) as (http, port):
        with connect(
            f"ws://127.0.0.1:{port}/api/device/connect",
            additional_headers=bound,
            proxy=None,
            open_timeout=5,
            close_timeout=2,
        ) as ws:
            assert json.loads(ws.recv(timeout=5))["type"] == "connected"
            event = json.loads(ws.recv(timeout=5))
            assert event["type"] == "dispatch"
            claimed = event["dispatch"]
            assert claimed["id"] == result["dispatch"]["id"]
            ws.send(json.dumps(receipt(claimed, "synthetic-session")))
            assert json.loads(ws.recv(timeout=5))["type"] == "dispatch.acknowledged"

        async def read_with_official_mcp_client():
            async with httpx.AsyncClient(headers=headers, timeout=5, trust_env=False) as mcp_http:
                async with streamable_http_client(
                    f"http://127.0.0.1:{port}/mcp/",
                    http_client=mcp_http,
                ) as (reader, writer, _):
                    async with ClientSession(reader, writer) as session:
                        await session.initialize()
                        output = await session.call_tool("get_memo", {"memo_id": result["id"]})
                        assert not output.isError
                        assert output.structuredContent["content"] == "午饭 35 元"
                        assert output.structuredContent["dispatch"]["status"] == "accepted"

        asyncio.run(read_with_official_mcp_client())
        state = http.get(f"/api/memos/{result['id']}", headers=headers).json()
        assert state["dispatch"]["status"] == "accepted"
        assert state["dispatch"]["native_session_id"] == "synthetic-session"
