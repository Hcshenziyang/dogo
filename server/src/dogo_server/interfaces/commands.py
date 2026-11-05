"""Explicit conversion of validated wire payloads to application commands."""

from ..application import commands
from ..domain.plans import PlanConfig
from . import schemas


def memo_create(data: schemas.MemoCreate) -> commands.MemoCreate:
    fields = data.model_dump()
    dispatch = fields.pop("dispatch")
    plan = fields.pop("plan")
    return commands.MemoCreate(
        **fields,
        dispatch=commands.DispatchInstruction(**dispatch) if dispatch is not None else None,
        plan=PlanConfig(**plan) if plan is not None else None,
    )


def memo_update(data: schemas.MemoUpdate) -> commands.MemoUpdate:
    fields = data.model_dump()
    plan = fields.pop("plan")
    return commands.MemoUpdate(
        **fields,
        plan=PlanConfig(**plan) if plan is not None else None,
        plan_provided="plan" in data.model_fields_set,
    )


def memo_append(data: schemas.MemoAppend) -> commands.MemoAppend:
    return commands.MemoAppend(**data.model_dump())


def memo_delete(data: schemas.MemoDelete) -> commands.MemoDelete:
    return commands.MemoDelete(**data.model_dump())


def dispatch_ack(data: schemas.DispatchAck) -> commands.DispatchAck:
    return commands.DispatchAck(**data.model_dump())
