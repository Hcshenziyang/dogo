import sqlite3

import pytest

from dogo_server.db import Database


def test_database_contains_only_four_business_tables(app):
    with app.state.service.db.connect() as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert tables == {"accounts", "devices", "memos", "dispatches"}


def test_previous_schema_is_rejected_without_changing_data(tmp_path):
    path = tmp_path / "old.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE preserved (value TEXT)")
        db.execute("INSERT INTO preserved VALUES ('synthetic-original')")
        db.execute("PRAGMA user_version=1")
    with pytest.raises(RuntimeError, match="not migrated or deleted"):
        Database(path).initialize()
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT value FROM preserved").fetchone()[0] == "synthetic-original"
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
        assert db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [
            ("preserved",)
        ]
