"""Plan changes and due dispatches share the same business transactions as memos."""

import hashlib
from collections.abc import Callable
from dataclasses import replace

from dogo_server.domain.delivery import Dispatch, DispatchContent, DispatchStatus
from dogo_server.domain.errors import DomainError
from dogo_server.domain.memos import Memo
from dogo_server.domain.plans import ExecutionPlan, PlanConfig

from .ports import UnitOfWork, UnitOfWorkFactory


def configure_plan(
    uow: UnitOfWork,
    memo: Memo,
    config: PlanConfig | None,
    *,
    now: int,
    new_id: Callable[[], str],
    active_changed: bool = False,
) -> None:
    current = memo.plan
    if (current.config if current else None) == config and not active_changed:
        return
    if not current and not config:
        return
    if config:
        target = uow.identities.get_device(config.target_device_id, memo.account_id)
        if target is None:
            raise DomainError("not_found", "Record not found")
        if config.enabled and memo.fields.active:
            target.require_dispatch_target()
    pause_only = current is not None and config == replace(current.config, enabled=False)
    inactive_only = current is not None and config == current.config and not memo.fields.active
    deliveries = (
        [
            d
            for d in uow.dispatches.open_for_memo(memo.account_id, memo.id)
            if d.plan_id == current.id
        ]
        if current
        else []
    )
    for dispatch in deliveries:
        if dispatch.status == DispatchStatus.LEASED and not (pause_only or inactive_only):
            raise DomainError("dispatch_in_flight", "Wait for receipt before changing the plan")
        if dispatch.status == DispatchStatus.PENDING:
            dispatch.cancel_before_memo_deletion()
            uow.dispatches.save(dispatch)
    if pause_only or inactive_only:
        memo.plan = ExecutionPlan(current.id, config)
    else:
        memo.plan = ExecutionPlan(new_id(), config) if config else None
    # A once-only occurrence received during a pause is already consumed. Resuming
    # an unchanged rule must not run it again; explicitly changing its time may.
    already_received = bool(
        current
        and config
        and config.mode == "once"
        and config.enabled
        and config == replace(current.config, enabled=True)
        and uow.dispatches.accepted_for_plan(memo.account_id, current.id)
    )
    if already_received:
        memo.plan = ExecutionPlan(current.id, config)
    memo.next_run_at = (
        config.first_run(now) if config and memo.fields.active and not already_received else None
    )


class ScheduleService:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        *,
        clock: Callable[[], int],
        new_id: Callable[[], str],
        notify: Callable[[str, str], None],
    ):
        self.uow, self.clock, self.new_id, self.notify = uow, clock, new_id, notify

    def tick(self, account_id: str | None = None, device_id: str | None = None) -> int:
        wakeups = []
        now = self.clock()
        with self.uow(write=True) as uow:
            for memo in uow.memos.due(now, account_id, device_id):
                plan = memo.plan
                if plan is None or not plan.config.enabled:
                    continue
                scheduled_for = memo.next_run_at
                request = f"schedule:{plan.id}:{scheduled_for}"
                uow.dispatches.add(
                    Dispatch(
                        id=self.new_id(),
                        account_id=memo.account_id,
                        request_id=request,
                        request_hash=hashlib.sha256(request.encode()).hexdigest(),
                        content=DispatchContent(
                            memo.id,
                            memo.revision,
                            memo.fields.project,
                            memo.fields.content,
                            plan.config.instruction,
                            plan.config.target_device_id,
                        ),
                        created_at=now,
                        plan_id=plan.id,
                        scheduled_for=scheduled_for,
                    )
                )
                # A persisted pending/leased dispatch is the only outstanding occurrence.
                # Its first receipt, not another timer tick, determines the next calendar time.
                memo.next_run_at = None
                uow.memos.save(memo)
                wakeups.append((memo.account_id, plan.config.target_device_id))
        for key in wakeups:
            self.notify(*key)
        return len(wakeups)


def advance_after_receipt(uow: UnitOfWork, dispatch: Dispatch, now: int) -> None:
    if not dispatch.plan_id:
        return
    memo = uow.memos.get(dispatch.account_id, dispatch.content.memo_id)
    if memo and memo.plan and memo.plan.id == dispatch.plan_id:
        config = memo.plan.config
        memo.next_run_at = (
            config.next_after(now)
            if config.enabled and memo.fields.active and memo.deleted_at is None
            else None
        )
        uow.memos.save(memo)
