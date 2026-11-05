"""Argon2 and HS256 adapters retaining the public token contract."""

import hashlib
import secrets

import jwt
from pwdlib import PasswordHash

from dogo_server.domain.errors import DomainError
from dogo_server.domain.identity import Principal


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class IdentityCryptoAdapter:
    def __init__(self, key: str, access_seconds: int):
        self.key = key
        self.access_seconds = access_seconds
        self.passwords = PasswordHash.recommended()
        self.dummy_hash = self.passwords.hash(secrets.token_urlsafe(32))

    def hash_password(self, password: str) -> str:
        return self.passwords.hash(password)

    def verify_password(self, password: str, password_hash: str | None) -> bool:
        return self.passwords.verify(password, password_hash or self.dummy_hash)

    def hash_token(self, token: str) -> str:
        return token_hash(token)

    def encode_access(self, principal: Principal, now: int) -> str:
        return jwt.encode(
            {
                "sub": principal.account_id,
                "ver": principal.token_version,
                "did": principal.device_id,
                "iat": now,
                "exp": now + self.access_seconds,
                "iss": "dogo",
                "aud": "dogo",
                "type": "access",
            },
            self.key,
            algorithm="HS256",
        )

    def decode_access(self, token: str) -> Principal:
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
            return Principal(data["sub"], data["did"], data["ver"])
        except (jwt.PyJWTError, ValueError, KeyError):
            raise DomainError("invalid_token", "Invalid or expired access token") from None
