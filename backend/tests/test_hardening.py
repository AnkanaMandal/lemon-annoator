"""Regression tests for data-safety and robustness fixes."""

from app.config import get_settings

KEY = "clips/rally_001.mp4"


def _event(id_="a", ts=1.0, **attrs):
    return {"id": id_, "timestamp": ts, "event_name": None, "checkboxes": {}, "attributes": attrs, "note": ""}


def _save(client, project, key=KEY, events=None, status="in_progress"):
    res = client.put(f"/api/projects/{project}/annotations", params={"key": key},
                     json={"status": status, "events": events if events is not None else [_event()]})
    assert res.status_code == 200, res.text
    return res.json()


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


def test_saving_into_a_deleted_project_is_refused(client, project, db):
    client.delete(f"/api/projects/{project}")
    res = client.put(f"/api/projects/{project}/annotations", params={"key": KEY}, json={"events": []})
    assert res.status_code == 404
    assert db("select count(*) as n from {s}.annotations")[0]["n"] == 0


def test_clearing_twice_keeps_both_copies(client, project, db):
    for _ in range(2):
        _save(client, project)
        assert client.delete(f"/api/projects/{project}/annotations", params={"key": KEY}).json()["cleared"]
    rows = db("select deleted_at from {s}.annotations where video_key = %s", (KEY,))
    assert len(rows) == 2 and all(r["deleted_at"] for r in rows)


def test_frames_follow_the_fps_setting(client, project):
    saved = _save(client, project, events=[{**_event(ts=4.1), "frame": None}])
    assert saved["events"][0]["frame"] == 123  # floor(4.1 * 30) with float tolerance, not 122
    settings = client.get(f"/api/projects/{project}").json()["settings"]
    client.patch(f"/api/projects/{project}", json={"settings": {**settings, "fps": 25}})
    resaved = _save(client, project, events=saved["events"])
    assert resaved["events"][0]["frame"] == 102 and resaved["fps"] == 25


def test_pasted_secret_whitespace_is_trimmed(client, project, db):
    client.patch(f"/api/projects/{project}", json={"storage": {"secret_access_key": "  abc123\n"}})
    stored = db("select data from {s}.projects where id = %s", (project,))[0]["data"]
    assert stored["storage"]["secret_access_key"] == "abc123"


def test_unreadable_annotations_do_not_block_export_or_saving(client, project, db):
    _save(client, project)
    db("""update {s}.annotations set data = '{{"not": "an annotation"}}'::jsonb""")
    export = client.post(f"/api/projects/{project}/export")
    assert export.status_code == 200
    assert any("Skipped" in w for w in export.json()["warnings"])
    assert _save(client, project)["event_count"] == 1  # unreadable row set aside, save succeeds
    assert db("select deleted_by from {s}.annotations where deleted_at is not null")[0]["deleted_by"] == "lemon:unreadable"


def test_china_regions_use_the_china_endpoint():
    from app.models import StorageConfig
    from app.s3_service import get_client

    client = get_client(StorageConfig(bucket="b", region="cn-north-1", access_key_id="a", secret_access_key="s"))
    assert client.meta.endpoint_url == "https://s3.cn-north-1.amazonaws.com.cn"
