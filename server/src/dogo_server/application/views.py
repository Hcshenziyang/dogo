"""Explicit application projections: never serialize persistence rows or secrets."""

from dataclasses import asdict

from dogo_server.domain.delivery import Dispatch
from dogo_server.domain.memos import Memo


def dispatch_summary(dispatch: Dispatch) -> dict:
    result = {
        "id": dispatch.id,
        "instruction": dispatch.content.instruction,
        "target_device_id": dispatch.content.target_device_id,
        "status": dispatch.status.value,
        "memo_revision": dispatch.content.memo_revision,
        "native_session_id": dispatch.native_session_id,
        "accepted_at": dispatch.accepted_at,
    }
    if dispatch.plan_id:
        result.update(plan_id=dispatch.plan_id, scheduled_for=dispatch.scheduled_for)
    return result


def memo_view(memo: Memo, dispatch: Dispatch | None) -> dict:
    result = {
        "id": memo.id,
        "account_id": memo.account_id,
        "project": memo.fields.project,
        "request_id": memo.request_id,
        "content": memo.fields.content,
        "category": memo.fields.category,
        "tags": list(memo.fields.tags),
        "active": memo.fields.active,
        "created_device_id": memo.created_device_id,
        "revision": memo.revision,
        "created_at": memo.created_at,
        "updated_at": memo.updated_at,
        "deleted_at": memo.deleted_at,
        "dispatch": dispatch_summary(dispatch) if dispatch else None,
    }
    if memo.plan:
        result.update(
            plan={"id": memo.plan.id, **asdict(memo.plan.config)}, next_run_at=memo.next_run_at
        )
    return result


def delivery_view(dispatch: Dispatch, *, lease: bool = False) -> dict:
    content = dispatch.content
    result = {
        "id": dispatch.id,
        "account_id": dispatch.account_id,
        "memo_id": content.memo_id,
        "memo_revision": content.memo_revision,
        "request_id": dispatch.request_id,
        "project": content.project,
        "content_snapshot": content.content_snapshot,
        "instruction": content.instruction,
        "target_device_id": content.target_device_id,
        "status": dispatch.status.value,
        "lease_until": dispatch.lease_until,
        "attempts": dispatch.attempts,
        "created_at": dispatch.created_at,
        "accepted_at": dispatch.accepted_at,
        "native_session_id": dispatch.native_session_id,
        "session_mode": "new",
    }
    if lease:
        result["lease_token"] = dispatch.lease_token
    return result
