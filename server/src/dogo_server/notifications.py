import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from .errors import ServiceError

logger = logging.getLogger(__name__)


class Notifications:
    """Coalesced wakeups only. Durable work remains in SQLite."""

    def __init__(self, interval: float):
        self.interval = interval
        self.connections: dict[tuple[str, str], asyncio.Queue] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    def wake(self, account_id: str, device_id: str) -> None:
        loop = self.loop
        if loop and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._signal, (account_id, device_id))
            except RuntimeError:
                # Shutdown can race a committed write; reconnection will query SQLite.
                pass

    def _signal(self, key: tuple[str, str]) -> None:
        queue = self.connections.get(key)
        if queue is not None and queue.empty():
            queue.put_nowait(True)

    @asynccontextmanager
    async def subscribe(self, account_id: str, device_id: str):
        key = (account_id, device_id)
        if key in self.connections:
            raise ServiceError(409, "device_connected", "Device already has an active connection")
        queue = asyncio.Queue(maxsize=1)
        self.connections[key] = queue
        try:
            yield queue
        finally:
            self.connections.pop(key, None)

    async def sweep(self, service) -> None:
        while True:
            await asyncio.sleep(self.interval)
            for key in tuple(self.connections):
                try:
                    if await asyncio.to_thread(service.has_pending, *key):
                        self._signal(key)
                except Exception:
                    logger.exception("Pending delivery check failed; next sweep will retry")

    @asynccontextmanager
    async def run(self, service):
        self.loop = asyncio.get_running_loop()
        task = asyncio.create_task(self.sweep(service), name="dogo-delivery-sweep")
        try:
            yield
        finally:
            self.loop = None
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
