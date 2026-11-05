"""Transport-neutral use-case inputs. HTTP/MCP validation lives at the boundary."""

from dataclasses import dataclass, field

from dogo_server.domain.plans import PlanConfig


@dataclass(frozen=True, kw_only=True)
class DispatchInstruction:
    instruction: str
    target_device_id: str


@dataclass(frozen=True, kw_only=True)
class MemoFields:
    content: str
    project: str = ""
    category: str = ""
    tags: list[str] = field(default_factory=list)
    active: bool = True


@dataclass(frozen=True, kw_only=True)
class MemoCreate(MemoFields):
    request_id: str
    dispatch: DispatchInstruction | None = None
    plan: PlanConfig | None = None


@dataclass(frozen=True, kw_only=True)
class MemoUpdate(MemoFields):
    revision: int
    plan: PlanConfig | None = None
    plan_provided: bool = False


@dataclass(frozen=True, kw_only=True)
class MemoDelete:
    revision: int


@dataclass(frozen=True, kw_only=True)
class MemoAppend(MemoDelete):
    content: str


@dataclass(frozen=True, kw_only=True)
class DispatchAck:
    dispatch_id: str
    lease_token: str
    native_session_id: str
    type: str = "dispatch.ack"
