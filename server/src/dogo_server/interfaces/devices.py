from fastapi import APIRouter, Request

from .dependencies import Identity

router = APIRouter()


@router.get("/api/devices")
async def list_devices(p: Identity, request: Request):
    return await request.app.state.container.remote.list_devices(p)


@router.delete("/api/devices/{device_id}")
def revoke_device(device_id: str, p: Identity, request: Request):
    return request.app.state.container.identity.revoke_device(p, device_id)
