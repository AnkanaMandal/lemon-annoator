"""Regression tests for data-safety and robustness fixes."""

import json
from pathlib import Path

import boto3

from app import deps
from app.config import get_settings
from app.storage import video_file_name

KEY = "clips/rally_001.mp4"


def _event(id_="a", ts=1.0, **attrs):
    return {"id": id_, "timestamp": ts, "event_name": None, "checkboxes": {}, "attributes": attrs, "note": ""}


def _save(client, project, key=KEY, events=None, status="in_progress"):
    res = client.put(f"/api/projects/{project}/annotations", params={"key": key},
                     json={"status": status, "events": events if events is not None else [_event()]})
    assert res.status_code == 200, res.text
    return res.json()


def _ann_dir(tmp_path, project) -> Path:
    return tmp_path / "app_data" / "projects" / project / "annotations"


def test_schema_change_never_drops_saved_values(client, project):
    _save(client, project, events=[_event(side="Left")])
    # Remove the "side" field and re-save the loaded events: the value must survive.
    client.patch(f"/api/projects/{project}", json={"label_schema": {"event_types": [], "fields": []}})
    loaded = client.get(f"/api/projects/{project}/annotations", params={"key": KEY}).json()
    resaved = _save(client, project, events=loaded["events"])
    assert resaved["events"][0]["attributes"]["side"] == "Left"

    # Switching a field from multiple to single keeps every selected option.
    schema = {"event_types": [], "fields": [
        {"key": "err", "label": "Err", "type": "choices", "options": ["a", "b"], "multiple": False}]}
    client.patch(f"/api/projects/{project}", json={"label_schema": schema})
    resaved = _save(client, project, events=[_event(err=["a", "b"])])
    assert resaved["events"][0]["attributes"]["err"] == ["a", "b"]


def test_index_heals_when_a_file_is_not_indexed(client, project, tmp_path):
    _save(client, project)
    index = _ann_dir(tmp_path, project) / "_index.json"
    index.write_text("{}", encoding="utf-8")  # e.g. an interrupted save, or a file restored from .trash
    queue = {v["key"]: v for v in client.get(f"/api/projects/{project}/videos").json()["videos"]}
    assert queue[KEY]["status"] == "in_progress"
    exported = client.post(f"/api/projects/{project}/export").json()["data"]
    assert any(v["s3_key"] == KEY and v["event_count"] == 1 for v in exported["videos"])


def test_legacy_long_file_names_are_still_used(client, project, tmp_path):
    key = "clips/" + "very_long_folder_name_" * 4 + "rally.mp4"
    boto3.client("s3", region_name="us-east-1").put_object(Bucket="test-videos", Key=key, Body=b"x")
    _save(client, project, key=key)
    ann_dir = _ann_dir(tmp_path, project)
    current = next(p for p in ann_dir.glob("*.json") if p.name != "_index.json")
    legacy = ann_dir / ("L" * 90 + "-legacy.json")  # an older, longer naming scheme
    current.rename(legacy)
    (ann_dir / "_index.json").unlink()

    assert client.get(f"/api/projects/{project}/annotations", params={"key": key}).json()["video_key"] == key
    _save(client, project, key=key, events=[_event(), _event("b", 2.0)])
    files = [p.name for p in ann_dir.glob("*.json") if p.name != "_index.json"]
    assert files == [legacy.name]  # updated in place, no duplicate file


def test_new_file_names_are_short_and_windows_safe():
    assert len(video_file_name("x/" * 200 + "clip.mp4")) <= 40 + 1 + 10 + 5
    assert not video_file_name("con.mp4").lower().startswith("con.")
    assert video_file_name("a/b.mp4") != video_file_name("A/b.mp4")


