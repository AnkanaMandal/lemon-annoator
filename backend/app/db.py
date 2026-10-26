"""Postgres connection pool and schema (Supabase in production, any Postgres 14+ locally)."""

import logging
import re
import threading
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .errors import StorageError

log = logging.getLogger(__name__)

SCHEMA_NAME_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")

# Rows are never erased: deleting a project or clearing a video sets deleted_at.
DDL = """
create schema if not exists {s};

create table if not exists {s}.projects (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table if not exists {s}.annotations (
  id bigint generated always as identity primary key,
  project_id text not null references {s}.projects (id),
  video_key text not null,
  bucket text,
  status text not null,
  event_count integer not null default 0,
  data jsonb not null,
  revision integer not null default 1,
  updated_at timestamptz not null,
  updated_by text,
  deleted_at timestamptz,
  deleted_by text
);
create unique index if not exists annotations_live_key
  on {s}.annotations (project_id, video_key) where deleted_at is null;

create table if not exists {s}.presence (
  project_id text not null references {s}.projects (id),
  user_id text not null,
  user_name text not null,
  video_key text,
  seen_at timestamptz not null,
  primary key (project_id, user_id)
);

create table if not exists {s}.exports (
  id bigint generated always as identity primary key,
  project_id text not null references {s}.projects (id),
  filename text not null,
  created_at timestamptz not null,
  created_by text,
  data jsonb not null
);

-- Only this API (connecting as the table owner) reads these tables. With RLS on and no policies,
-- Supabase's public keys can never read them, even if the schema is later exposed.
alter table {s}.projects enable row level security;
alter table {s}.annotations enable row level security;
alter table {s}.presence enable row level security;
alter table {s}.exports enable row level security;
"""


def _probe(url: str) -> None:
    """One plain connection attempt before the pool opens: the pool only retries and finally reports a
    timeout, which hides the real cause (wrong password, unreachable host...)."""
    try:
        with psycopg.connect(url, connect_timeout=10, prepare_threshold=None):
            pass
    except psycopg.Error as exc:
        detail = " ".join(str(exc).split()) or type(exc).__name__
        raise StorageError(
            f"Could not connect to the database: {detail}",
            code="DATABASE_UNAVAILABLE",
            hint=connection_hint(url, detail),
        ) from exc


def connection_hint(url: str, error: str) -> str:
    """The likely fix for a failed connection, for the usual Supabase mistakes."""
    try:
        params = conninfo_to_dict(url)
    except psycopg.ProgrammingError:
        return ("LEMON_DATABASE_URL is not a valid connection string. If the password contains characters "
                "such as @ # / ? %, reset it in Supabase to letters and numbers only.")
    host = str(params.get("host") or "")
    password = str(params.get("password") or "")
    if host.startswith("db.") and host.endswith(".supabase.co"):
        return ("This is Supabase's direct connection, which only works over IPv6 (Render can't reach it). "
                "Use Connect > Connection String > Method: Session pooler instead.")
    if not password or "YOUR-PASSWORD" in password:
        return "Put your database password in the connection string in place of [YOUR-PASSWORD]."
    if "password authentication failed" in error:
        return ("Wrong database password. Use the one from Supabase > Project Settings > Database "
                "(reset it there if needed), not your Supabase login password.")
    return "Check LEMON_DATABASE_URL. On Render, use Supabase's session pooler connection string."


class Database:
    def __init__(self, url: str, schema: str) -> None:
        if not url:
            raise StorageError(
                "No database is configured.",
                code="DATABASE_NOT_CONFIGURED",
                hint="Set LEMON_DATABASE_URL in backend/.env (or on Render) to your Supabase connection string.",
            )
        if not SCHEMA_NAME_RE.match(schema):
            raise StorageError(f'"{schema}" is not a valid schema name.', code="DATABASE_NOT_CONFIGURED")
        self.schema = schema
        _probe(url)
        self.pool = ConnectionPool(
            url,
            min_size=1,
            max_size=5,
            # prepare_threshold=None: Supabase's transaction pooler does not support prepared statements.
            kwargs={"row_factory": dict_row, "prepare_threshold": None},
            check=ConnectionPool.check_connection,
            open=False,
        )
        self._local = threading.local()
        try:
            self.pool.open(wait=True, timeout=20)
        except Exception as exc:
            self.pool.close()
            raise StorageError(
                f"Could not connect to the database: {exc}",
                code="DATABASE_UNAVAILABLE",
                hint="Check LEMON_DATABASE_URL. On Render, use Supabase's session pooler connection string.",
            ) from exc
        with self.transaction() as conn:
            conn.execute(DDL.format(s=schema))

    def table(self, name: str) -> str:
        return f"{self.schema}.{name}"

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Connection]:
        """One transaction. Calls nested on the same thread join the outer one, so a block under
        ProjectStore.lock() reads and writes atomically."""
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            yield conn
            return
        with self.pool.connection() as conn:  # commits on success, rolls back on error
            self._local.conn = conn
            try:
                yield conn
            finally:
                self._local.conn = None

    def close(self) -> None:
        self.pool.close()
