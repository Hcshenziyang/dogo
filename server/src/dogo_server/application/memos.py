"""Memo use cases. Coordinate aggregates in one UoW, publish wakeups after commit."""

import hashlib
import json
from collections.abc import Callable
from dataclasses import asdict

from dogo_server.domain.delivery import Dispatch, DispatchContent
from dogo_server.domain.errors import DomainError
from dogo_server.domain.identity import Principal
from dogo_server.domain.memos import Memo, MemoFields

from . import commands
from .ports import UnitOfWork, UnitOfWorkFactory
from .scheduling import configure_plan
from .views import memo_view


def request_digest(value: dict) -> str:
    # Persisted v2 hashes are a compatibility contract, including defaults and null dispatch.
    value = {k: v for k, v in value.items() if not (k == "plan" and v is None)}
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def memo_fields(data: commands.MemoFields) -> MemoFields:
    return MemoFields(data.content, data.project, data.category, tuple(data.tags), data.active)


def require_memo(uow: UnitOfWork, p: Principal, memo_id: str) -> Memo:
    memo = uow.memos.get(p.account_id, memo_id)
    if memo is None:
        raise DomainError("not_found", "Record not found")
    return memo


def project_memo(uow: UnitOfWork, memo: Memo) -> dict:
    return memo_view(memo, uow.dispatches.latest_for_memo(memo.account_id, memo.id))


class MemoService:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        *,
        clock: Callable[[], int],
        new_id: Callable[[], str],
        notify: Callable[[str, str], None],
    ):
        self.uow = uow
        self.clock = clock
        self.new_id = new_id
        self.notify = notify

    def create_memo(self, p: Principal, data: commands.MemoCreate) -> dict:
        if data.plan and data.dispatch:
            raise DomainError("invalid_plan", "Use either a timed plan or immediate dispatch")
        digest = request_digest(asdict(data))
        with self.uow(write=True) as uow:
            memo = uow.memos.find_request(p.account_id, data.request_id)
            if memo is not None:
                memo.check_request(digest)
            else:
                device = uow.identities.get_device(p.device_id, p.account_id)
                if device is None:
                    raise DomainError("not_found", "Record not found")
                if not device.active:
                    raise DomainError("device_revoked", "Device revoked")
                now = self.clock()
                memo = Memo(
                    id=self.new_id(),
                    account_id=p.account_id,
                    request_id=data.request_id,
                    request_hash=digest,
                    fields=memo_fields(data),
                    created_device_id=p.device_id,
                    created_at=now,
                    updated_at=now,
                )
                configure_plan(uow, memo, data.plan, now=now, new_id=self.new_id)
                uow.memos.add(memo)
                if data.dispatch:
                    self._dispatch(uow, memo, data.dispatch)
            result = project_memo(uow, memo)
        if data.dispatch:
            self.notify(p.account_id, data.dispatch.target_device_id)
        return result

    def _dispatch(self, uow: UnitOfWork, memo: Memo, data: commands.DispatchInstruction) -> None:
        memo.require_dispatchable()
        target = uow.identities.get_device(data.target_device_id, memo.account_id)
        if target is None:
            raise DomainError("not_found", "Record not found")
        target.require_dispatch_target()
        digest = request_digest(
            {
                **asdict(data),
                "memo_id": memo.id,
                "memo_revision": memo.revision,
                "request_id": memo.request_id,
            }
        )
        uow.dispatches.add(
            Dispatch(
                id=self.new_id(),
                account_id=memo.account_id,
                request_id=memo.request_id,
                request_hash=digest,
                content=DispatchContent(
                    memo.id,
                    memo.revision,
                    memo.fields.project,
                    memo.fields.content,
                    data.instruction,
                    data.target_device_id,
                ),
                created_at=self.clock(),
            )
        )

    def get_memo(self, p: Principal, memo_id: str) -> dict:
        with self.uow() as uow:
            return project_memo(uow, require_memo(uow, p, memo_id))

    def list_memos(
        self,
        p: Principal,
        project: str | None = None,
        cursor: str = "",
        limit: int = 100,
        include_deleted: bool = False,
    ) -> dict:
        limit = max(1, min(200, limit))
        with self.uow() as uow:
            rows = uow.memos.list(p.account_id, project, cursor, limit + 1, include_deleted)
            return {
                "items": [project_memo(uow, memo) for memo in rows[:limit]],
                "next_cursor": rows[limit - 1].id if len(rows) > limit else None,
            }

    def update_memo(self, p: Principal, memo_id: str, data: commands.MemoUpdate) -> dict:
        with self.uow(write=True) as uow:
            memo = require_memo(uow, p, memo_id)
            was_active = memo.fields.active
            memo.update(memo_fields(data), data.revision, self.clock())
            config = data.plan if data.plan_provided else (memo.plan.config if memo.plan else None)
            configure_plan(
                uow,
                memo,
                config,
                now=self.clock(),
                new_id=self.new_id,
                active_changed=was_active != memo.fields.active,
            )
            uow.memos.save(memo)
            return project_memo(uow, memo)

    def append_memo(self, p: Principal, memo_id: str, data: commands.MemoAppend) -> dict:
        with self.uow(write=True) as uow:
            memo = require_memo(uow, p, memo_id)
            memo.append(data.content, data.revision, self.clock())
            uow.memos.save(memo)
            return project_memo(uow, memo)

    def delete_memo(self, p: Principal, memo_id: str, data: commands.MemoDelete) -> dict:
        with self.uow(write=True) as uow:
            memo = require_memo(uow, p, memo_id)
            memo.check_revision(data.revision)
            # The memo and its deliveries are separate aggregates, but cancellation and
            # deletion must share a write transaction to arbitrate the send/delete race.
            for dispatch in uow.dispatches.open_for_memo(p.account_id, memo_id):
                dispatch.cancel_before_memo_deletion()
                uow.dispatches.save(dispatch)
            memo.delete(data.revision, self.clock())
            memo.plan = None
            memo.next_run_at = None
            uow.memos.save(memo)
            return project_memo(uow, memo)
