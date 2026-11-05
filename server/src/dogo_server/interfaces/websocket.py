import asyncio
import json
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from ..application.remote_ports import RemoteResponse
from ..domain.errors import DomainError
from .commands import dispatch_ack
from .errors import http_status
from .schemas import DispatchAck, RemoteResult

router = APIRouter()


@router.websocket("/api/device/connect")
async def connect(websocket: WebSocket):
    container = websocket.app.state.container
    auth = container.identity
    deliveries = container.deliveries
    notifications = container.notifications
    relay = container.relay
    settings = container.settings
    origin = websocket.headers.get("origin")
    if origin:
        parsed = urlsplit(origin)
        same_host = parsed.scheme in {"http", "https"} and parsed.netloc == websocket.headers.get(
            "host"
        )
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
                raise DomainError("missing_token", "Send an auth message first")
            token = message.get("token")
            if not isinstance(token, str) or len(token) > 8192:
                raise DomainError("invalid_token", "Invalid token")
            p = await asyncio.to_thread(auth.authenticate, token)
        await asyncio.to_thread(auth.require_consumer, p)
        async with (
            notifications.subscribe(p.account_id, p.device_id) as queue,
            relay.attach(p.account_id, p.device_id),
        ):
            await websocket.send_json({"type": "connected", "device_id": p.device_id})
            last_delivery = None

            async def push_next():
                nonlocal last_delivery
                await asyncio.to_thread(container.scheduler.tick, p.account_id, p.device_id)
                delivery = await asyncio.to_thread(deliveries.next_delivery, p)
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
                            raise DomainError("invalid_message", "Expected an object")
                        if len(json.dumps(message, ensure_ascii=False).encode()) > 2 * 1024 * 1024:
                            raise DomainError("remote_too_large", "Device frame too large")
                        if message.get("type") == "dispatch.ack":
                            ack = DispatchAck.model_validate(message)
                            await asyncio.to_thread(deliveries.acknowledge, p, dispatch_ack(ack))
                            await websocket.send_json(
                                {"type": "dispatch.acknowledged", "dispatch_id": ack.dispatch_id}
                            )
                        elif message.get("type") == "remote.result":
                            await asyncio.to_thread(auth.require_consumer, p)
                            result = RemoteResult.model_validate(message)
                            relay.resolve(
                                p.account_id, p.device_id, RemoteResponse(**result.model_dump())
                            )
                        elif message.get("type") == "ping":
                            await websocket.send_json({"type": "pong"})
                        elif message.get("type") != "pong":
                            raise DomainError("invalid_message", "Unknown device message")
                    except ValidationError:
                        await websocket.send_json({"type": "error", "code": "invalid_message"})
                    except DomainError as error:
                        if http_status(error) in (401, 403):
                            raise
                        await websocket.send_json(
                            {"type": "error", "code": error.code, "message": error.message}
                        )
                    receive_task = asyncio.create_task(websocket.receive_json())
                if wake_task in done:
                    wake_task = asyncio.create_task(queue.get())
                await push_next()
    except WebSocketDisconnect:
        pass
    except (DomainError, TimeoutError, ValueError):
        await websocket.close(code=4401)
    finally:
        pending = [task for task in (receive_task, wake_task) if task is not None]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
