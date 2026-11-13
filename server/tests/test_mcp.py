from mcp.types import LATEST_PROTOCOL_VERSION


def test_only_supported_http_endpoints_and_mcp_tools_are_exposed(client, headers):
    paths = client.get("/openapi.json").json()["paths"]
    assert set(paths) == {
        "/health",
        "/api/auth/login",
        "/api/auth/refresh",
        "/api/auth/logout",
        "/api/auth/me",
        "/api/devices",
        "/api/devices/{device_id}",
        "/api/remote/call",
    }
    for method, path in (
        ("GET", "/api/memos"),
        ("POST", "/api/memos"),
        ("GET", "/api/memos/old"),
        ("POST", "/api/memos/old/append"),
    ):
        assert client.request(method, path, headers=headers).status_code == 404
    mcp_headers = {
        **headers,
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
    }
    response = client.post(
        "/mcp/",
        headers=mcp_headers,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
    )
    assert response.status_code == 200
    assert {tool["name"] for tool in response.json()["result"]["tools"]} == {"list_devices"}
    response = client.post(
        "/mcp/",
        headers=mcp_headers,
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "list_devices", "arguments": {}},
        },
    )
    assert response.status_code == 200
    assert not response.json()["result"].get("isError", False)
