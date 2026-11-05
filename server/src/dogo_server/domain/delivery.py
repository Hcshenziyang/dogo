"""Dispatch aggregate. Receipt acceptance is not Agent execution completion."""

from dataclasses import dataclass
from enum import StrEnum

from .errors import DomainError


class DispatchStatus(StrEnum):
    PENDING = "pending"
    LEASED = "leased"
    ACCEPTED = "accepted"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class DispatchContent:
    memo_id: str
    memo_revision: int
    project: str
    content_snapshot: str
    instruction: str
    target_device_id: str


@dataclass
class Dispatch:
    id: str
    account_id: str
    request_id: str
    request_hash: str
    content: DispatchContent
    created_at: int
    status: DispatchStatus = DispatchStatus.PENDING
    lease_token: str | None = None
    lease_until: int | None = None
    attempts: int = 0
    accepted_at: int | None = None
    native_session_id: str | None = None
    plan_id: str | None = None
    scheduled_for: int | None = None

    def lease(self, now: int, duration_ms: int, token: str) -> None:
        if self.status not in (DispatchStatus.PENDING, DispatchStatus.LEASED):
            raise DomainError("lease_mismatch", "Claim changed or delivery was already resolved")
        if self.status == DispatchStatus.LEASED and self.lease_until > now:
            # Resume the same receipt window after reconnecting; the device deduplicates by ID.
            return
        self.status = DispatchStatus.LEASED
        self.lease_token = token
        self.lease_until = now + duration_ms
        self.attempts += 1

    def acknowledge(self, device_id: str, token: str, session_id: str, now: int) -> None:
        if self.content.target_device_id != device_id:
            raise DomainError("not_found", "Record not found")
        if self.status == DispatchStatus.ACCEPTED and self.native_session_id == session_id:
            return
        if self.status != DispatchStatus.LEASED or self.lease_token != token:
            raise DomainError("lease_mismatch", "Claim changed or delivery was already resolved")
        self.status = DispatchStatus.ACCEPTED
        self.accepted_at = now
        self.native_session_id = session_id
        self.lease_token = self.lease_until = None

    def cancel_before_memo_deletion(self) -> None:
        if self.status == DispatchStatus.LEASED:
            raise DomainError(
                "dispatch_in_flight", "Delivery is awaiting receipt; deletion cannot recall it"
            )
        if self.status == DispatchStatus.PENDING:
            self.status = DispatchStatus.CANCELLED
