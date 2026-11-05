from typing import Annotated

from fastapi import APIRouter, Query, Request

from . import commands
from .dependencies import Identity
from .schemas import MemoAppend, MemoCreate, MemoDelete, MemoUpdate

router = APIRouter()


@router.post("/api/memos", status_code=201)
def create_memo(data: MemoCreate, p: Identity, request: Request):
    return request.app.state.container.memos.create_memo(p, commands.memo_create(data))


@router.get("/api/memos")
def list_memos(
    p: Identity,
    request: Request,
    project: str | None = None,
    cursor: str = "",
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    include_deleted: bool = False,
):
    return request.app.state.container.memos.list_memos(p, project, cursor, limit, include_deleted)


@router.get("/api/memos/{memo_id}")
def get_memo(memo_id: str, p: Identity, request: Request):
    return request.app.state.container.memos.get_memo(p, memo_id)


@router.put("/api/memos/{memo_id}")
def update_memo(memo_id: str, data: MemoUpdate, p: Identity, request: Request):
    return request.app.state.container.memos.update_memo(p, memo_id, commands.memo_update(data))


@router.delete("/api/memos/{memo_id}")
def delete_memo(memo_id: str, data: MemoDelete, p: Identity, request: Request):
    return request.app.state.container.memos.delete_memo(p, memo_id, commands.memo_delete(data))


@router.post("/api/memos/{memo_id}/append")
def append_memo(memo_id: str, data: MemoAppend, p: Identity, request: Request):
    return request.app.state.container.memos.append_memo(p, memo_id, commands.memo_append(data))
