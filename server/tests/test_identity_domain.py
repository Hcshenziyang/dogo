from contextlib import contextmanager
from dataclasses import replace
from types import SimpleNamespace

import jwt
import pytest

from dogo_server.application.identity import IdentityService, LoginCommand
from dogo_server.domain.errors import DomainError
from dogo_server.domain.identity import Account, Device, Principal
from dogo_server.infrastructure.security import IdentityCryptoAdapter
from dogo_server.infrastructure.sqlite.database import Database
from dogo_server.infrastructure.sqlite.identity import SQLiteIdentityRepository


def example_device():
    return Device("phone", "alice", "Phone", "mobile", True, 1, "hash", 100, 1234)


def test_relogin_replaces_credentials_but_keeps_creation_and_owner():
    device = example_device()
    device.revoke()
    device.relogin("alice", "Desktop", "desktop", "new-hash", 200)
    assert device == Device("phone", "alice", "Desktop", "desktop", True, 3, "new-hash", 200, 1234)
    before = replace(device)
    with pytest.raises(DomainError, match="Choose a different device ID"):
        device.relogin("bob", "Other", "mobile", "other", 300)
    assert device == before


def test_refresh_preserves_deadline_and_version():
    device = example_device()
    device.rotate_refresh("rotated", 99)
    assert device.refresh_hash == "rotated"
    assert device.refresh_expires_at == 100
    assert device.token_version == 1
    with pytest.raises(DomainError, match="Refresh token expired or revoked"):
        device.rotate_refresh("too-late", 100)
    assert device.refresh_hash == "rotated"


def test_stale_logout_cannot_clear_new_login_and_logout_does_not_disable_device():
    device = example_device()
    device.logout(0)
    assert device.refresh_hash == "hash"
    device.logout(1)
    assert device.active
    assert device.token_version == 2
    assert device.refresh_hash is None and device.refresh_expires_at is None
    assert not device.login_is_live(0)
    device.revoke()
    assert not device.active
    assert device.token_version == 3


def test_consumer_requires_active_desktop():
    device = example_device()
    with pytest.raises(DomainError, match="An active desktop device is required"):
        device.require_consumer()
    device.kind = "desktop"
    device.require_consumer()
    device.revoke()
    with pytest.raises(DomainError):
        device.require_consumer()


def test_account_validation_preserves_normalization():
    assert Account.normalize_username("  ALIce ", "long-password") == "alice"
    for username, password in [
        (" ", "long-password"),
        ("x" * 101, "long-password"),
        ("a", "short"),
    ]:
        with pytest.raises(DomainError, match="Username or password length is invalid"):
            Account.normalize_username(username, password)


@pytest.fixture
def identity(tmp_path):
    database = Database(tmp_path / "identity.sqlite3")
    database.initialize()
    state = SimpleNamespace(writing=False, now=2000000000.0, notifications=[])

    @contextmanager
    def uow(*, write=False):
        with database.connect(write=write) as connection:
            state.writing = write
            try:
                yield SimpleNamespace(identities=SQLiteIdentityRepository(connection))
            finally:
                state.writing = False

    class Crypto(IdentityCryptoAdapter):
        def hash_password(self, password):
            assert not state.writing
            return super().hash_password(password)

        def verify_password(self, password, password_hash):
            assert not state.writing
            return super().verify_password(password, password_hash)

    crypto = Crypto("test-identity-secret-at-least-32-bytes", 900)
    ids = iter(["alice-id", "bob-id", "duplicate-id"])
    tokens = iter(f"refresh-{i}" for i in range(30))

    def notify(account_id, device_id):
        # A separate connection must see committed revocation before notification.
        with database.connect() as connection:
            device = SQLiteIdentityRepository(connection).get_device(device_id, account_id)
        assert not device.active
        state.notifications.append((account_id, device_id))

    service = IdentityService(
        uow,
        crypto,
        access_seconds=900,
        refresh_seconds=30 * 86400,
        clock=lambda: state.now,
        new_id=lambda: next(ids),
        new_token=lambda: next(tokens),
        notify=notify,
    )
    return service, database, state


