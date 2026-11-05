"""Remote application policy with framework-free identity and relay doubles."""

import asyncio

import pytest

from dogo_server.application.remote import RemoteService
from dogo_server.domain.errors import DomainError
from dogo_server.domain.identity import Principal


class Identity:
    def __init__(self, devices, events, revoked=False):
        self.devices = devices
        self.events = events
        self.revoked = revoked

    def list_devices(self, p):
        self.events.append(("devices", p))
        return self.devices

    def bearer(self, authorization):
        self.events.append(("reauthenticate", authorization))
        if self.revoked:
            raise DomainError("revoked_token", "Device login expired or revoked")
        return Principal("account", "viewer", 1)


class Relay:
    def __init__(self, events, failure=None):
        self.events = events
        self.failure = failure

    def is_online(self, account, device):
        return (account, device) == ("account", "online-desktop")

    async def call(self, account, device, call):
        self.events.append(("forward", account, device, call))
        if self.failure:
            raise self.failure
        return {"private": "response"}


def test_device_list_combines_account_scoped_identity_and_online_presence():
    devices = [
        {"id": "online-desktop", "active": True, "kind": "desktop"},
        {"id": "offline-desktop", "active": True, "kind": "desktop"},
    ]
    service = RemoteService(Identity(devices, []), Relay([]))
    result = asyncio.run(service.list_devices(Principal("account", "viewer", 1)))
    assert result == [
        {**devices[0], "online": True},
        {**devices[1], "online": False},
    ]
    assert "online" not in devices[0]
    other_account = asyncio.run(service.list_devices(Principal("other-account", "viewer", 1)))
    assert all(not device["online"] for device in other_account)


@pytest.mark.parametrize(
    "devices",
    [
        [],
        [{"id": "other", "active": True, "kind": "desktop"}],
        [{"id": "target", "active": False, "kind": "desktop"}],
        [{"id": "target", "active": True, "kind": "mobile"}],
    ],
)
def test_remote_requires_visible_active_desktop_before_forwarding(devices):
    events = []
    principal = Principal("account", "viewer", 1)
    service = RemoteService(Identity(devices, events), Relay(events))
    with pytest.raises(DomainError) as error:
        asyncio.run(service.call(principal, "target", "list", {}, "Bearer original"))
    assert error.value.code == "not_found"
    assert error.value.message == "Target device not found"
    assert events == [("devices", principal)]


@pytest.mark.parametrize("revoked", [False, True])
def test_remote_reauthenticates_original_bearer_before_releasing_response(revoked):
    events = []
    principal = Principal("account", "viewer", 1)
    identity = Identity([{"id": "target", "active": True, "kind": "desktop"}], events, revoked)
    service = RemoteService(identity, Relay(events))
    if revoked:
        with pytest.raises(DomainError) as error:
            asyncio.run(
                service.call(principal, "target", "snapshot", {"sessionId": "s"}, "Bearer original")
            )
        assert error.value.code == "revoked_token"
    else:
        assert asyncio.run(
            service.call(principal, "target", "snapshot", {"sessionId": "s"}, "Bearer original")
        ) == {"private": "response"}
    assert events == [
        ("devices", principal),
        ("forward", "account", "target", {"method": "snapshot", "args": {"sessionId": "s"}}),
        ("reauthenticate", "Bearer original"),
    ]


def test_remote_preserves_online_relay_failure_without_reauthenticating():
    events = []
    identity = Identity([{"id": "target", "active": True, "kind": "desktop"}], events)
    failure = DomainError("host_offline", "Target device is offline")
    service = RemoteService(identity, Relay(events, failure))
    with pytest.raises(DomainError) as error:
        asyncio.run(service.call(Principal("account", "viewer", 1), "target", "list", {}, None))
    assert error.value is failure
    assert [event[0] for event in events] == ["devices", "forward"]
