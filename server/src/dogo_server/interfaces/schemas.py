"""接口参数结构与字段校验；数据库表定义见 infrastructure/sqlite/database.py。"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Identifier = Annotated[str, StringConstraints(min_length=1, max_length=128)]
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