def test_identity_service_rotation_namespace_and_postcommit_notification(identity):
    service, database, state = identity
    alice = service.create_account(" Alice ", "alice-password")
    service.create_account("bob", "bob-password")
    original = service.login(LoginCommand("ALICE", "alice-password", "phone", "Phone", "mobile"))
    principal = Principal(alice["id"], "phone", 1)
    assert service.me(principal) == alice
    with database.connect() as connection:
        original_device = SQLiteIdentityRepository(connection).get_device("phone", alice["id"])
    state.now += 100
    renewed = service.refresh(original["refresh_token"])
    with database.connect() as connection:
        renewed_device = SQLiteIdentityRepository(connection).get_device("phone", alice["id"])
    assert renewed_device.refresh_expires_at == original_device.refresh_expires_at
    assert renewed_device.token_version == original_device.token_version
    with pytest.raises(DomainError) as error:
        service.refresh(original["refresh_token"])
    assert error.value.code == "invalid_refresh"
    with pytest.raises(DomainError) as error:
        service.login(LoginCommand("bob", "bob-password", "phone", "Other"))
    assert error.value.code == "device_id_in_use"
    assert set(service.list_devices(principal)[0]) == {
        "id",
        "account_id",
        "name",
        "kind",
        "active",
        "created_at",
    }
    assert service.revoke_device(principal, "phone") == {"revoked": True}
    assert state.notifications == [(alice["id"], "phone")]
    with pytest.raises(DomainError):
        service.refresh(renewed["refresh_token"])
    service.login(LoginCommand("alice", "alice-password", "phone", "Again"))
    service.logout(principal)
    with database.connect() as connection:
        current = SQLiteIdentityRepository(connection).get_device("phone", alice["id"])
    assert current.active and current.refresh_hash
    assert current.created_at == original_device.created_at


def test_refresh_total_lifetime_and_disabled_account(identity):
    service, database, state = identity
    service.create_account("alice", "alice-password")
    tokens = service.login(LoginCommand("alice", "alice-password", "phone", "Phone"))
    state.now += 30 * 86400
    with pytest.raises(DomainError) as error:
        service.refresh(tokens["refresh_token"])
    assert error.value.code == "invalid_refresh"
    tokens = service.login(LoginCommand("alice", "alice-password", "phone", "Phone"))
    with database.connect(write=True) as connection:
        connection.execute("UPDATE accounts SET active=0")
    with pytest.raises(DomainError):
        service.refresh(tokens["refresh_token"])


def test_authenticate_bearer_relogin_and_account_revocation(identity):
    import time

    service, database, state = identity
    state.now = time.time()
    service.create_account("alice", "alice-password")
    original = service.login(LoginCommand("alice", "alice-password", "phone", "Phone"))
    other = service.login(LoginCommand("alice", "alice-password", "desktop", "Desktop"))
    assert service.bearer("bEaReR " + original["access_token"]).device_id == "phone"
    replacement = service.login(LoginCommand("alice", "alice-password", "phone", "Phone"))
    with pytest.raises(DomainError) as error:
        service.authenticate(original["access_token"])
    assert error.value.code == "revoked_token"
    assert service.authenticate(other["access_token"]).device_id == "desktop"
    for value in [None, "Basic token", "Bearer ", "Bearer " + "x" * 8193]:
        with pytest.raises(DomainError) as error:
            service.bearer(value)
        assert error.value.code == "missing_token"
    with database.connect(write=True) as connection:
        connection.execute("UPDATE accounts SET active=0")
    with pytest.raises(DomainError) as error:
        service.authenticate(replacement["access_token"])
    assert error.value.code == "revoked_token"


def test_missing_account_uses_dummy_verification_and_duplicate_username(identity):
    service, _, _ = identity
    with pytest.raises(DomainError) as error:
        service.login(LoginCommand("missing", "incorrect", "phone", "Phone"))
    assert error.value.code == "invalid_credentials"
    service.create_account("alice", "alice-password")
    with pytest.raises(DomainError) as error:
        service.create_account(" ALICE ", "another-password")
    assert error.value.code == "username_exists"


@pytest.mark.parametrize(
    "claims", [{"ver": True}, {"type": "refresh"}, {"did": 1}, {"aud": "other"}, {"exp": 1}]
)
def test_crypto_rejects_invalid_claims(claims):
    import time

    crypto = IdentityCryptoAdapter("test-identity-secret-at-least-32-bytes", 900)
    token = crypto.encode_access(Principal("alice", "phone", 1), int(time.time()))
    assert crypto.decode_access(token) == Principal("alice", "phone", 1)
    payload = jwt.decode(token, options={"verify_signature": False})
    payload.update(claims)
    with pytest.raises(DomainError) as error:
        crypto.decode_access(jwt.encode(payload, crypto.key, algorithm="HS256"))
    assert error.value.code == "invalid_token"
