"""Transaction boundaries spanning aggregates and repository adapters."""

import sqlite3
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from conftest import device, queued_memo

from dogo_server.application.commands import DispatchInstruction, MemoCreate
from dogo_server.application.memos import MemoService
from dogo_server.domain.errors import DomainError
from dogo_server.infrastructure.sqlite.repositories import SQLiteDispatchRepository


def test_dispatch_write_failure_rolls_back_memo_and_emits_no_wakeup(
    app, headers, client, monkeypatch
):
    container = app.state.container
    target, _ = device(client, headers)
    owner = container.identity.bearer(headers["Authorization"])
    notifications = []
    service = MemoService(
        container.uow,
        clock=lambda: 100,
        new_id=lambda: "synthetic-id",
        notify=lambda *args: notifications.append(args),
    )

    def fail_after_insert(repository, dispatch):
        original(repository, dispatch)
        raise RuntimeError("synthetic persistence failure")

    original = SQLiteDispatchRepository.add
    monkeypatch.setattr(SQLiteDispatchRepository, "add", fail_after_insert)
    with pytest.raises(RuntimeError, match="synthetic persistence failure"):
        service.create_memo(
            owner,
            MemoCreate(
                request_id="rollback",
                content="keep atomic",
                dispatch=DispatchInstruction(instruction="process", target_device_id=target["id"]),
            ),
        )
    with container.database.connect() as db:
        assert db.execute("SELECT count(*) FROM memos").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM dispatches").fetchone()[0] == 0
    assert notifications == []


def test_wakeup_observes_committed_memo_and_delivery(app, headers, client):
    container = app.state.container
    target, _ = device(client, headers)
    owner = container.identity.bearer(headers["Authorization"])
    observed = []

    def notify(account, device_id):
        with container.database.connect() as db:
            observed.append(
                tuple(
                    db.execute(
                        "SELECT m.content,d.status FROM memos m JOIN dispatches d ON m.id=d.memo_id "
                        "WHERE m.account_id=? AND d.target_device_id=?",
                        (account, device_id),
                    ).fetchone()
                )
            )

    ids = iter(["memo", "dispatch"])
    service = MemoService(container.uow, clock=lambda: 100, new_id=lambda: next(ids), notify=notify)
    service.create_memo(
        owner,
        MemoCreate(
            request_id="commit",
            content="visible",
            dispatch=DispatchInstruction(instruction="process", target_device_id=target["id"]),
        ),
    )
    assert observed == [("visible", "pending")]


def test_read_uow_has_one_consistent_snapshot_and_cannot_write(app, client, headers):
    container = app.state.container
    target, _ = device(client, headers)
    memo = queued_memo(client, headers, target["id"]).json()
    with container.uow() as reading:
        assert reading.memos.get(memo["account_id"], memo["id"]).revision == 1
        with container.uow(write=True) as writing:
            changed = writing.memos.get(memo["account_id"], memo["id"])
            changed.append(" updated", 1, 200)
            writing.memos.save(changed)
        assert reading.memos.get(memo["account_id"], memo["id"]).revision == 1
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            reading.memos.save(changed)
    with container.uow() as reading:
        assert reading.memos.get(memo["account_id"], memo["id"]).revision == 2


def test_delivery_checks_consumer_inside_its_write_transaction(app):
    container = app.state.container
    state = SimpleNamespace(writing=False)
    from dogo_server.domain.identity import Principal

    class Identities:
        def get_device(self, *_):
            assert state.writing
            return None

    @contextmanager
    def uow(*, write=False):
        state.writing = write
        try:
            yield SimpleNamespace(identities=Identities())
        finally:
            state.writing = False

    container.deliveries.uow = uow
    with pytest.raises(DomainError) as error:
        container.deliveries.next_delivery(Principal("account", "revoked", 1))
    assert error.value.code == "not_found"
