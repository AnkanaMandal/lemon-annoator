import json
from pathlib import Path


def test_project_lifecycle(client):
    created = client.post("/api/projects", json={"name": "Tennis  Q3", "description": "rallies"})
    assert created.status_code == 201
    pid = created.json()["id"]
    assert pid.startswith("tennis-q3-")

    listed = client.get("/api/projects").json()
    assert [p["id"] for p in listed] == [pid]
    assert listed[0]["storage"]["is_configured"] is False

    deleted = client.delete(f"/api/projects/{pid}").json()
    assert ".trash" in deleted["moved_to"] and Path(deleted["moved_to"]).exists()
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_secret_is_never_returned(client, project):
    body = client.get(f"/api/projects/{project}").json()
    assert body["storage"]["has_secret_access_key"] is True
    assert "s3cr3t-value-xyz" not in json.dumps(body)

    # Omitting the secret keeps it; "" clears it.
    client.patch(f"/api/projects/{project}", json={"storage": {"region": "us-east-1"}})
    assert client.get(f"/api/projects/{project}").json()["storage"]["has_secret_access_key"] is True
    client.patch(f"/api/projects/{project}", json={"storage": {"secret_access_key": ""}})
    assert client.get(f"/api/projects/{project}").json()["storage"]["has_secret_access_key"] is False


def test_schema_validation(client, project):
    dup = client.patch(f"/api/projects/{project}", json={"label_schema": {"event_types": ["Smash", "smash"], "fields": []}})
    assert dup.status_code == 422
    assert "unique" in dup.json()["error"]["message"]

    empty_dropdown = client.patch(
        f"/api/projects/{project}",
        json={"label_schema": {"event_types": [], "fields": [{"key": "x", "label": "X", "type": "select", "options": []}]}},
    )
    assert empty_dropdown.status_code == 422


def test_connection_and_queue_only_mp4_and_mov(client, project):
    test = client.post(f"/api/projects/{project}/storage/test").json()
    assert test["ok"] and test["video_count"] == 3

    videos = client.get(f"/api/projects/{project}/videos").json()["videos"]
    assert [v["key"] for v in videos] == ["clips/rally_001.mp4", "clips/serve_003.mov", "clips/set2/RALLY_002.MP4"]
    assert all(v["status"] == "not_started" for v in videos)


def test_storage_errors_are_actionable(client, project):
    missing = client.post(f"/api/projects/{project}/storage/test", json={"bucket": "does-not-exist-bucket"})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "S3_BUCKET_NOT_FOUND"

    region = client.post(f"/api/projects/{project}/storage/test", json={"region": "mars-1"})
    assert region.json()["error"]["code"] == "S3_INVALID_REGION"

    partial = client.post(f"/api/projects/{project}/storage/test", json={"access_key_id": "AKIA", "secret_access_key": ""})
    assert partial.json()["error"]["code"] == "S3_PARTIAL_CREDENTIALS"


def test_stream_url(client, project):
    res = client.get(f"/api/projects/{project}/videos/stream-url", params={"key": "clips/serve_003.mov"})
    assert res.status_code == 200
    url = res.json()["url"]
    assert "X-Amz-Signature" in url and "response-content-type=video%2Fmp4" in url

    assert client.get(f"/api/projects/{project}/videos/stream-url", params={"key": "clips/old.mkv"}).json()["error"][
        "code"
    ] == "UNSUPPORTED_VIDEO"
    assert client.get(f"/api/projects/{project}/videos/stream-url", params={"key": "other/outside.mp4"}).json()[
        "error"
    ]["code"] == "KEY_OUTSIDE_PREFIX"
    assert client.get(f"/api/projects/{project}/videos/stream-url", params={"key": "clips/gone.mp4"}).json()["error"][
        "code"
    ] == "S3_KEY_NOT_FOUND"


def test_save_normalises_events_and_updates_queue(client, project):
    key = "clips/rally_001.mp4"
    saved = client.put(
        f"/api/projects/{project}/annotations",
        params={"key": key},
        json={
            "status": "completed",
            "streaming_url": "https://example.com/presigned",
            "duration_seconds": 12.0,
            "events": [
                {"id": "b", "timestamp": 6.25, "frame": None, "event_name": "Drop", "checkboxes": {}, "attributes": {}, "note": ""},
                {"id": "a", "timestamp": 1.23456, "frame": 37, "event_name": "Smash",
                 "checkboxes": {"forehand": True}, "attributes": {"side": "Left"}, "note": "nice"},
            ],
        },
    )
    assert saved.status_code == 200, saved.text
    events = saved.json()["events"]
    assert [e["id"] for e in events] == ["a", "b"]  # sorted chronologically
    assert events[0]["timestamp"] == 1.235 and events[0]["time"] == "00:00:01.235"
    # Every checkbox is explicit true/false, even when never touched.
    assert events[1]["checkboxes"] == {"forehand": False, "winning_shot": False}
    assert events[1]["frame"] == 187  # derived from fps (30)

    loaded = client.get(f"/api/projects/{project}/annotations", params={"key": key}).json()
    assert loaded["status"] == "completed" and loaded["s3_uri"] == f"s3://test-videos/{key}"

    queue = {v["key"]: v for v in client.get(f"/api/projects/{project}/videos").json()["videos"]}
    assert queue[key]["status"] == "completed" and queue[key]["event_count"] == 2


