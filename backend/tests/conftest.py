import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app import deps, s3_service
from app.config import get_settings
from app.main import app

BUCKET = "test-videos"


@pytest.fixture
def client(tmp_path, monkeypatch):
    """API client backed by a temp ./app_data and an in-memory S3 (moto)."""
    monkeypatch.setenv("LEMON_DATA_DIR", str(tmp_path / "app_data"))
    monkeypatch.setenv("LEMON_ALLOWED_HOSTS", "testserver,localhost,127.0.0.1")
    get_settings.cache_clear()
    deps.get_store.cache_clear()
    s3_service._clients.clear()
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
        yield TestClient(app)
    get_settings.cache_clear()
    deps.get_store.cache_clear()
    s3_service._clients.clear()


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
