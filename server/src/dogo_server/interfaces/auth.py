from fastapi import APIRouter, Request

from ..application.identity import LoginCommand
from .dependencies import Identity
from .schemas import Login, Refresh

router = APIRouter()


@router.post("/api/auth/login")
def login(data: Login, request: Request):
    return request.app.state.container.identity.login(LoginCommand(**data.model_dump()))


@router.post("/api/auth/refresh")
def refresh(data: Refresh, request: Request):
    return request.app.state.container.identity.refresh(data.refresh_token)


@router.post("/api/auth/logout")
def logout(p: Identity, request: Request):
    return request.app.state.container.identity.logout(p)


@router.get("/api/auth/me")
def me(p: Identity, request: Request):
    return request.app.state.container.identity.me(p)
