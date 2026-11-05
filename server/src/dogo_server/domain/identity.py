"""Account and device login state, independent of transport and persistence."""

from dataclasses import dataclass

from .errors import DomainError


@dataclass(frozen=True)
class Principal:
    account_id: str
    device_id: str
    token_version: int


@dataclass(frozen=True)
class Account:
    id: str
    username: str
    password_hash: str
    active: bool
    created_at: int

    @staticmethod
    def normalize_username(username: str, password: str) -> str:
        username = username.strip().casefold()
        if not username or len(username) > 100 or not 10 <= len(password) <= 256:
            raise DomainError("invalid_account", "Username or password length is invalid")
        return username


@dataclass
class Device:
    id: str
    account_id: str
    name: str
    kind: str
    active: bool
    token_version: int
    refresh_hash: str | None
    refresh_expires_at: int | None
    created_at: int

    @property
    def principal(self) -> Principal:
        return Principal(self.account_id, self.id, self.token_version)

    def relogin(
        self, account_id: str, name: str, kind: str, refresh_hash: str, expires_at: int
    ) -> None:
        if self.account_id != account_id:
            raise DomainError("device_id_in_use", "Choose a different device ID")
        self.name = name
        self.kind = kind
        self.active = True
        self.token_version += 1
        self.refresh_hash = refresh_hash
        self.refresh_expires_at = expires_at

    def login_is_live(self, now: int) -> bool:
        return self.active and self.refresh_expires_at is not None and self.refresh_expires_at > now

    def rotate_refresh(self, replacement_hash: str, now: int) -> None:
        if not self.login_is_live(now) or self.refresh_hash is None:
            raise DomainError("invalid_refresh", "Refresh token expired or revoked")
        # Rotation never extends the original login's refresh deadline.
        self.refresh_hash = replacement_hash

    def logout(self, token_version: int) -> None:
        if self.token_version == token_version:
            self._clear_login()

    def revoke(self) -> None:
        self.active = False
        self._clear_login()

    def _clear_login(self) -> None:
        self.token_version += 1
        self.refresh_hash = None
        self.refresh_expires_at = None

    def require_dispatch_target(self) -> None:
        if not self.active or self.kind != "desktop":
            raise DomainError("device_unavailable", "Target must be an active desktop device")

    def require_consumer(self) -> None:
        if not self.active or self.kind != "desktop":
            raise DomainError("execution_device_required", "An active desktop device is required")