def test_bucket_change_is_blocked_once_annotated(client, project):
    _save(client, project)
    res = client.patch(f"/api/projects/{project}", json={"storage": {"bucket": "another-bucket"}})
    assert res.status_code == 409 and res.json()["error"]["code"] == "BUCKET_HAS_ANNOTATIONS"
    # Prefix changes are fine; out-of-folder annotations are left out of the export (with a warning)
    # and can still be cleared.
    assert client.patch(f"/api/projects/{project}", json={"storage": {"prefix": "clips/set2/"}}).status_code == 200
    export = client.post(f"/api/projects/{project}/export").json()
    assert all(v["s3_key"].startswith("clips/set2/") for v in export["data"]["videos"])
    assert any("outside the current bucket/folder" in w for w in export["warnings"])
    cleared = client.delete(f"/api/projects/{project}/annotations", params={"key": KEY}).json()
    assert cleared["cleared"] is True


def test_truncated_listing_does_not_flag_videos_missing(client, project, monkeypatch):
    _save(client, project, key="clips/set2/RALLY_002.MP4")
    monkeypatch.setenv("LEMON_MAX_LIST_KEYS", "1")
    get_settings.cache_clear()
    body = client.get(f"/api/projects/{project}/videos").json()
    assert body["truncated"] is True
    assert not any(v["missing"] for v in body["videos"])


def test_saving_into_a_deleted_project_does_not_recreate_it(client, project, tmp_path):
    client.delete(f"/api/projects/{project}")
    res = client.put(f"/api/projects/{project}/annotations", params={"key": KEY}, json={"events": []})
    assert res.status_code == 404
    assert not (tmp_path / "app_data" / "projects" / project).exists()


def test_clearing_twice_keeps_both_trash_copies(client, project, tmp_path):
    for _ in range(2):
        _save(client, project)
        assert client.delete(f"/api/projects/{project}/annotations", params={"key": KEY}).json()["cleared"]
    trash = tmp_path / "app_data" / ".trash" / project / "cleared-annotations"
    assert len(list(trash.glob("*.json"))) == 2


def test_frames_follow_the_fps_setting(client, project):
    saved = _save(client, project, events=[{**_event(ts=4.1), "frame": None}])
    assert saved["events"][0]["frame"] == 123  # floor(4.1 * 30) with float tolerance, not 122
    settings = client.get(f"/api/projects/{project}").json()["settings"]
    client.patch(f"/api/projects/{project}", json={"settings": {**settings, "fps": 25}})
    resaved = _save(client, project, events=saved["events"])
    assert resaved["events"][0]["frame"] == 102 and resaved["fps"] == 25


def test_pasted_secret_whitespace_is_trimmed(client, project, tmp_path):
    client.patch(f"/api/projects/{project}", json={"storage": {"secret_access_key": "  abc123\n"}})
    stored = json.loads((tmp_path / "app_data" / "projects" / project / "project.json").read_text())
    assert stored["storage"]["secret_access_key"] == "abc123"


def test_corrupt_annotation_file_does_not_block_export_or_saving(client, project, tmp_path):
    _save(client, project)
    path = next(p for p in _ann_dir(tmp_path, project).glob("*.json") if p.name != "_index.json")
    path.write_text("{ not json", encoding="utf-8")
    export = client.post(f"/api/projects/{project}/export")
    assert export.status_code == 200
    assert any("Skipped" in w for w in export.json()["warnings"])
    assert _save(client, project)["event_count"] == 1  # corrupt file moved aside, save succeeds
    assert list((tmp_path / "app_data" / ".trash" / project / "corrupt-annotations").glob("*.json"))


def test_requests_for_foreign_hosts_are_rejected(client):
    res = client.get("/api/health", headers={"host": "evil.example.com"})
    assert res.status_code == 403 and res.json()["error"]["code"] == "FORBIDDEN_HOST"
    assert client.get("/api/health", headers={"host": "localhost:8000"}).status_code == 200
    assert client.get("/api/health", headers={"host": "[::1]:8000"}).status_code == 403  # not in test allow-list
    deps.get_store.cache_clear()


def test_china_regions_use_the_china_endpoint():
    from app.models import StorageConfig
    from app.s3_service import get_client

    client = get_client(StorageConfig(bucket="b", region="cn-north-1", access_key_id="a", secret_access_key="s"))
    assert client.meta.endpoint_url == "https://s3.cn-north-1.amazonaws.com.cn"
