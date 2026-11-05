"""Framework-free contracts for online remote calls."""

from dataclasses import dataclass
from typing import Protocol

from ..domain.identity import Principal


@dataclass(frozen=True)
class RemoteResponse:
    id: str
    ok: bool
    value: object = None
    error: str | None = None
    type: str = "remote.result"


class RemoteIdentity(Protocol):
    def list_devices(self, p: Principal) -> list[dict]: ...

    def bearer(self, authorization: str | None) -> Principal: ...


class RemoteGateway(Protocol):
    def is_online(self, account: str, device: str) -> bool: ...

    async def call(self, account: str, device: str, call: dict) -> object: ...
