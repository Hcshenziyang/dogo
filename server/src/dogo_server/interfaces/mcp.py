import asyncio
from typing import Any, Protocol

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

from ..application.identity import IdentityService
from ..config import Settings
from ..domain.errors import DomainError
from .errors import error_response


class MCPDependencies(Protocol):
    identity: IdentityService
    settings: Settings


class MCPAuthentication:
    def __init__(self, app, container: MCPDependencies):
        self.app = app
        self.container = container

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            try:
                scope["dogo_principal"] = await asyncio.to_thread(
                    self.container.identity.bearer, headers.get(b"authorization", b"").decode()
                )
            except DomainError as error:
                response = error_response(error)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_mcp(container: MCPDependencies) -> FastMCP:
    settings = container.settings
    server = FastMCP(
        "DogO",
        instructions="List registered devices for the authenticated account.",
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

    async def call(ctx, service, method, *args, **kwargs):
        request = ctx.request_context.request
        if request is None or "dogo_principal" not in request.scope:
            raise ToolError("authentication_required")
        try:
            # Resolve the same container used by HTTP rather than binding a second service graph.
            dependency = getattr(container, service)
            return await asyncio.to_thread(
                getattr(dependency, method), request.scope["dogo_principal"], *args, **kwargs
            )
        except DomainError as error:
            raise ToolError(f"{error.code}: {error.message}") from None

    @server.tool(annotations=read)
    async def list_devices(ctx: Context) -> list[dict[str, Any]]:
        """List registered devices. Active is authorization state, not online presence."""
        return await call(ctx, "identity", "list_devices")

    return server
