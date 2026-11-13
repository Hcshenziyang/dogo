"""Transactional access to identity data."""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from .database import Database
from .identity import SQLiteIdentityRepository


@dataclass
class SQLiteUnitOfWork:
    identities: SQLiteIdentityRepository


class SQLiteUnitOfWorkFactory:
    def __init__(self, database: Database):
        self.database = database

    @contextmanager
    def __call__(self, *, write: bool = False) -> Iterator[SQLiteUnitOfWork]:
        # BEGIN IMMEDIATE serializes the read/check/write sequence. Repositories
        # never commit individually; any exception rolls back every participating aggregate.
        with self.database.connect(write=write) as connection:
            if not write:
                # All repositories in a read use case observe the same snapshot.
                connection.execute("PRAGMA query_only=ON")
                connection.execute("BEGIN")
            yield SQLiteUnitOfWork(
                SQLiteIdentityRepository(connection),
            )
