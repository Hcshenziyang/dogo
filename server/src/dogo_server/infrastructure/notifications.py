import asyncio
from contextlib import asynccontextmanager

from ..domain.errors import DomainError


class Notifications:
    """Coalesced wakeups for active device connections."""

    def __init__(self):
        self.connections: dict[tuple[str, str], asyncio.Queue] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    def wake(self, account_id: str, device_id: str) -> None:
        loop = self.loop
        if loop and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._signal, (account_id, device_id))
            except RuntimeError:
                # Shutdown can race a notification.
                pass

    def _signal(self, key: tuple[str, str]) -> None:
        queue = self.connections.get(key)
        if queue is not None and queue.empty():
            queue.put_nowait(True)

    @asynccontextmanager
    async def subscribe(self, account_id: str, device_id: str):
        key = (account_id, device_id)
        if key in self.connections:
            raise DomainError("device_connected", "Device already has an active connection")
        queue = asyncio.Queue(maxsize=1)
        self.connections[key] = queue
        try:
            yield queue
        finally:
            self.connections.pop(key, None)

    @asynccontextmanager
    async def run(self):
        self.loop = asyncio.get_running_loop()
        try:
            yield
        finally:
            self.loop = None
