from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    """Runtime configuration. Every value can be overridden with a
    LEMON_* environment variable or in backend/.env."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_prefix="LEMON_",
        extra="ignore",
    )

    # Where projects, annotations and exports are written.
    data_dir: Path = REPO_ROOT / "app_data"
    # Comma-separated list of browser origins allowed to call the API directly.
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # Host headers the API answers to. Anything else is rejected (protects against DNS rebinding).
    allowed_hosts: str = "localhost,127.0.0.1,::1"
    # Upper bound on the number of S3 objects scanned per listing.
    max_list_keys: int = 50_000

    @field_validator("data_dir")
    @classmethod
    def _resolve_data_dir(cls, value: Path) -> Path:
        return value if value.is_absolute() else (REPO_ROOT / value).resolve()

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def allowed_host_set(self) -> set[str]:
        return {h.strip().lower().strip("[]") for h in self.allowed_hosts.split(",") if h.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()