def test_export(client, project):
    client.put(
        f"/api/projects/{project}/annotations",
        params={"key": "clips/serve_003.mov"},
        json={"status": "in_progress", "streaming_url": "https://example.com/u", "events": [
            {"id": "x", "timestamp": 2, "event_name": "Smash", "checkboxes": {"winning_shot": True}, "attributes": {}, "note": ""}
        ]},
    )
    res = client.post(f"/api/projects/{project}/export").json()
    assert Path(res["path"]).exists()
    data = res["data"]
    assert data["summary"] == {"total_videos": 3, "completed": 0, "in_progress": 1, "not_started": 2, "total_events": 1}

    mov = next(v for v in data["videos"] if v["video_filename"] == "serve_003.mov")
    assert mov["streaming_url"] == "https://example.com/u"
    assert mov["events"][0]["event_name"] == "Smash"
    assert mov["events"][0]["checkboxes"] == {"forehand": False, "winning_shot": True}
    assert json.loads(Path(res["path"]).read_text(encoding="utf-8")) == data


def test_index_rebuilds_when_deleted(client, project, tmp_path):
    client.put(f"/api/projects/{project}/annotations", params={"key": "clips/rally_001.mp4"},
               json={"status": "completed", "events": []})
    index = tmp_path / "app_data" / "projects" / project / "annotations" / "_index.json"
    index.unlink()
    queue = {v["key"]: v for v in client.get(f"/api/projects/{project}/videos").json()["videos"]}
    assert queue["clips/rally_001.mp4"]["status"] == "completed"
    assert index.exists()


def test_video_details(client, project):
    key = "clips/set2/RALLY_002.MP4"
    client.put(f"/api/projects/{project}/annotations", params={"key": key},
               json={"status": "completed", "duration_seconds": 8.0, "events": [
                   {"id": "a", "timestamp": 1, "event_name": "Smash", "checkboxes": {}, "attributes": {}, "note": ""}]})
    d = client.get(f"/api/projects/{project}/videos/details", params={"key": key}).json()
    assert d["filename"] == "RALLY_002.MP4" and d["folder"] == "clips/set2/" and d["extension"] == ".mp4"
    assert d["s3_uri"] == f"s3://test-videos/{key}" and d["size"] == 16 and d["s3_error"] is None
    assert d["status"] == "completed" and d["event_count"] == 1 and d["duration_seconds"] == 8.0
    assert d["annotation_file"].endswith(".json") and d["console_url"].startswith("https://s3.console.aws.amazon.com/")

    # Gone from the bucket: S3 error reported inline, request still succeeds.
    gone = client.get(f"/api/projects/{project}/videos/details", params={"key": "clips/gone.mp4"}).json()
    assert gone["s3_error"] and gone["size"] is None and gone["status"] == "not_started"


def test_clear_annotations_moves_file_to_trash(client, project, tmp_path):
    key = "clips/rally_001.mp4"
    client.put(f"/api/projects/{project}/annotations", params={"key": key},
               json={"status": "completed", "events": [
                   {"id": "a", "timestamp": 1, "event_name": "Smash", "checkboxes": {}, "attributes": {}, "note": ""}]})
    res = client.delete(f"/api/projects/{project}/annotations", params={"key": key}).json()
    assert res["cleared"] is True
    assert Path(res["moved_to"]).exists() and ".trash" in res["moved_to"]

    assert client.get(f"/api/projects/{project}/annotations", params={"key": key}).json() is None
    queue = {v["key"]: v for v in client.get(f"/api/projects/{project}/videos").json()["videos"]}
    assert queue[key]["status"] == "not_started" and queue[key]["event_count"] == 0

    again = client.delete(f"/api/projects/{project}/annotations", params={"key": key}).json()
    assert again == {"key": key, "cleared": False, "moved_to": None}


