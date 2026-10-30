import hashlib
import secrets
import sqlite3
import time
import uuid
from dataclasses import dataclass

import jwt
from pwdlib import PasswordHash

from .config import Settings
from .db import Database
from .errors import ServiceError
from .schemas import Login


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(frozen=True)
class Principal:
    account_id: str
    device_id: str
    token_version: int


class Auth:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.settings = settings
        self.key = settings.signing_key()
        self.passwords = PasswordHash.recommended()
        self.dummy_hash = self.passwords.hash(secrets.token_urlsafe(32))

    def create_account(self, username: str, password: str) -> dict:
        username = username.strip().casefold()
        if not username or len(username) > 100 or not 10 <= len(password) <= 256:
            raise ServiceError(422, "invalid_account", "Username or password length is invalid")
        password_hash = self.passwords.hash(password)
        account_id = str(uuid.uuid4())
        try:
            with self.db.connect(write=True) as db:
                db.execute(
                    "INSERT INTO accounts(id,username,password_hash,created_at) VALUES(?,?,?,?)",
                    (account_id, username, password_hash, int(time.time() * 1000)),
                )
        except sqlite3.IntegrityError:
            raise ServiceError(409, "username_exists", "Username already exists") from None
        return {"id": account_id, "username": username}

    def access_token(self, principal: Principal) -> str:
        now = int(time.time())
        return jwt.encode(
            {
                "sub": principal.account_id,
                "ver": principal.token_version,
                "did": principal.device_id,
                "iat": now,
                "exp": now + self.settings.access_seconds,
                "iss": "dogo",
                "aud": "dogo",
                "type": "access",
            },
            self.key,
            algorithm="HS256",
        )

    def tokens(self, principal: Principal, refresh_token: str) -> dict:
        return {
            "access_token": self.access_token(principal),
            "refresh_token": refresh_token,
            "device_id": principal.device_id,
            "token_type": "bearer",
            "expires_in": self.settings.access_seconds,
        }

    def login(self, data: Login) -> dict:
        with self.db.connect() as db:
            account = db.execute(
                "SELECT * FROM accounts WHERE username=?", (data.username.strip().casefold(),)
            ).fetchone()
        valid = self.passwords.verify(
            data.password, account["password_hash"] if account else self.dummy_hash
        )
        if not account or not account["active"] or not valid:
            raise ServiceError(401, "invalid_credentials", "Invalid username or password")
        refresh = secrets.token_urlsafe(48)
        with self.db.connect(write=True) as db:
            device = db.execute("SELECT * FROM devices WHERE id=?", (data.device_id,)).fetchone()
            if device and device["account_id"] != account["id"]:
                raise ServiceError(409, "device_id_in_use", "Choose a different device ID")
            version = device["token_version"] + 1 if device else 1
            db.execute(
                "INSERT INTO devices(id,account_id,name,kind,active,token_version,"
                "refresh_hash,refresh_expires_at,created_at) VALUES(?,?,?,?,1,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,active=1,"
                "token_version=excluded.token_version,refresh_hash=excluded.refresh_hash,"
                "refresh_expires_at=excluded.refresh_expires_at",
                (
                    data.device_id,
                    account["id"],
                    data.device_name,
                    data.device_kind,
                    version,
                    token_hash(refresh),
                    int(time.time()) + self.settings.refresh_seconds,
                    int(time.time() * 1000),
                ),
            )
        return self.tokens(Principal(account["id"], data.device_id, version), refresh)

    def refresh(self, token: str) -> dict:
        replacement = secrets.token_urlsafe(48)
        with self.db.connect(write=True) as db:
            device = db.execute(
                "SELECT d.* FROM devices d JOIN accounts a ON a.id=d.account_id "
                "WHERE d.refresh_hash=? AND d.active=1 AND d.refresh_expires_at>? AND a.active=1",
                (token_hash(token), int(time.time())),
            ).fetchone()
            if not device:
                raise ServiceError(401, "invalid_refresh", "Refresh token expired or revoked")
            db.execute(
                "UPDATE devices SET refresh_hash=? WHERE id=?",
                (token_hash(replacement), device["id"]),
            )
        return self.tokens(
            Principal(device["account_id"], device["id"], device["token_version"]), replacement
        )

    def authenticate(self, token: str) -> Principal:
        try:
            data = jwt.decode(
                token,
                self.key,
                algorithms=["HS256"],
                issuer="dogo",
                audience="dogo",
                options={"require": ["sub", "did", "ver", "iat", "exp", "iss", "aud", "type"]},
            )
            if (
                data["type"] != "access"
                or not isinstance(data["sub"], str)
                or not isinstance(data["did"], str)
                or type(data["ver"]) is not int
            ):
                raise ValueError("Invalid token claims")
            principal = Principal(data["sub"], data["did"], data["ver"])
        except (jwt.PyJWTError, ValueError, KeyError):
            raise ServiceError(401, "invalid_token", "Invalid or expired access token") from None
        with self.db.connect() as db:
            device = db.execute(
                "SELECT d.id FROM devices d JOIN accounts a ON a.id=d.account_id "
                "WHERE d.id=? AND d.account_id=? AND d.active=1 AND a.active=1 "
                "AND d.token_version=? AND d.refresh_expires_at>?",
                (
                    principal.device_id,
                    principal.account_id,
                    principal.token_version,
                    int(time.time()),
                ),
            ).fetchone()
        if not device:
            raise ServiceError(401, "revoked_token", "Device login expired or revoked")
        return principal

    def bearer(self, authorization: str | None) -> Principal:
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not token or len(token) > 8192:
            raise ServiceError(401, "missing_token", "Bearer authentication required")
        return self.authenticate(token)

    def logout(self, principal: Principal) -> dict:
        with self.db.connect(write=True) as db:
            db.execute(
                "UPDATE devices SET token_version=token_version+1,refresh_hash=NULL,"
                "refresh_expires_at=NULL WHERE id=? AND account_id=? AND token_version=?",
                (principal.device_id, principal.account_id, principal.token_version),
            )
        return {"logged_out": True}

    def me(self, principal: Principal) -> dict:
        with self.db.connect() as db:
            row = db.execute(
                "SELECT id,username FROM accounts WHERE id=?", (principal.account_id,)
            ).fetchone()
        return dict(row)
