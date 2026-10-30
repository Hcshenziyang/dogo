"""接口参数结构与字段校验；数据库表定义见 db.py。"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Identifier = Annotated[str, StringConstraints(min_length=1, max_length=128)]
Content = Annotated[str, StringConstraints(max_length=256_000)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Login(Input):
    username: Name
    password: str = Field(min_length=1, max_length=256)
    device_id: Identifier
    device_name: Name
    device_kind: Literal["desktop", "mobile"] = "desktop"


class Refresh(Input):
    refresh_token: str = Field(min_length=32, max_length=256)


class DispatchInstruction(Input):
    instruction: str = Field(min_length=1, max_length=32_000)
    target_device_id: Identifier


class MemoFields(Input):
    content: Content
    project: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] = ""
    category: str = Field(default="", max_length=100)
    tags: list[Name] = Field(default_factory=list, max_length=30)
    active: bool = True


class MemoCreate(MemoFields):
    request_id: Identifier
    dispatch: DispatchInstruction | None = None


class MemoUpdate(MemoFields):
    revision: int = Field(ge=1)


class MemoDelete(Input):
    revision: int = Field(ge=1)


class MemoAppend(MemoDelete):
    content: Content


class DispatchAck(Input):
    type: Literal["dispatch.ack"]
    dispatch_id: Identifier
    lease_token: Identifier
    native_session_id: Identifier


class RemoteCall(Input):
    device_id: Identifier
    method: Literal[
        "list", "snapshot", "create", "prompt", "cancel", "workspaces", "models", "selectModel"
    ]
    args: dict = Field(default_factory=dict)


class RemoteResult(Input):
    type: Literal["remote.result"]
    id: Identifier
    ok: bool
    value: object = None
    error: str | None = Field(default=None, max_length=2000)
