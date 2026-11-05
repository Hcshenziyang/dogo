"""Request-scoped access to the composed application services."""

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ..domain.identity import Principal

bearer_scheme = HTTPBearer(auto_error=False)


def current_principal(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
):
    authorization = f"{credentials.scheme} {credentials.credentials}" if credentials else None
    return request.app.state.container.identity.bearer(authorization)


Identity = Annotated[Principal, Depends(current_principal)]
