import glob
import os
import shutil
import socket
import subprocess
import tempfile
import time
import uuid

import boto3
import jwt
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app import deps, s3_service
from app.config import get_settings
from app.main import app

BUCKET = "test-videos"
SUPABASE_URL = "https://test-project.supabase.co"
JWT_SECRET = "test-only-jwt-secret-that-is-long-enough-for-hs256"


def make_token(sub="user-1", email="ankana@example.com", *, secret=JWT_SECRET, expires_in=3600, **claims) -> str:
    """A Supabase-style access token (legacy HS256 signing)."""
    payload = {
        "sub": sub,
        "email": email,
        "aud": "authenticated",
        "role": "authenticated",
        "iss": f"{SUPABASE_URL}/auth/v1",
        "exp": int(time.time()) + expires_in,
        **claims,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def auth(**kwargs) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(**kwargs)}"}


def _pg_bin(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for pattern in (
        f"/opt/homebrew/opt/postgresql*/bin/{name}",
        f"/usr/local/opt/postgresql*/bin/{name}",
        f"/usr/lib/postgresql/*/bin/{name}",
    ):
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[-1]
    return None


@pytest.fixture(scope="session")
def database_url(tmp_path_factory):
    """LEMON_TEST_DATABASE_URL if set (any Postgres you can create schemas in); otherwise a
    throwaway local cluster started from the Postgres binaries on this machine."""
    url = os.environ.get("LEMON_TEST_DATABASE_URL")
    if url:
        yield url
        return
    initdb, pg_ctl = _pg_bin("initdb"), _pg_bin("pg_ctl")
    if not (initdb and pg_ctl):
        pytest.skip("Postgres is not installed. Install it (brew install postgresql) or set LEMON_TEST_DATABASE_URL.")
    data = tmp_path_factory.mktemp("pgdata")
    sockets = tempfile.mkdtemp(prefix="lemon-pg-")  # short path: Unix socket paths are length-limited
    subprocess.run([initdb, "-D", str(data), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"],
                   check=True, capture_output=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    subprocess.run([pg_ctl, "-D", str(data), "-w", "-l", str(data / "server.log"),
                    "-o", f"-p {port} -k {sockets} -c listen_addresses=127.0.0.1", "start"],
                   check=True, capture_output=True)
    try:
        yield f"postgresql://postgres@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run([pg_ctl, "-D", str(data), "-m", "immediate", "stop"], capture_output=True)
        shutil.rmtree(sockets, ignore_errors=True)


def _reset_caches():
    get_settings.cache_clear()
    deps.get_store.cache_clear()
    s3_service._clients.clear()


@pytest.fixture
def client(database_url, monkeypatch):
    """API client backed by a fresh Postgres schema and an in-memory S3 (moto), signed in as "ankana"."""
    schema = f"test_{uuid.uuid4().hex[:12]}"
    # Explicit values win over anything in backend/.env.
    monkeypatch.setenv("LEMON_DATABASE_URL", database_url)
    monkeypatch.setenv("LEMON_DB_SCHEMA", schema)
    monkeypatch.setenv("LEMON_SUPABASE_URL", SUPABASE_URL)
    monkeypatch.setenv("LEMON_SUPABASE_JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("LEMON_ALLOWED_EMAILS", "")
    monkeypatch.setenv("LEMON_MAX_LIST_KEYS", "50000")
    _reset_caches()
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        for key in [
            "clips/rally_001.mp4",
            "clips/set2/RALLY_002.MP4",
            "clips/serve_003.mov",
            "clips/old.mkv",
            "clips/notes.txt",
            "other/outside.mp4",
        ]:
            s3.put_object(Bucket=BUCKET, Key=key, Body=b"\x00" * 16)
        yield TestClient(app, headers=auth())
    store = deps.get_store()
    with store.db.transaction() as conn:
        conn.execute(f"drop schema {schema} cascade")
    store.db.close()
    _reset_caches()


@pytest.fixture
def db(client):
    """Run SQL against the test's schema: db("select ... from {s}.annotations where ...", params)."""
    store = deps.get_store()

    def query(sql: str, params: tuple = ()) -> list[dict]:
        with store.db.transaction() as conn:
            cur = conn.execute(sql.format(s=store.db.schema), params)
            return cur.fetchall() if cur.description else []

    return query


SCHEMA = {
    "event_types": ["Smash", "Drop"],
    "fields": [
        {"key": "forehand", "label": "Forehand", "type": "checkbox", "options": [], "default": False},
        {"key": "winning_shot", "label": "Winning Shot", "type": "checkbox", "options": [], "default": False},
        {"key": "side", "label": "Side", "type": "select", "options": ["Left", "Right"], "default": None},
    ],
}


@pytest.fixture
def project(client):
    pid = client.post("/api/projects", json={"name": "Badminton"}).json()["id"]
    res = client.patch(
        f"/api/projects/{pid}",
        json={
            "storage": {"bucket": BUCKET, "prefix": "clips/", "access_key_id": "testing", "secret_access_key": "s3cr3t-value-xyz"},
            "label_schema": SCHEMA,
        },
    )
    assert res.status_code == 200, res.text
    return pid
