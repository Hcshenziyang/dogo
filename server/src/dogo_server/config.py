import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path("data")
    jwt_secret: str | None = field(default=None, repr=False)
    access_seconds: int = 900
    refresh_seconds: int = 30 * 86400
    scan_seconds: float = 30
    lease_seconds: int = 60
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "[::1]")
    allowed_origins: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            data_dir=Path(os.getenv("DOGO_DATA_DIR", "data")).expanduser(),
            jwt_secret=os.getenv("DOGO_JWT_SECRET"),
            allowed_hosts=tuple(
                value.strip()
                for value in os.getenv("DOGO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]").split(",")
                if value.strip()
            ),
            allowed_origins=tuple(
                value.strip()
                for value in os.getenv("DOGO_ALLOWED_ORIGINS", "").split(",")
                if value.strip()
            ),
        )

    def signing_key(self) -> str:
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.jwt_secret is not None:
            if len(self.jwt_secret) < 32:
                raise ValueError("DOGO_JWT_SECRET must contain at least 32 characters")
            return self.jwt_secret
        path = self.data_dir / "jwt-secret"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            key = path.read_text().strip()
        else:
            key = secrets.token_urlsafe(48)
            with os.fdopen(fd, "w") as output:
                output.write(key + "\n")
        if len(key) < 32:
            raise ValueError("Invalid persisted JWT signing key")
        return key
