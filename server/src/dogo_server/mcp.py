import asyncio
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.responses import JSONResponse

from .errors import ServiceError
from .schemas import MemoAppend, MemoCreate, MemoDelete, MemoUpdate


class MCPAuthentication:
    def __init__(self, app, auth):
        self.app = app
        self.auth = auth

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            try:
                scope["dogo_principal"] = await asyncio.to_thread(
                    self.auth.bearer, headers.get(b"authorization", b"").decode()
                )
            except ServiceError as error:
                response = JSONResponse(
                    {"error": {"code": error.code, "message": error.message}},
                    status_code=error.status,
                    headers={"WWW-Authenticate": "Bearer"},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_mcp(service, settings) -> FastMCP:
    server = FastMCP(
        "DogO",
        instructions="Manage personal memos. Saving content does not dispatch work unless explicitly requested.",
        stateless_http=True,
        json_response=True,
        streamable_http_path="/",
        max_request_body_size=1024 * 1024,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=[*settings.allowed_hosts, *(f"{h}:*" for h in settings.allowed_hosts)],
            allowed_origins=list(settings.allowed_origins),
        ),
    )
    read = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
    write = ToolAnnotations(idempotentHint=True, openWorldHint=False)

    async def call(ctx, method, *args, **kwargs):
        request = ctx.request_context.request
        if request is None or "dogo_principal" not in request.scope:
            raise ToolError("authentication_required")
        try:
            return await asyncio.to_thread(method, request.scope["dogo_principal"], *args, **kwargs)
        except ServiceError as error:
            raise ToolError(f"{error.code}: {error.message}") from None

    @server.tool(annotations=read)
    async def list_memos(
        ctx: Context,
        project: str | None = None,
        cursor: str = "",
        limit: int = 100,
        include_deleted: bool = False,
    ) -> dict[str, Any]:
        """List this account's memos; continue with next_cursor when present."""
        return await call(ctx, service.list_memos, project, cursor, limit, include_deleted)

    @server.tool(annotations=read)
    async def get_memo(memo_id: str, ctx: Context) -> dict[str, Any]:
        """Read a memo and its current revision, including its deletion marker."""
        return await call(ctx, service.get_memo, memo_id)

    @server.tool(annotations=write)
    async def create_memo(data: MemoCreate, ctx: Context) -> dict[str, Any]:
        """Save content. Include dispatch only when explicitly asked to execute it; reuse request_id on retry."""
        return await call(ctx, service.create_memo, data)

    @server.tool(annotations=write)
    async def update_memo(memo_id: str, data: MemoUpdate, ctx: Context) -> dict[str, Any]:
        """Replace memo fields using the revision you read. This never re-dispatches prior work."""
        return await call(ctx, service.update_memo, memo_id, data)

    @server.tool(annotations=ToolAnnotations(destructiveHint=True, idempotentHint=True))
    async def delete_memo(memo_id: str, data: MemoDelete, ctx: Context) -> dict[str, Any]:
        """Soft-delete a memo and cancel unsent work. In-flight delivery blocks deletion; accepted DSH work continues."""
        return await call(ctx, service.delete_memo, memo_id, data)

    @server.tool(annotations=write)
    async def append_memo(memo_id: str, data: MemoAppend, ctx: Context) -> dict[str, Any]:
        """Append exact text once at a known revision. On conflict, read and reconcile; never blindly rebase."""
        return await call(ctx, service.append_memo, memo_id, data)

    @server.tool(annotations=read)
    async def list_devices(ctx: Context) -> list[dict[str, Any]]:
        """List registered devices. Active is authorization state, not online presence."""
        return await call(ctx, service.list_devices)

    return server
