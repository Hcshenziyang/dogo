"""Bounded online forwarding; no conversation storage or offline remote-call queue."""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from uuid import uuid4

from .errors import ServiceError


@dataclass
class Pending:
    target: tuple[str, str]
    future: asyncio.Future


class RemoteRelay:
    def __init__(self, wake):
        self.wake = wake
        self.hosts: dict[tuple[str, str], asyncio.Queue] = {}
        self.pending: dict[str, Pending] = {}

    @asynccontextmanager
    async def attach(self, account: str, device: str):
        key = (account, device)
        if key in self.hosts:
            raise ServiceError(409, "device_connected", "Device already connected")
        self.hosts[key] = asyncio.Queue(maxsize=16)
        try:
            yield
        finally:
            self.hosts.pop(key, None)
            for request in tuple(self.pending.values()):
                if request.target == key and not request.future.done():
                    request.future.set_exception(
                        ServiceError(
                            409, "host_disconnected", "Host disconnected; result may be unknown"
                        )
                    )

    def drain(self, account: str, device: str):
        queue = self.hosts[(account, device)]
        while not queue.empty():
            frame = queue.get_nowait()
            if frame["id"] in self.pending:
                yield frame

    async def call(self, account: str, device: str, call: dict):
        key = (account, device)
        queue = self.hosts.get(key)
        if queue is None:
            raise ServiceError(409, "host_offline", "Target device is offline")
        if len(self.pending) >= 128 or queue.full():
            raise ServiceError(429, "remote_busy", "Too many remote calls")
        if sum(p.target == key for p in self.pending.values()) >= 16:
            raise ServiceError(429, "remote_busy", "Too many calls for this device")
        request_id = str(uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = Pending(key, future)
        try:
            queue.put_nowait({"type": "remote.call", "id": request_id, "call": call})
            self.wake(account, device)
            try:
                return await asyncio.wait_for(future, timeout=12)
            except TimeoutError:
                raise ServiceError(
                    504,
                    "remote_timeout",
                    "Result unknown; retry mutations with the same request ID",
                ) from None
        finally:
            self.pending.pop(request_id, None)

    def resolve(self, account: str, device: str, message):
        request = self.pending.get(message.id)
        if request is None:
            return
        if request.target != (account, device):
            raise ServiceError(403, "wrong_remote_peer", "Response belongs to another device")
        if request.future.done():
            return
        if message.ok:
            request.future.set_result(message.value)
        else:
            request.future.set_exception(
                ServiceError(409, "native_error", message.error or "DSH request failed")
            )