def test_choices_fields(client, project):
    schema = {
        "event_types": [],
        "fields": [
            {"key": "shot_type", "label": "Shot Type", "type": "choices", "options": ["lift", "net"], "required": True},
            {"key": "error_pattern", "label": "Error Pattern", "type": "choices", "multiple": True,
             "options": ["incorrect_grip", "poor_timing"], "default": "poor_timing"},
            {"key": "notes", "label": "Notes", "type": "text", "placeholder": "Optional notes", "required": True},
        ],
    }
    saved = client.patch(f"/api/projects/{project}", json={"label_schema": schema}).json()["label_schema"]["fields"]
    assert saved[0]["required"] is True and saved[0]["multiple"] is False
    assert saved[1]["multiple"] is True and saved[1]["default"] is None  # multi-select starts empty
    assert saved[2]["placeholder"] == "Optional notes"

    bad = {"event_types": [], "fields": [{"key": "x", "label": "X", "type": "choices", "options": []}]}
    assert client.patch(f"/api/projects/{project}", json={"label_schema": bad}).status_code == 422

    key = "clips/rally_001.mp4"
    events = client.put(f"/api/projects/{project}/annotations", params={"key": key}, json={"events": [
        {"id": "a", "timestamp": 1, "event_name": None, "checkboxes": {},
         "attributes": {"shot_type": ["lift"], "error_pattern": "poor_timing", "notes": ""}, "note": ""},
        {"id": "b", "timestamp": 2, "event_name": None, "checkboxes": {},
         "attributes": {"error_pattern": ["incorrect_grip", "poor_timing"]}, "note": ""},
    ]}).json()["events"]
    assert events[0]["attributes"] == {"shot_type": "lift", "error_pattern": ["poor_timing"], "notes": None}
    assert events[1]["attributes"] == {"shot_type": None, "error_pattern": ["incorrect_grip", "poor_timing"], "notes": None}

    exported = client.post(f"/api/projects/{project}/export").json()["data"]
    video = next(v for v in exported["videos"] if v["s3_key"] == key)
    assert video["events"][1]["attributes"]["error_pattern"] == ["incorrect_grip", "poor_timing"]


def test_prefix_without_trailing_slash_is_a_folder(client, project):
    import boto3

    boto3.client("s3", region_name="us-east-1").put_object(Bucket="test-videos", Key="clips-old/stale.mp4", Body=b"x")
    client.patch(f"/api/projects/{project}", json={"storage": {"prefix": "/clips"}})
    keys = [v["key"] for v in client.get(f"/api/projects/{project}/videos").json()["videos"]]
    assert keys and all(k.startswith("clips/") for k in keys)


def test_sync_counts_new_videos(client, project):
    import time

    import boto3

    first = client.post(f"/api/projects/{project}/sync").json()["sync"]
    assert first["video_count"] == 3 and first["new_count"] is None  # first sync of this folder
    assert first["total_bytes"] == 3 * 16

    time.sleep(1.1)  # S3 LastModified has one-second precision
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.put_object(Bucket="test-videos", Key="clips/new_1.mp4", Body=b"x")
    s3.put_object(Bucket="test-videos", Key="clips/new_2.mov", Body=b"x")
    second = client.post(f"/api/projects/{project}/sync").json()
    assert second["sync"]["video_count"] == 5 and second["sync"]["new_count"] == 2
    assert {"clips/new_1.mp4", "clips/new_2.mov"} <= {v["key"] for v in second["videos"]}

    # The project remembers it (dashboard + settings read it from there).
    stored = client.get(f"/api/projects/{project}").json()["last_sync"]
    assert stored["video_count"] == 5 and stored["new_count"] == 2
    assert client.post(f"/api/projects/{project}/sync").json()["sync"]["new_count"] == 0


def test_whole_video_labels(client, project):
    schema = {"event_types": ["Smash"], "fields": [
        {"key": "shot_type", "label": "Shot Type", "type": "choices", "options": ["lift", "net"], "scope": "video", "required": True},
        {"key": "flag", "label": "Flag", "type": "checkbox", "scope": "video"},
        {"key": "forehand", "label": "Forehand", "type": "checkbox"},  # per timestamp (default scope)
    ]}
    fields = client.patch(f"/api/projects/{project}", json={"label_schema": schema}).json()["label_schema"]["fields"]
    assert [f["scope"] for f in fields] == ["video", "video", "event"]

    saved = client.put(f"/api/projects/{project}/annotations", params={"key": "clips/rally_001.mp4"}, json={
        "status": "completed",
        "labels": {"shot_type": ["lift"]},
        "events": [{"id": "a", "timestamp": 1, "event_name": "Smash", "checkboxes": {}, "attributes": {}, "note": ""}],
    }).json()
    assert saved["labels"] == {"shot_type": "lift", "flag": False}
    # Event rows only carry per-timestamp fields.
    assert saved["events"][0]["checkboxes"] == {"forehand": False} and saved["events"][0]["attributes"] == {}

    reloaded = client.get(f"/api/projects/{project}/annotations", params={"key": "clips/rally_001.mp4"}).json()
    assert reloaded["labels"]["shot_type"] == "lift"
    exported = client.post(f"/api/projects/{project}/export").json()["data"]
    video = next(v for v in exported["videos"] if v["s3_key"] == "clips/rally_001.mp4")
    assert video["labels"] == {"shot_type": "lift", "flag": False}
