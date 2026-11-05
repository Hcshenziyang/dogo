"""Durable delivery use cases, independent of WebSocket transport."""

from collections.abc import Callable

from dogo_server.domain.delivery import DispatchStatus
from dogo_server.domain.errors import DomainError
from dogo_server.domain.identity import Principal

from .commands import DispatchAck
from .ports import UnitOfWork, UnitOfWorkFactory
from .scheduling import advance_after_receipt
from .views import delivery_view


class DeliveryService:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        *,
        clock: Callable[[], int],
        new_token: Callable[[], str],
        lease_seconds: int,
    ):
        self.uow = uow
        self.clock = clock
        self.new_token = new_token
        self.lease_seconds = lease_seconds

    def has_pending(self, account_id: str, device_id: str) -> bool:
        with self.uow() as uow:
            return uow.dispatches.has_pending(account_id, device_id, self.clock())

    def next_delivery(self, p: Principal) -> dict | None:
        with self.uow(write=True) as uow:
            self._require_consumer(uow, p)
            dispatch = uow.dispatches.next_for_device(p.account_id, p.device_id)
            if dispatch is None:
                return None
            dispatch.lease(self.clock(), self.lease_seconds * 1000, self.new_token())
            uow.dispatches.save(dispatch)
            return delivery_view(dispatch, lease=True)

    def acknowledge(self, p: Principal, data: DispatchAck) -> dict:
        with self.uow(write=True) as uow:
            self._require_consumer(uow, p)
            dispatch = uow.dispatches.get(p.account_id, data.dispatch_id)
            if dispatch is None:
                raise DomainError("not_found", "Record not found")
            already_accepted = dispatch.status == DispatchStatus.ACCEPTED
            now = self.clock()
            dispatch.acknowledge(p.device_id, data.lease_token, data.native_session_id, now)
            uow.dispatches.save(dispatch)
            if not already_accepted:
                advance_after_receipt(uow, dispatch, now)
            return delivery_view(dispatch)

    @staticmethod
    def _require_consumer(uow: UnitOfWork, p: Principal) -> None:
        # Authorization and delivery mutation share the transaction so revocation
        # cannot commit between the eligibility check and the lease/receipt write.
        if not p.device_id:
            raise DomainError("device_token_required", "A device-bound token is required")
        device = uow.identities.get_device(p.device_id, p.account_id)
        if device is None:
            raise DomainError("not_found", "Record not found")
        device.require_consumer()
