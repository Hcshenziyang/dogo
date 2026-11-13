"""Identity database and removal of the legacy memo/dispatch tables."""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('desktop', 'mobile')),
    active INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    refresh_hash TEXT UNIQUE,
    refresh_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(account_id, id)
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path

    @staticmethod
    def _check_schema(db, version: int) -> None:
        tables = {
            row[0]
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        if version == 0 and not tables:
            return
        required = {
            "accounts": {"id", "username", "password_hash", "active", "created_at"},
            "devices": {
                "id",
                "account_id",
                "name",
                "kind",
                "active",
                "token_version",
                "refresh_hash",
                "refresh_expires_at",
                "created_at",
            },
        }
        if version in (2, 3):
            required.update(
                {
                    "memos": {
                        "id",
                        "account_id",
                        "request_id",
                        "content",
                        "revision",
                        "deleted_at",
                    },
                    "dispatches": {"id", "account_id", "memo_id", "content_snapshot", "status"},
                }
            )
        if version not in (2, 3, 4) or not required.keys() <= tables:
            raise RuntimeError(
                "Unsupported database schema; existing data is not migrated or deleted."
            )
        for table, columns in required.items():
            actual = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
            if not columns <= actual:
                raise RuntimeError(
                    "Unsupported database schema; existing data is not migrated or deleted."
                )
        if version == 4 and ({"memos", "dispatches"} & tables):
            raise RuntimeError(
                "Unexpected legacy tables in v4 database; existing data is not deleted."
            )

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            self._check_schema(db, db.execute("PRAGMA user_version").fetchone()[0])
            db.execute("PRAGMA journal_mode=WAL")
        with self.connect(write=True) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            self._check_schema(db, version)
            if version == 0:
                for statement in SCHEMA.split(";"):
                    if statement.strip():
                        db.execute(statement)
            elif version in (2, 3):
                # Child first because dispatches reference memos. Accounts/devices stay intact.
                db.execute("DROP TABLE dispatches")
                db.execute("DROP TABLE memos")
            db.execute("PRAGMA user_version=4")

    @contextmanager
    def connect(self, *, write: bool = False):
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA secure_delete=ON")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.commit()
        except BaseException:
            if write:
                db.rollback()
            raise
        finally:
            db.close()
