"""Memo aggregate: content, optimistic revision and deletion invariants."""

from dataclasses import dataclass, replace

from .errors import DomainError
from .plans import ExecutionPlan

MAX_CONTENT_LENGTH = 256_000


@dataclass(frozen=True)
class MemoFields:
    content: str
    project: str = ""
    category: str = ""
    tags: tuple[str, ...] = ()
    active: bool = True

    def __post_init__(self):
        if len(self.content) > MAX_CONTENT_LENGTH:
            raise DomainError("memo_too_large", "Combined content exceeds the memo limit")
        if (
            len(self.project) > 100
            or len(self.category) > 100
            or len(self.tags) > 30
            or any(not 1 <= len(tag) <= 100 for tag in self.tags)
        ):
            raise DomainError("invalid_memo", "Memo metadata exceeds the field limits")


@dataclass
class Memo:
    id: str
    account_id: str
    request_id: str
    request_hash: str
    fields: MemoFields
    created_device_id: str | None
    created_at: int
    updated_at: int
    revision: int = 1
    deleted_at: int | None = None
    plan: ExecutionPlan | None = None
    next_run_at: int | None = None

    def check_request(self, digest: str) -> None:
        if self.request_hash != digest:
            raise DomainError("request_id_reused", "Request ID has different input")

    def check_revision(self, expected: int) -> None:
        if self.revision != expected:
            raise DomainError("revision_conflict", "Read the latest version before writing")
        if self.deleted_at is not None:
            raise DomainError("memo_deleted", "Memo has been deleted")

    def update(self, fields: MemoFields, expected: int, now: int) -> None:
        self.check_revision(expected)
        self.fields = fields
        self.revision += 1
        self.updated_at = now

    def append(self, text: str, expected: int, now: int) -> None:
        self.check_revision(expected)
        fields = replace(self.fields, content=self.fields.content + text)
        self.update(fields, expected, now)

    def delete(self, expected: int, now: int) -> None:
        self.check_revision(expected)
        self.fields = replace(self.fields, active=False)
        self.deleted_at = self.updated_at = now
        self.revision += 1

    def require_dispatchable(self) -> None:
        if not self.fields.active:
            raise DomainError("memo_inactive", "Only active memos can be dispatched")
