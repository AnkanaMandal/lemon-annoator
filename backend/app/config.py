
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Runtime configuration. Every value can be overridden with a
    LEMON_* environment variable or in backend/.env."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_prefix="LEMON_",
        extra="ignore",
    )

    # PostgreSQL connection string
    database_url: str = ""

    # PostgreSQL schema holding Lemon's tables
    db_schema: str = "lemon"

    # Supabase project URL
    supabase_url: str = ""

    # Legacy Supabase JWT secret, if required
    supabase_jwt_secret: str = ""

    # Comma-separated emails allowed to use the API
    allowed_emails: str = ""

    # Browser origins allowed to call the API
    cors_origins: str = (
        "http://localhost:3000,http://127.0.0.1:3000"
    )

    # Optional regex for extra browser origins
    cors_origin_regex: str = ""

    # Maximum number of S3 objects scanned per listing
    max_list_keys: int = 50_000

    @field_validator("database_url", mode="before")
    @classmethod
    def strip_database_url(cls, value):
        """Remove accidental whitespace around the database URL."""
        return value.strip() if isinstance(value, str) else value

    @property
    def cors_origin_list(self) -> list[str]:
        return [
            origin.strip().rstrip("/")
            for origin in self.cors_origins.split(",")
            if origin.strip()
        ]

    @property
    def allowed_email_set(self) -> set[str]:
        return {
            email.strip().lower()
            for email in self.allowed_emails.split(",")
            if email.strip()
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()

