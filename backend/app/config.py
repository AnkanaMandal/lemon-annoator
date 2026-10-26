from functools import lru_cache
from pathlib import Path

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

    # Postgres connection string (Supabase: Project Settings > Database > Connection string > Session pooler).
    database_url: str = ""
    # Postgres schema holding Lemon's tables. It is created on startup.
    db_schema: str = "lemon"
    # https://<project-ref>.supabase.co, used to verify sign-in tokens (signing keys + issuer).
    supabase_url: str = ""
    # Only for Supabase projects that still sign tokens with the legacy shared JWT secret (HS256).
    supabase_jwt_secret: str = ""
    # Comma-separated emails allowed to use the API. Empty: any user of the Supabase project.
    allowed_emails: str = ""
    # Comma-separated list of browser origins allowed to call the API (the Vercel URL in production).
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # Optional regex for extra origins, e.g. Vercel preview deployments: https://lemon-.*\.vercel\.app
    cors_origin_regex: str = ""
    # Upper bound on the number of S3 objects scanned per listing.
    max_list_keys: int = 50_000

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]

    @property
    def allowed_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.allowed_emails.split(",") if e.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()
