"""Composition root: the only place where use cases select concrete adapters."""

import secrets
import time
import uuid
from dataclasses import dataclass

from .application.delivery import DeliveryService
from .application.identity import IdentityService
from .application.memos import MemoService
from .application.remote import RemoteService
from .application.scheduling import ScheduleService
from .config import Settings
from .infrastructure.notifications import Notifications
from .infrastructure.remote import RemoteRelay
from .infrastructure.security import IdentityCryptoAdapter
from .infrastructure.sqlite.database import Database
from .infrastructure.sqlite.uow import SQLiteUnitOfWorkFactory


def new_id() -> str:
    return str(uuid.uuid4())


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class Container:
    settings: Settings
    database: Database
    uow: SQLiteUnitOfWorkFactory
    identity: IdentityService
    memos: MemoService
    deliveries: DeliveryService
    remote: RemoteService
    notifications: Notifications
    relay: RemoteRelay
    scheduler: ScheduleService


def create_container(settings: Settings) -> Container:
    database = Database(settings.data_dir / "dogo.sqlite")
    database.initialize()
    uow = SQLiteUnitOfWorkFactory(database)
    notifications = Notifications(settings.scan_seconds)
    relay = RemoteRelay(notifications.wake)
    identity = IdentityService(
        uow,
        IdentityCryptoAdapter(settings.signing_key(), settings.access_seconds),
        access_seconds=settings.access_seconds,
        refresh_seconds=settings.refresh_seconds,
        clock=time.time,
        new_id=new_id,
        new_token=lambda: secrets.token_urlsafe(48),
        notify=notifications.wake,
    )
    memos = MemoService(uow, clock=now_ms, new_id=new_id, notify=notifications.wake)
    deliveries = DeliveryService(
        uow, clock=now_ms, new_token=new_id, lease_seconds=settings.lease_seconds
    )
    return Container(
        settings,
        database,
        uow,
        identity,
        memos,
        deliveries,
        RemoteService(identity, relay),
        notifications,
        relay,
        ScheduleService(uow, clock=now_ms, new_id=new_id, notify=notifications.wake),
    )
