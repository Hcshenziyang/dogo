"""Identity use cases; adapters supply transactions, crypto and nondeterminism."""

from collections.abc import Callable
from dataclasses import dataclass

from dogo_server.domain.errors import DomainError
from dogo_server.domain.identity import Account, Device, Principal

from .identity_ports import IdentityCrypto, UnitOfWorkFactory


@dataclass(frozen=True)
class LoginCommand:
    username: str
    password: str
    device_id: str
    device_name: str
    device_kind: str = "desktop"


class IdentityService:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        crypto: IdentityCrypto,
        *,
        access_seconds: int,
        refresh_seconds: int,
        clock: Callable[[], float],
        new_id: Callable[[], str],
        new_token: Callable[[], str],
        notify: Callable[[str, str], None] = lambda *_: None,
    ):
        self.uow = uow
        self.crypto = crypto
        self.access_seconds = access_seconds
        self.refresh_seconds = refresh_seconds
        self.clock = clock
        self.new_id = new_id
        self.new_token = new_token
        self.notify = notify

    def create_account(self, username: str, password: str) -> dict:
        username = Account.normalize_username(username, password)
        password_hash = self.crypto.hash_password(password)
        account = Account(self.new_id(), username, password_hash, True, int(self.clock() * 1000))
        with self.uow(write=True) as uow:
            uow.identities.add_account(account)
        return {"id": account.id, "username": account.username}

    def access_token(self, principal: Principal) -> str:
        return self.crypto.encode_access(principal, int(self.clock()))

    def tokens(self, principal: Principal, refresh_token: str) -> dict:
        return {
            "access_token": self.access_token(principal),
            "refresh_token": refresh_token,
            "device_id": principal.device_id,
            "token_type": "bearer",
            "expires_in": self.access_seconds,
        }

    def login(self, data: LoginCommand) -> dict:
        with self.uow() as uow:
            account = uow.identities.find_account(data.username.strip().casefold())
        valid = self.crypto.verify_password(
            data.password, account.password_hash if account else None
        )
        if not account or not account.active or not valid:
            raise DomainError("invalid_credentials", "Invalid username or password")
        refresh = self.new_token()
        with self.uow(write=True) as uow:
            device = uow.identities.find_device(data.device_id)
            refresh_hash = self.crypto.hash_token(refresh)
            expires_at = int(self.clock()) + self.refresh_seconds
            if device:
                device.relogin(
                    account.id, data.device_name, data.device_kind, refresh_hash, expires_at
                )
            else:
                device = Device(
                    data.device_id,
                    account.id,
                    data.device_name,
                    data.device_kind,
                    True,
                    1,
                    refresh_hash,
                    expires_at,
                    int(self.clock() * 1000),
                )
            uow.identities.save_device(device)
        return self.tokens(device.principal, refresh)

    def refresh(self, token: str) -> dict:
        replacement = self.new_token()
        with self.uow(write=True) as uow:
            device = uow.identities.find_refresh(self.crypto.hash_token(token))
            account = uow.identities.get_account(device.account_id) if device else None
            if not device or not account or not account.active:
                raise DomainError("invalid_refresh", "Refresh token expired or revoked")
            device.rotate_refresh(self.crypto.hash_token(replacement), int(self.clock()))
            uow.identities.save_device(device)
        return self.tokens(device.principal, replacement)

    def authenticate(self, token: str) -> Principal:
        principal = self.crypto.decode_access(token)
        with self.uow() as uow:
            device = uow.identities.get_device(principal.device_id, principal.account_id)
            account = uow.identities.get_account(principal.account_id)
        if (
            not device
            or not account
            or not account.active
            or not device.login_is_live(int(self.clock()))
            or device.token_version != principal.token_version
        ):
            raise DomainError("revoked_token", "Device login expired or revoked")
        return principal

    def bearer(self, authorization: str | None) -> Principal:
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not token or len(token) > 8192:
            raise DomainError("missing_token", "Bearer authentication required")
        return self.authenticate(token)

    def logout(self, principal: Principal) -> dict:
        with self.uow(write=True) as uow:
            device = uow.identities.get_device(principal.device_id, principal.account_id)
            if device and device.token_version == principal.token_version:
                device.logout(principal.token_version)
                uow.identities.save_device(device)
        return {"logged_out": True}

    def me(self, principal: Principal) -> dict:
        with self.uow() as uow:
            account = uow.identities.get_account(principal.account_id)
        return {"id": account.id, "username": account.username}

    def list_devices(self, p: Principal) -> list[dict]:
        with self.uow() as uow:
            devices = uow.identities.list_devices(p.account_id)
        return [
            {
                "id": d.id,
                "account_id": d.account_id,
                "name": d.name,
                "kind": d.kind,
                "active": d.active,
                "created_at": d.created_at,
            }
            for d in devices
        ]

    def revoke_device(self, p: Principal, device_id: str) -> dict:
        with self.uow(write=True) as uow:
            device = uow.identities.get_device(device_id, p.account_id)
            if not device:
                raise DomainError("not_found", "Record not found")
            device.revoke()
            uow.identities.save_device(device)
        self.notify(p.account_id, device_id)
        return {"revoked": True}

    def require_consumer(self, p: Principal) -> None:
        if not p.device_id:
            raise DomainError("device_token_required", "A device-bound token is required")
        with self.uow() as uow:
            device = uow.identities.get_device(p.device_id, p.account_id)
        if not device:
            raise DomainError("not_found", "Record not found")
        device.require_consumer()
