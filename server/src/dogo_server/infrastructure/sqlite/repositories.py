"""SQLite repositories map rows to aggregates, never implement business transitions."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict

from dogo_server.domain.delivery import Dispatch, DispatchContent, DispatchStatus
from dogo_server.domain.memos import Memo, MemoFields
from dogo_server.domain.plans import ExecutionPlan, PlanConfig


def load_plan(value: str | None) -> ExecutionPlan | None:
    if value is None:
        return None
    data = json.loads(value)
    return ExecutionPlan(data["id"], PlanConfig(**data["config"]))


def plan_json(memo: Memo) -> str | None:
    return json.dumps(asdict(memo.plan), ensure_ascii=False) if memo.plan else None


def load_memo(row: sqlite3.Row) -> Memo:
    return Memo(
        id=row["id"],
        account_id=row["account_id"],
        request_id=row["request_id"],
        request_hash=row["request_hash"],
        fields=MemoFields(
            row["content"],
            row["project"],
            row["category"],
            tuple(json.loads(row["tags"])),
            bool(row["active"]),
        ),
        created_device_id=row["created_device_id"],
        revision=row["revision"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        deleted_at=row["deleted_at"],
        plan=load_plan(row["plan"]),
        next_run_at=row["next_run_at"],
    )


def load_dispatch(row: sqlite3.Row) -> Dispatch:
    return Dispatch(
        id=row["id"],
        account_id=row["account_id"],
        request_id=row["request_id"],
        request_hash=row["request_hash"],
        content=DispatchContent(
            row["memo_id"],
            row["memo_revision"],
            row["project"],
            row["content_snapshot"],
            row["instruction"],
            row["target_device_id"],
        ),
        status=DispatchStatus(row["status"]),
        lease_token=row["lease_token"],
        lease_until=row["lease_until"],
        attempts=row["attempts"],
        created_at=row["created_at"],
        accepted_at=row["accepted_at"],
        native_session_id=row["native_session_id"],
        plan_id=row["plan_id"],
        scheduled_for=row["scheduled_for"],
    )


class SQLiteMemoRepository:
    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def get(self, account_id: str, memo_id: str) -> Memo | None:
        row = self.db.execute(
            "SELECT * FROM memos WHERE id=? AND account_id=?", (memo_id, account_id)
        ).fetchone()
        return load_memo(row) if row else None

    def find_request(self, account_id: str, request_id: str) -> Memo | None:
        row = self.db.execute(
            "SELECT * FROM memos WHERE account_id=? AND request_id=?", (account_id, request_id)
        ).fetchone()
        return load_memo(row) if row else None

    def list(
        self, account_id: str, project: str | None, cursor: str, limit: int, include_deleted: bool
    ) -> list[Memo]:
        rows = self.db.execute(
            "SELECT * FROM memos WHERE account_id=? AND id>? "
            "AND (? IS NULL OR project=?) AND (? OR deleted_at IS NULL) ORDER BY id LIMIT ?",
            (account_id, cursor, project, project, include_deleted, limit),
        ).fetchall()
        return [load_memo(row) for row in rows]

    def add(self, memo: Memo) -> None:
        fields = memo.fields
        self.db.execute(
            "INSERT INTO memos(id,account_id,project,request_id,request_hash,content,"
            "category,tags,active,created_device_id,revision,created_at,updated_at,deleted_at,plan,next_run_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                memo.id,
                memo.account_id,
                fields.project,
                memo.request_id,
                memo.request_hash,
                fields.content,
                fields.category,
                json.dumps(fields.tags, ensure_ascii=False, separators=(",", ":")),
                fields.active,
                memo.created_device_id,
                memo.revision,
                memo.created_at,
                memo.updated_at,
                memo.deleted_at,
                plan_json(memo),
                memo.next_run_at,
            ),
        )

    def save(self, memo: Memo) -> None:
        fields = memo.fields
        self.db.execute(
            "UPDATE memos SET content=?,project=?,category=?,tags=?,active=?,revision=?,"
            "updated_at=?,deleted_at=?,plan=?,next_run_at=? WHERE id=? AND account_id=?",
            (
                fields.content,
                fields.project,
                fields.category,
                json.dumps(fields.tags, ensure_ascii=False, separators=(",", ":")),
                fields.active,
                memo.revision,
                memo.updated_at,
                memo.deleted_at,
                plan_json(memo),
                memo.next_run_at,
                memo.id,
                memo.account_id,
            ),
        )

    def due(
        self,
        now: int,
        account_id: str | None = None,
        device_id: str | None = None,
        limit: int = 100,
    ) -> list[Memo]:
        rows = self.db.execute(
            "SELECT m.* FROM memos m JOIN accounts a ON a.id=m.account_id "
            "JOIN devices d ON d.account_id=m.account_id AND d.id=json_extract(m.plan,'$.config.target_device_id') "
            "WHERE m.next_run_at<=? AND m.next_run_at IS NOT NULL AND m.deleted_at IS NULL "
            "AND m.active=1 AND a.active=1 AND d.active=1 AND d.kind='desktop' "
            "AND (? IS NULL OR m.account_id=?) AND (? IS NULL OR d.id=?) "
            "ORDER BY m.next_run_at,m.id LIMIT ?",
            (now, account_id, account_id, device_id, device_id, limit),
        ).fetchall()
        return [load_memo(row) for row in rows]


class SQLiteDispatchRepository:
    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def get(self, account_id: str, dispatch_id: str) -> Dispatch | None:
        row = self.db.execute(
            "SELECT * FROM dispatches WHERE id=? AND account_id=?", (dispatch_id, account_id)
        ).fetchone()
        return load_dispatch(row) if row else None

    def for_memo(self, account_id: str, memo_id: str) -> list[Dispatch]:
        rows = self.db.execute(
            "SELECT * FROM dispatches WHERE account_id=? AND memo_id=? "
            "ORDER BY created_at DESC,rowid DESC",
            (account_id, memo_id),
        ).fetchall()
        return [load_dispatch(row) for row in rows]

    def latest_for_memo(self, account_id: str, memo_id: str) -> Dispatch | None:
        row = self.db.execute(
            "SELECT * FROM dispatches WHERE account_id=? AND memo_id=? "
            "ORDER BY created_at DESC,rowid DESC LIMIT 1",
            (account_id, memo_id),
        ).fetchone()
        return load_dispatch(row) if row else None

    def open_for_memo(self, account_id: str, memo_id: str) -> list[Dispatch]:
        rows = self.db.execute(
            "SELECT * FROM dispatches WHERE account_id=? AND memo_id=? "
            "AND status IN ('pending','leased')",
            (account_id, memo_id),
        ).fetchall()
        return [load_dispatch(row) for row in rows]

    def accepted_for_plan(self, account_id: str, plan_id: str) -> bool:
        return (
            self.db.execute(
                "SELECT 1 FROM dispatches WHERE account_id=? AND plan_id=? "
                "AND status='accepted' LIMIT 1",
                (account_id, plan_id),
            ).fetchone()
            is not None
        )

    def next_for_device(self, account_id: str, device_id: str) -> Dispatch | None:
        row = self.db.execute(
            "SELECT * FROM dispatches WHERE account_id=? AND target_device_id=? "
            "AND status IN ('pending','leased') "
            "ORDER BY CASE status WHEN 'leased' THEN 0 ELSE 1 END,created_at,id LIMIT 1",
            (account_id, device_id),
        ).fetchone()
        return load_dispatch(row) if row else None

    def has_pending(self, account_id: str, device_id: str, now: int) -> bool:
        return (
            self.db.execute(
                "SELECT 1 FROM dispatches WHERE account_id=? AND target_device_id=? "
                "AND (status='pending' OR (status='leased' AND lease_until<=?)) LIMIT 1",
                (account_id, device_id, now),
            ).fetchone()
            is not None
        )

    def add(self, dispatch: Dispatch) -> None:
        content = dispatch.content
        self.db.execute(
            "INSERT INTO dispatches(id,account_id,memo_id,memo_revision,request_id,request_hash,"
            "project,content_snapshot,instruction,target_device_id,status,lease_token,lease_until,"
            "attempts,created_at,accepted_at,native_session_id,plan_id,scheduled_for) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                dispatch.id,
                dispatch.account_id,
                content.memo_id,
                content.memo_revision,
                dispatch.request_id,
                dispatch.request_hash,
                content.project,
                content.content_snapshot,
                content.instruction,
                content.target_device_id,
                dispatch.status.value,
                dispatch.lease_token,
                dispatch.lease_until,
                dispatch.attempts,
                dispatch.created_at,
                dispatch.accepted_at,
                dispatch.native_session_id,
                dispatch.plan_id,
                dispatch.scheduled_for,
            ),
        )

    def save(self, dispatch: Dispatch) -> None:
        self.db.execute(
            "UPDATE dispatches SET status=?,lease_token=?,lease_until=?,attempts=?,"
            "accepted_at=?,native_session_id=? WHERE id=? AND account_id=?",
            (
                dispatch.status.value,
                dispatch.lease_token,
                dispatch.lease_until,
                dispatch.attempts,
                dispatch.accepted_at,
                dispatch.native_session_id,
                dispatch.id,
                dispatch.account_id,
            ),
        )
