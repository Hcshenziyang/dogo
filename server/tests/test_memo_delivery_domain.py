"""Business invariants without a database, HTTP server, or clock dependency."""

from dataclasses import replace

import pytest

from dogo_server.domain.delivery import Dispatch, DispatchContent, DispatchStatus
from dogo_server.domain.errors import DomainError
from dogo_server.domain.memos import Memo, MemoFields


def memo():
    return Memo("m", "a", "request", "digest", MemoFields("original"), "phone", 10, 10)


def dispatch():
    return Dispatch(
        "d",
        "a",
        "request",
        "digest",
        DispatchContent("m", 1, "project", "original", "process", "desktop"),
        10,
    )


def test_failed_memo_edits_leave_content_and_revision_unchanged():
    value = memo()
    before = replace(value)
    with pytest.raises(DomainError, match="Read the latest version"):
        value.update(MemoFields("replacement"), 2, 20)
    assert value == before
    with pytest.raises(DomainError, match="Combined content exceeds"):
        value.append("x" * 256_000, 1, 20)
    assert value == before
    value.append(" addition", 1, 20)
    assert (value.fields.content, value.revision, value.updated_at) == ("original addition", 2, 20)


def test_deleted_memo_stays_readable_but_cannot_be_changed():
    value = memo()
    value.delete(1, 20)
    assert (value.deleted_at, value.revision, value.fields.active) == (20, 2, False)
    assert value.fields.content == "original"
    for action in (
        lambda: value.append("again", 2, 30),
        lambda: value.update(MemoFields("again"), 2, 30),
        lambda: value.delete(2, 30),
    ):
        with pytest.raises(DomainError) as error:
            action()
        assert error.value.code == "memo_deleted"


def test_receipt_window_resume_expiry_and_duplicate_acceptance():
    value = dispatch()
    value.lease(20, 10, "first")
    value.lease(29, 10, "unused")
    assert (value.lease_token, value.attempts) == ("first", 1)
    value.lease(30, 10, "second")
    assert (value.lease_token, value.attempts) == ("second", 2)
    for device, token, code in (
        ("other", "second", "not_found"),
        ("desktop", "first", "lease_mismatch"),
    ):
        with pytest.raises(DomainError) as error:
            value.acknowledge(device, token, "session", 31)
        assert error.value.code == code
    value.acknowledge("desktop", "second", "session", 31)
    before = replace(value)
    value.acknowledge("desktop", "first", "session", 50)
    assert value == before
    assert value.status == DispatchStatus.ACCEPTED
    assert value.lease_token is None and value.lease_until is None
    with pytest.raises(DomainError):
        value.acknowledge("desktop", "second", "different-session", 51)


def test_deletion_cancels_pending_but_never_recalls_sent_work():
    pending = dispatch()
    pending.cancel_before_memo_deletion()
    assert pending.status == DispatchStatus.CANCELLED
    with pytest.raises(DomainError):
        pending.lease(20, 10, "token")
    sent = dispatch()
    sent.lease(20, 10, "token")
    with pytest.raises(DomainError) as error:
        sent.cancel_before_memo_deletion()
    assert error.value.code == "dispatch_in_flight"
    sent.acknowledge("desktop", "token", "session", 31)
    sent.cancel_before_memo_deletion()
    assert sent.status == DispatchStatus.ACCEPTED
