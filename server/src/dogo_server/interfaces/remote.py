import json

from fastapi import APIRouter, Request

from ..domain.errors import DomainError
from .dependencies import Identity
from .schemas import RemoteCall

router = APIRouter()


@router.post("/api/remote/call")
async def remote_call(data: RemoteCall, request: Request, p: Identity):
    if len(json.dumps(data.args, ensure_ascii=False).encode()) > 1024 * 1024:
        raise DomainError("remote_too_large", "Remote request too large")
    value = await request.app.state.container.remote.call(
        p, data.device_id, data.method, data.args, request.headers.get("authorization")
    )
    return {"value": value}
