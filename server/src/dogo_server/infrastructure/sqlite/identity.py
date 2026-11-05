"""Identity row mapping; transaction lifetime belongs to the unit of work."""

import sqlite3

from dogo_server.domain.errors import DomainError
from dogo_server.domain.identity import Account, Device


def _account(row: sqlite3.Row | None) -> Account | None:
    if row is None:
        return None
    return Account(
        row["id"], row["username"], row["password_hash"], bool(row["active"]), row["created_at"]
    )


def _device(row: sqlite3.Row | None) -> Device | None:
    if row is None:
        return None
    return Device(
        row["id"],
        row["account_id"],
        row["name"],
        row["kind"],
        bool(row["active"]),
        row["token_version"],
        row["refresh_hash"],
        row["refresh_expires_at"],
        row["created_at"],
    )


class SQLiteIdentityRepository:
    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def get_account(self, account_id: str) -> Account | None:
        return _account(
            self.db.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        )

    def find_account(self, username: str) -> Account | None:
        return _account(
            self.db.execute("SELECT * FROM accounts WHERE username=?", (username,)).fetchone()
        )

    def add_account(self, account: Account) -> None:
        try:
            self.db.execute(
                "INSERT INTO accounts(id,username,password_hash,active,created_at) VALUES(?,?,?,?,?)",
                (
                    account.id,
                    account.username,
                    account.password_hash,
                    account.active,
                    account.created_at,
                ),
            )
        except sqlite3.IntegrityError:
            raise DomainError("username_exists", "Username already exists") from None

    def find_device(self, device_id: str) -> Device | None:
        return _device(self.db.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone())

    def get_device(self, device_id: str, account_id: str) -> Device | None:
        return _device(
            self.db.execute(
                "SELECT * FROM devices WHERE id=? AND account_id=?", (device_id, account_id)
            ).fetchone()
        )

    def find_refresh(self, refresh_hash: str) -> Device | None:
        return _device(
            self.db.execute(
                "SELECT * FROM devices WHERE refresh_hash=?", (refresh_hash,)
            ).fetchone()
        )

    def list_devices(self, account_id: str) -> list[Device]:
        return [
            _device(row)
            for row in self.db.execute(
                "SELECT * FROM devices WHERE account_id=? ORDER BY created_at,id", (account_id,)
            )
        ]

    def save_device(self, device: Device) -> None:
        self.db.execute(
            "INSERT INTO devices(id,account_id,name,kind,active,token_version,"
            "refresh_hash,refresh_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,"
            "active=excluded.active,token_version=excluded.token_version,"
            "refresh_hash=excluded.refresh_hash,refresh_expires_at=excluded.refresh_expires_at",
            (
                device.id,
                device.account_id,
                device.name,
                device.kind,
                device.active,
                device.token_version,
                device.refresh_hash,
                device.refresh_expires_at,
                device.created_at,
            ),
        )
