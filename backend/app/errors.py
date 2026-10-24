from typing import Any


class AppError(Exception):
    """Base error rendered as `{"error": {code, message, hint, details}}`."""

    status_code = 500
    code = "INTERNAL_ERROR"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        hint: str | None = None,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.details = details or {}
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "hint": self.hint,
            "details": self.details,
        }


class NotFoundError(AppError):
    status_code = 404
    code = "NOT_FOUND"


class ValidationError(AppError):
    status_code = 400
    code = "VALIDATION_ERROR"


class ConflictError(AppError):
    status_code = 409
    code = "CONFLICT"


class StorageError(AppError):
    """Problems reading or writing the local ./app_data directory."""

    status_code = 500
    code = "LOCAL_STORAGE_ERROR"


class S3Error(AppError):
    status_code = 502
    code = "S3_ERROR"
