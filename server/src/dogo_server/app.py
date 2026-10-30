import asyncio
import json
from contextlib import asynccontextmanager
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .auth import Auth, Principal
from .config import Settings
from .db import Database
from .errors import ServiceError
from .mcp import MCPAuthentication, create_mcp
from .notifications import Notifications
from .remote import RemoteRelay
from .schemas import (
    DispatchAck,
    Login,
    MemoAppend,
    MemoCreate,
    MemoDelete,
    MemoUpdate,
    Refresh,
    RemoteCall,
    RemoteResult,
)
from .service import Service

bearer_scheme = HTTPBearer(auto_error=False)


def current_principal(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
):
    authorization = f"{credentials.scheme} {credentials.credentials}" if credentials else None
    return request.app.state.auth.bearer(authorization)


Identity = Annotated[Principal, Depends(current_principal)]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    db = Database(settings.data_dir / "dogo.sqlite")
    db.initialize()
    auth = Auth(db, settings)
    notifications = Notifications(settings.scan_seconds)
    service = Service(db, settings, notifications.wake)
    relay = RemoteRelay(notifications.wake)
    mcp = create_mcp(service, settings)
    mcp_app = mcp.streamable_http_app()

    @asynccontextmanager
    async def lifespan(app):
        async with notifications.run(service), mcp.session_manager.run():
            yield

    app = FastAPI(title="DogO", version="0.1.0", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
    app.state.auth = auth
    app.state.service = service
    app.state.notifications = notifications
    app.state.settings = settings
    app.state.relay = relay

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse(
            {"error": {"code": error.code, "message": error.message}},
            status_code=error.status,
            headers={"WWW-Authenticate": "Bearer"} if error.status == 401 else None,
        )

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/api/auth/login")
    def login(data: Login):
        return auth.login(data)

    @app.post("/api/auth/refresh")
    def refresh(data: Refresh):
        return auth.refresh(data.refresh_token)

    @app.post("/api/auth/logout")
    def logout(p: Identity):
        return auth.logout(p)

    @app.get("/api/auth/me")
    def me(p: Identity):
        return auth.me(p)

    @app.get("/api/devices")
    def list_devices(p: Identity):
        return [
            {**device, "online": (p.account_id, device["id"]) in relay.hosts}
            for device in service.list_devices(p)
        ]

    @app.post("/api/remote/call")
    async def remote_call(data: RemoteCall, request: Request, p: Identity):
        if len(json.dumps(data.args, ensure_ascii=False).encode()) > 1024 * 1024:
            raise ServiceError(413, "remote_too_large", "Remote request too large")
        devices = await asyncio.to_thread(service.list_devices, p)
        if not any(
            d["id"] == data.device_id and d["active"] and d["kind"] == "desktop" for d in devices
        ):
            raise ServiceError(404, "not_found", "Target device not found")
        value = await relay.call(
            p.account_id, data.device_id, {"method": data.method, "args": data.args}
        )
        # Recheck account/device revocation before releasing the response.
        await asyncio.to_thread(auth.bearer, request.headers.get("authorization"))
        return {"value": value}

    @app.delete("/api/devices/{device_id}")
    def revoke_device(device_id: str, p: Identity):
        return service.revoke_device(p, device_id)

    @app.post("/api/memos", status_code=201)
    def create_memo(data: MemoCreate, p: Identity):
        return service.create_memo(p, data)

    @app.get("/api/memos")
    def list_memos(
        p: Identity,
        project: str | None = None,
        cursor: str = "",
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
        include_deleted: bool = False,
    ):
        return service.list_memos(p, project, cursor, limit, include_deleted)

    @app.get("/api/memos/{memo_id}")
    def get_memo(memo_id: str, p: Identity):
        return service.get_memo(p, memo_id)

    @app.put("/api/memos/{memo_id}")
    def update_memo(memo_id: str, data: MemoUpdate, p: Identity):
        return service.update_memo(p, memo_id, data)

    @app.delete("/api/memos/{memo_id}")
    def delete_memo(memo_id: str, data: MemoDelete, p: Identity):
        return service.delete_memo(p, memo_id, data)

    @app.post("/api/memos/{memo_id}/append")
    def append_memo(memo_id: str, data: MemoAppend, p: Identity):
        return service.append_memo(p, memo_id, data)

    @app.websocket("/api/device/connect")
    async def connect(websocket: WebSocket):
        origin = websocket.headers.get("origin")
        if origin:
            parsed = urlsplit(origin)
            same_host = parsed.scheme in {
                "http",
                "https",
            } and parsed.netloc == websocket.headers.get("host")
            if not same_host and origin not in settings.allowed_origins:
                await websocket.close(code=4403)
                return
        await websocket.accept()
        receive_task = wake_task = None
        try:
            authorization = websocket.headers.get("authorization")
            if authorization:
                token = authorization.partition(" ")[2]
                p = await asyncio.to_thread(auth.bearer, authorization)
            else:
                message = await asyncio.wait_for(websocket.receive_json(), timeout=5)
                if not isinstance(message, dict) or message.get("type") != "auth":
                    raise ServiceError(401, "missing_token", "Send an auth message first")
                token = message.get("token")
                if not isinstance(token, str) or len(token) > 8192:
                    raise ServiceError(401, "invalid_token", "Invalid token")
                p = await asyncio.to_thread(auth.authenticate, token)
            await asyncio.to_thread(service.require_consumer, p)
            async with (
                notifications.subscribe(p.account_id, p.device_id) as queue,
                relay.attach(p.account_id, p.device_id),
            ):
                await websocket.send_json({"type": "connected", "device_id": p.device_id})
                last_delivery = None

                async def push_next():
                    nonlocal last_delivery
                    delivery = await asyncio.to_thread(service.next_delivery, p)
                    key = (delivery["id"], delivery["lease_token"]) if delivery else None
                    if delivery and key != last_delivery:
                        await websocket.send_json({"type": "dispatch", "dispatch": delivery})
                    last_delivery = key
                    for frame in relay.drain(p.account_id, p.device_id):
                        await websocket.send_json(frame)

                await push_next()
                receive_task = asyncio.create_task(websocket.receive_json())
                wake_task = asyncio.create_task(queue.get())
                while True:
                    done, _ = await asyncio.wait(
                        [receive_task, wake_task], timeout=20, return_when=asyncio.FIRST_COMPLETED
                    )
                    await asyncio.to_thread(auth.authenticate, token)
                    if not done:
                        await websocket.send_json({"type": "ping"})
                    if receive_task in done:
                        message = receive_task.result()
                        try:
                            if not isinstance(message, dict):
                                raise ServiceError(422, "invalid_message", "Expected an object")
                            if (
                                len(json.dumps(message, ensure_ascii=False).encode())
                                > 2 * 1024 * 1024
                            ):
                                raise ServiceError(
                                    413, "remote_too_large", "Device frame too large"
                                )
                            if message.get("type") == "dispatch.ack":
                                ack = DispatchAck.model_validate(message)
                                await asyncio.to_thread(service.acknowledge, p, ack)
                                await websocket.send_json(
                                    {
                                        "type": "dispatch.acknowledged",
                                        "dispatch_id": ack.dispatch_id,
                                    }
                                )
                            elif message.get("type") == "remote.result":
                                await asyncio.to_thread(service.require_consumer, p)
                                relay.resolve(
                                    p.account_id, p.device_id, RemoteResult.model_validate(message)
                                )
                            elif message.get("type") == "ping":
                                await websocket.send_json({"type": "pong"})
                            elif message.get("type") != "pong":
                                raise ServiceError(422, "invalid_message", "Unknown device message")
                        except ValidationError:
                            await websocket.send_json({"type": "error", "code": "invalid_message"})
                        except ServiceError as error:
                            if error.status in (401, 403):
                                raise
                            await websocket.send_json(
                                {
                                    "type": "error",
                                    "code": error.code,
                                    "message": error.message,
                                }
                            )
                        receive_task = asyncio.create_task(websocket.receive_json())
                    if wake_task in done:
                        wake_task = asyncio.create_task(queue.get())
                    await push_next()
        except WebSocketDisconnect:
            pass
        except (ServiceError, TimeoutError, ValueError):
            await websocket.close(code=4401)
        finally:
            pending = [task for task in (receive_task, wake_task) if task is not None]
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    app.mount("/mcp", MCPAuthentication(mcp_app, auth))
    return app
