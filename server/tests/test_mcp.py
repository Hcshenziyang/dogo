from conftest import login
from mcp.types import LATEST_PROTOCOL_VERSION


def tool(client, headers, name, arguments):
    response = client.post(
        "/mcp/",
        headers={
            **headers,
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["result"]


def test_mcp_and_rest_share_data_auth_and_idempotency(client, headers):
    body = {"request_id": "mcp-create", "content": "来自 MCP 的记录"}
    mcp = tool(client, headers, "create_memo", {"data": body})
    assert not mcp.get("isError", False)
    memo = mcp["structuredContent"]
    assert (
        client.get(f"/api/memos/{memo['id']}", headers=headers).json()["content"] == body["content"]
    )
    assert client.post("/api/memos", headers=headers, json=body).json()["id"] == memo["id"]
    bob = {"Authorization": "Bearer " + login(client, "bob")["access_token"]}
    forbidden = tool(client, bob, "get_memo", {"memo_id": memo["id"]})
    assert forbidden["isError"] is True
    assert "not_found" in forbidden["content"][0]["text"]


def test_mcp_cannot_bypass_revision_check(client, headers):
    memo = client.post(
        "/api/memos", headers=headers, json={"request_id": "initial", "content": "keep"}
    ).json()
    result = tool(
        client,
        headers,
        "update_memo",
        {"memo_id": memo["id"], "data": {"revision": 9, "content": "bad"}},
    )
    assert result["isError"] is True
    assert "revision_conflict" in result["content"][0]["text"]
    assert client.get(f"/api/memos/{memo['id']}", headers=headers).json()["content"] == "keep"


def test_only_basic_http_endpoints_and_mcp_tools_are_exposed(client, headers):
    paths = client.get("/openapi.json").json()["paths"]
    assert set(paths) == {
        "/health",
        "/api/auth/login",
        "/api/auth/refresh",
        "/api/auth/logout",
        "/api/auth/me",
        "/api/devices",
        "/api/devices/{device_id}",
        "/api/memos",
        "/api/memos/{memo_id}",
        "/api/memos/{memo_id}/append",
        "/api/remote/call",
    }
    for method, path in (
        ("GET", "/api/dispatches"),
        ("POST", "/api/dispatches"),
        ("GET", "/api/dispatches/old"),
        ("POST", "/api/dispatches/old/cancel"),
        ("POST", "/api/device/claim"),
        ("POST", "/api/device/dispatches/old/ack"),
    ):
        assert client.request(method, path, headers=headers).status_code == 404
    response = client.post(
        "/mcp/",
        headers={**headers, "Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
    )
    assert response.status_code == 200
    assert {tool["name"] for tool in response.json()["result"]["tools"]} == {
        "list_memos",
        "get_memo",
        "create_memo",
        "update_memo",
        "append_memo",
        "delete_memo",
        "list_devices",
    }
    assert tool(client, headers, "dispatch_memo", {"data": {}})["isError"] is True
