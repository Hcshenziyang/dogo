#!/usr/bin/env python3
"""Create a consistent SQLite snapshot and keep the newest 14 snapshots."""

import argparse
import os
import re
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def snapshot(source: Path, directory: Path, keep: int = 14) -> Path:
    if not source.is_file():
        raise FileNotFoundError("DogO memo database is unavailable")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".dogo-memo-", suffix=".tmp", dir=directory)
    os.fchmod(fd, 0o600)
    os.close(fd)
    temporary = Path(temporary)
    try:
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as live:
            with closing(sqlite3.connect(temporary)) as saved:
                live.backup(saved, pages=256, sleep=0.1)
                if saved.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                    raise RuntimeError("Could not finalize the snapshot journal")
                if saved.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise RuntimeError("Snapshot integrity check failed")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        target = directory / f"dogo-memo-{stamp}.sqlite3"
        os.replace(temporary, target)
        files = sorted(
            item
            for item in directory.iterdir()
            if item.is_file()
            and re.fullmatch(r"dogo-memo-\d{8}T\d{12}Z\.sqlite3", item.name)
        )
        for old in files[:-keep]:
            old.unlink()
        return target
    finally:
        for suffix in ("", "-wal", "-shm", "-journal"):
            Path(str(temporary) + suffix).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("/var/lib/dogo-rust/dogo-memo.sqlite3"))
    parser.add_argument("--directory", type=Path, default=Path("/var/backups/dogo-rust"))
    args = parser.parse_args()
    snapshot(args.source, args.directory)
    print("DogO memo database snapshot completed")


if __name__ == "__main__":
    main()
