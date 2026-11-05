"""Online forwarding authorization and orchestration, independent of transports."""

import asyncio

from ..domain.errors import DomainError
from ..domain.identity import Principal
from .remote_ports import RemoteGateway, RemoteIdentity


class RemoteService:
    def __init__(self, identity: RemoteIdentity, relay: RemoteGateway):
        self.identity = identity
        self.relay = relay

    async def list_devices(self, p: Principal) -> list[dict]:
        devices = await asyncio.to_thread(self.identity.list_devices, p)
        return [
            {**device, "online": self.relay.is_online(p.account_id, device["id"])}
            for device in devices
        ]

    async def call(
        self,
        p: Principal,
        device_id: str,
        method: str,
        args: dict,
        authorization: str | None,
    ) -> object:
        devices = await asyncio.to_thread(self.identity.list_devices, p)
        if not any(
            d["id"] == device_id and d["active"] and d["kind"] == "desktop" for d in devices
        ):
            raise DomainError("not_found", "Target device not found")
        value = await self.relay.call(p.account_id, device_id, {"method": method, "args": args})
        # Recheck account/device revocation before releasing the response.
        await asyncio.to_thread(self.identity.bearer, authorization)
        return value
