import sqlite3
from pathlib import Path

import pytest

from dogo_server.infrastructure.sqlite.database import Database


def test_database_contains_only_identity_tables(app):
    with app.state.container.database.connect() as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4
    assert tables == {"accounts", "devices"}


@pytest.mark.parametrize("version", [2, 3])
def test_migration_removes_memos_and_dispatches_but_preserves_identity(tmp_path, version):
    path = tmp_path / "old.sqlite"
    fixture = Path(__file__).parent / "fixtures" / "v2.sql"
    with sqlite3.connect(path) as db:
        db.executescript(fixture.read_text())
        if version == 3:
            db.executescript("""
                ALTER TABLE memos ADD COLUMN plan TEXT;
                ALTER TABLE memos ADD COLUMN next_run_at INTEGER;
                ALTER TABLE dispatches ADD COLUMN plan_id TEXT;
                ALTER TABLE dispatches ADD COLUMN scheduled_for INTEGER;
                PRAGMA user_version=3;
            """)
        db.execute("INSERT INTO accounts VALUES ('a', 'synthetic-user', 'hash', 1, 10)")
        db.execute(
            "INSERT INTO devices VALUES ('d', 'a', 'Device', 'desktop', 1, 1, NULL, NULL, 10)"
        )
        db.execute("""INSERT INTO memos
            (id,account_id,request_id,request_hash,content,category,tags,active,created_at,updated_at)
            VALUES ('m','a','r','h','synthetic memo','','[]',1,10,10)""")
        db.execute("""INSERT INTO dispatches
            (id,account_id,memo_id,memo_revision,request_id,request_hash,content_snapshot,
             instruction,target_device_id,created_at)
            VALUES ('q','a','m',1,'r','h','synthetic memo','test','d',10)""")
    database = Database(path)
    database.initialize()
    database.initialize()
    with sqlite3.connect(path) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert tables == {"accounts", "devices"}
        assert db.execute("SELECT username FROM accounts").fetchone()[0] == "synthetic-user"
        assert db.execute("SELECT id FROM devices").fetchone()[0] == "d"
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4


@pytest.mark.parametrize("version", [0, 1, 2, 3, 4, 99])
def test_unrelated_schema_is_rejected_without_changing_data(tmp_path, version):
    path = tmp_path / "other.sqlite"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE preserved (value TEXT)")
        db.execute("INSERT INTO preserved VALUES ('synthetic-original')")
        db.execute(f"PRAGMA user_version={version}")
    with pytest.raises(RuntimeError, match="not migrated or deleted"):
        Database(path).initialize()
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT value FROM preserved").fetchone()[0] == "synthetic-original"
        assert db.execute("PRAGMA user_version").fetchone()[0] == version
