"""Transport error policy; domain errors contain no HTTP status."""

from fastapi.responses import JSONResponse

from ..domain.errors import DomainError

_STATUS_BY_CODE = {
    "invalid_account": 422,
    "username_exists": 409,
    "invalid_credentials": 401,
    "device_id_in_use": 409,
    "invalid_refresh": 401,
    "invalid_token": 401,
    "revoked_token": 401,
    "missing_token": 401,
    "not_found": 404,
    "device_revoked": 401,
    "device_token_required": 403,
    "execution_device_required": 403,
    "device_connected": 409,
    "host_disconnected": 409,
    "host_offline": 409,
    "remote_busy": 429,
    "remote_timeout": 504,
    "wrong_remote_peer": 403,
    "native_error": 409,
    "remote_too_large": 413,
    "invalid_message": 422,
}


def http_status(error: DomainError) -> int:
    return _STATUS_BY_CODE[error.code]


def error_response(error: DomainError) -> JSONResponse:
    status = http_status(error)
    return JSONResponse(
        {"error": {"code": error.code, "message": error.message}},
        status_code=status,
        headers={"WWW-Authenticate": "Bearer"} if status == 401 else None,
    )


async def domain_error_handler(request, error: DomainError):
    return error_response(error)
