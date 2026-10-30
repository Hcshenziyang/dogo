import hashlib
import json
import time
import uuid
from collections.abc import Callable

from .auth import Principal
from .config import Settings
from .db import Database
from .errors import ServiceError
from .schemas import (
    DispatchAck,
    DispatchInstruction,
    MemoAppend,
    MemoCreate,
    MemoDelete,
    MemoUpdate,
)


def now_ms() -> int:
    return int(time.time() * 1000)


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def record(row, *, lease: bool = False) -> dict:
    result = dict(row)
    for field in ("tags",):
        if field in result and result[field] is not None:
            result[field] = json.loads(result[field])
    for field in ("request_hash", "refresh_hash", "refresh_expires_at", "token_version"):
        result.pop(field, None)
    if "active" in result:
        result["active"] = bool(result["active"])
    if "instruction" in result:
        result["session_mode"] = "new"
    if not lease:
        result.pop("lease_token", None)
    return result


class Service:
    """Business rules shared by REST and MCP; each write owns one SQLite transaction."""

    def __init__(self, db: Database, settings: Settings, notify: Callable = lambda *_: None):
        self.db = db
        self.settings = settings
        self.notify = notify
        self.clock = now_ms

    def owned(self, db, table: str, item_id: str, principal: Principal):
        assert table in {"devices", "memos", "dispatches"}
        row = db.execute(
            f"SELECT * FROM {table} WHERE id=? AND account_id=?",
            (item_id, principal.account_id),
        ).fetchone()
        if not row:
            raise ServiceError(404, "not_found", "Record not found")
        return row

    @staticmethod
    def find_request(db, table: str, p: Principal, data):
        assert table in {"memos", "dispatches"}
        digest = hashlib.sha256(encode(data.model_dump()).encode()).hexdigest()
        previous = db.execute(
            f"SELECT * FROM {table} WHERE account_id=? AND request_id=?",
            (p.account_id, data.request_id),
        ).fetchone()
        if previous and previous["request_hash"] != digest:
            raise ServiceError(409, "request_id_reused", "Request ID has different input")
        return previous, digest

    def list_devices(self, p: Principal) -> list[dict]:
        with self.db.connect() as db:
            return [
                record(row)
                for row in db.execute(
                    "SELECT * FROM devices WHERE account_id=? ORDER BY created_at,id",
                    (p.account_id,),
                )
            ]

    def revoke_device(self, p: Principal, device_id: str) -> dict:
        with self.db.connect(write=True) as db:
            self.owned(db, "devices", device_id, p)
            db.execute(
                "UPDATE devices SET active=0,token_version=token_version+1,refresh_hash=NULL,"
                "refresh_expires_at=NULL WHERE id=?",
                (device_id,),
            )
        self.notify(p.account_id, device_id)
        return {"revoked": True}

    @staticmethod
    def check_revision(row, revision: int) -> None:
        if row["revision"] != revision:
            raise ServiceError(409, "revision_conflict", "Read the latest version before writing")
        if "deleted_at" in row.keys() and row["deleted_at"] is not None:
            raise ServiceError(409, "memo_deleted", "Memo has been deleted")

    @staticmethod
    def memo_record(db, row) -> dict:
        result = record(row)
        dispatch = db.execute(
            "SELECT id,instruction,target_device_id,status,memo_revision,native_session_id,accepted_at "
            "FROM dispatches WHERE account_id=? AND memo_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
            (row["account_id"], row["id"]),
        ).fetchone()
        result["dispatch"] = dict(dispatch) if dispatch else None
        return result

    def insert_dispatch(
        self, db, p: Principal, memo, data: DispatchInstruction, request_id: str
    ) -> None:
        if not memo["active"]:
            raise ServiceError(409, "memo_inactive", "Only active memos can be dispatched")
        digest = hashlib.sha256(
            encode(
                {
                    **data.model_dump(),
                    "memo_id": memo["id"],
                    "memo_revision": memo["revision"],
                    "request_id": request_id,
                }
            ).encode()
        ).hexdigest()
        target = self.owned(db, "devices", data.target_device_id, p)
        if not target["active"] or target["kind"] != "desktop":
            raise ServiceError(409, "device_unavailable", "Target must be an active desktop device")
        dispatch_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO dispatches(id,account_id,memo_id,memo_revision,request_id,request_hash,"
            "project,content_snapshot,instruction,target_device_id,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                dispatch_id,
                p.account_id,
                memo["id"],
                memo["revision"],
                request_id,
                digest,
                memo["project"],
                memo["content"],
                data.instruction,
                data.target_device_id,
                self.clock(),
            ),
        )

    def create_memo(self, p: Principal, data: MemoCreate) -> dict:
        with self.db.connect(write=True) as db:
            memo, digest = self.find_request(db, "memos", p, data)
            if memo is None:
                device = self.owned(db, "devices", p.device_id, p)
                if not device["active"]:
                    raise ServiceError(401, "device_revoked", "Device revoked")
                memo_id, now = str(uuid.uuid4()), self.clock()
                db.execute(
                    "INSERT INTO memos(id,account_id,project,request_id,request_hash,content,"
                    "category,tags,active,created_device_id,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        memo_id,
                        p.account_id,
                        data.project,
                        data.request_id,
                        digest,
                        data.content,
                        data.category,
                        encode(data.tags),
                        data.active,
                        p.device_id,
                        now,
                        now,
                    ),
                )
                memo = self.owned(db, "memos", memo_id, p)
                if data.dispatch:
                    self.insert_dispatch(db, p, memo, data.dispatch, data.request_id)
            result = self.memo_record(db, memo)
        if data.dispatch:
            self.notify(p.account_id, data.dispatch.target_device_id)
        return result

    def get_memo(self, p: Principal, memo_id: str) -> dict:
        with self.db.connect() as db:
            return self.memo_record(db, self.owned(db, "memos", memo_id, p))

    def list_memos(
        self,
        p: Principal,
        project: str | None = None,
        cursor: str = "",
        limit: int = 100,
        include_deleted: bool = False,
    ) -> dict:
        limit = max(1, min(200, limit))
        with self.db.connect() as db:
            rows = db.execute(
                "SELECT * FROM memos WHERE account_id=? AND id>? "
                "AND (? IS NULL OR project=?) AND (? OR deleted_at IS NULL) "
                "ORDER BY id LIMIT ?",
                (p.account_id, cursor, project, project, include_deleted, limit + 1),
            ).fetchall()
            return {
                "items": [self.memo_record(db, row) for row in rows[:limit]],
                "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
            }

    def update_memo(self, p: Principal, memo_id: str, data: MemoUpdate) -> dict:
        with self.db.connect(write=True) as db:
            row = self.owned(db, "memos", memo_id, p)
            self.check_revision(row, data.revision)
            db.execute(
                "UPDATE memos SET content=?,project=?,category=?,tags=?,active=?,"
                "revision=revision+1,updated_at=? WHERE id=?",
                (
                    data.content,
                    data.project,
                    data.category,
                    encode(data.tags),
                    data.active,
                    self.clock(),
                    memo_id,
                ),
            )
            return self.memo_record(db, self.owned(db, "memos", memo_id, p))

    def append_memo(self, p: Principal, memo_id: str, data: MemoAppend) -> dict:
        with self.db.connect(write=True) as db:
            row = self.owned(db, "memos", memo_id, p)
            self.check_revision(row, data.revision)
            content = row["content"] + data.content
            if len(content) > 256_000:
                raise ServiceError(422, "memo_too_large", "Combined content exceeds the memo limit")
            db.execute(
                "UPDATE memos SET content=?,revision=revision+1,updated_at=? WHERE id=?",
                (content, self.clock(), memo_id),
            )
            return self.memo_record(db, self.owned(db, "memos", memo_id, p))

    def delete_memo(self, p: Principal, memo_id: str, data: MemoDelete) -> dict:
        with self.db.connect(write=True) as db:
            row = self.owned(db, "memos", memo_id, p)
            self.check_revision(row, data.revision)
            in_flight = db.execute(
                "SELECT 1 FROM dispatches WHERE account_id=? AND memo_id=? AND status='leased' LIMIT 1",
                (p.account_id, memo_id),
            ).fetchone()
            if in_flight:
                raise ServiceError(
                    409,
                    "dispatch_in_flight",
                    "Delivery is awaiting receipt; deletion cannot recall it",
                )
            db.execute(
                "UPDATE dispatches SET status='cancelled' WHERE account_id=? AND memo_id=? AND status='pending'",
                (p.account_id, memo_id),
            )
            now = self.clock()
            db.execute(
                "UPDATE memos SET deleted_at=?,updated_at=?,active=0,revision=revision+1 WHERE id=?",
                (now, now, memo_id),
            )
            return self.memo_record(db, self.owned(db, "memos", memo_id, p))

    def require_consumer(self, p: Principal) -> None:
        if not p.device_id:
            raise ServiceError(403, "device_token_required", "A device-bound token is required")
        with self.db.connect() as db:
            row = self.owned(db, "devices", p.device_id, p)
        if not row["active"] or row["kind"] != "desktop":
            raise ServiceError(
                403, "execution_device_required", "An active desktop device is required"
            )

    def has_pending(self, account_id: str, device_id: str) -> bool:
        with self.db.connect() as db:
            return (
                db.execute(
                    "SELECT 1 FROM dispatches WHERE account_id=? AND target_device_id=? "
                    "AND (status='pending' OR (status='leased' AND lease_until<=?)) LIMIT 1",
                    (account_id, device_id, self.clock()),
                ).fetchone()
                is not None
            )

    def next_delivery(self, p: Principal) -> dict | None:
        self.require_consumer(p)
        with self.db.connect(write=True) as db:
            row = db.execute(
                "SELECT * FROM dispatches WHERE account_id=? AND target_device_id=? "
                "AND status IN ('pending','leased') "
                "ORDER BY CASE status WHEN 'leased' THEN 0 ELSE 1 END,created_at,id LIMIT 1",
                (p.account_id, p.device_id),
            ).fetchone()
            if not row:
                return None
            if row["status"] == "leased" and row["lease_until"] > self.clock():
                # Resume the same receipt window after reconnecting; the device deduplicates by ID.
                return record(row, lease=True)
            db.execute(
                "UPDATE dispatches SET status='leased',lease_token=?,lease_until=?,"
                "attempts=attempts+1 WHERE id=?",
                (str(uuid.uuid4()), self.clock() + self.settings.lease_seconds * 1000, row["id"]),
            )
            return record(self.owned(db, "dispatches", row["id"], p), lease=True)

    def acknowledge(self, p: Principal, data: DispatchAck) -> dict:
        self.require_consumer(p)
        with self.db.connect(write=True) as db:
            row = self.owned(db, "dispatches", data.dispatch_id, p)
            if row["target_device_id"] != p.device_id:
                raise ServiceError(404, "not_found", "Record not found")
            if row["status"] == "accepted" and row["native_session_id"] == data.native_session_id:
                return record(row)
            if row["status"] != "leased" or row["lease_token"] != data.lease_token:
                raise ServiceError(
                    409, "lease_mismatch", "Claim changed or delivery was already resolved"
                )
            db.execute(
                "UPDATE dispatches SET status='accepted',accepted_at=?,native_session_id=?,"
                "lease_token=NULL,lease_until=NULL WHERE id=?",
                (self.clock(), data.native_session_id, data.dispatch_id),
            )
            return record(self.owned(db, "dispatches", data.dispatch_id, p))
