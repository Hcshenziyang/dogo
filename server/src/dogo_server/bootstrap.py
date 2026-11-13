"""Composition root: the only place where use cases select concrete adapters."""

import secrets
import time
import uuid
from dataclasses import dataclass

from .application.identity import IdentityService
from .application.remote import RemoteService
from .config import Settings
from .infrastructure.notifications import Notifications
from .infrastructure.remote import RemoteRelay
from .infrastructure.security import IdentityCryptoAdapter
from .infrastructure.sqlite.database import Database
from .infrastructure.sqlite.uow import SQLiteUnitOfWorkFactory


def new_id() -> str:
    return str(uuid.uuid4())


@dataclass
class Container:
    settings: Settings
    database: Database
    uow: SQLiteUnitOfWorkFactory
    identity: IdentityService
    remote: RemoteService
    notifications: Notifications
    relay: RemoteRelay


def create_container(settings: Settings) -> Container:
    database = Database(settings.data_dir / "dogo.sqlite")
    database.initialize()
    uow = SQLiteUnitOfWorkFactory(database)
    notifications = Notifications()
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
    return Container(
        settings,
        database,
        uow,
        identity,
        RemoteService(identity, relay),
        notifications,
        relay,
    )
