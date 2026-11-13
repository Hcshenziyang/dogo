"""ASGI entry point. All business behavior lives behind application services."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .bootstrap import create_container
from .config import Settings
from .domain.errors import DomainError
from .interfaces import auth, devices, remote, websocket
from .interfaces.errors import domain_error_handler
from .interfaces.mcp import MCPAuthentication, create_mcp


def create_app(settings: Settings | None = None) -> FastAPI:
    container = create_container(settings or Settings.from_env())
    mcp = create_mcp(container)
    mcp_app = mcp.streamable_http_app()

    @asynccontextmanager
    async def lifespan(app):
        async with (
            container.notifications.run(),
            mcp.session_manager.run(),
        ):
            yield

    app = FastAPI(title="DogO", version="0.1.0", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(container.settings.allowed_hosts))
    app.state.container = container
    app.add_exception_handler(DomainError, domain_error_handler)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    for router in (auth.router, devices.router, remote.router, websocket.router):
        app.include_router(router)
    app.mount("/mcp", MCPAuthentication(mcp_app, container))
    return app
