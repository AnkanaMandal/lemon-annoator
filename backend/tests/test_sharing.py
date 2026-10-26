"""Two people working on the same project: sign-in, conflicting saves, presence."""

from app.config import get_settings

from conftest import auth

KEY = "clips/rally_001.mp4"
ALEX = auth(sub="user-2", email="alex@example.com")


def _event(id_="a", ts=1.0):
    return {"id": id_, "timestamp": ts, "event_name": None, "checkboxes": {}, "attributes": {}, "note": ""}


def _put(client, project, base_revision, events=None, headers=None, key=KEY):
    body = {"base_revision": base_revision, "events": events if events is not None else [_event()]}
    return client.put(f"/api/projects/{project}/annotations", params={"key": key}, json=body, headers=headers)


def test_requests_need_a_valid_sign_in(client, project):
    assert client.get("/api/health", headers={"Authorization": ""}).status_code == 200

    missing = client.get("/api/projects", headers={"Authorization": ""})
    assert missing.status_code == 401 and missing.json()["error"]["code"] == "UNAUTHORIZED"
    forged = client.get("/api/projects", headers=auth(secret="some-other-secret-that-is-long-enough-too"))
    assert forged.status_code == 401
    expired = client.get("/api/projects", headers=auth(expires_in=-60))
    assert expired.status_code == 401 and "expired" in expired.json()["error"]["message"]
    anon = client.get("/api/projects", headers=auth(aud="anon"))
    assert anon.status_code == 401

    assert client.get("/api/projects", headers=ALEX).status_code == 200


def test_allowed_emails(client, project, monkeypatch):
    monkeypatch.setenv("LEMON_ALLOWED_EMAILS", "Alex@example.com")
    get_settings.cache_clear()
    assert client.get("/api/projects", headers=ALEX).status_code == 200
    refused = client.get("/api/projects")
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "FORBIDDEN"


def test_stale_saves_are_refused_instead_of_overwriting(client, project):
    first = _put(client, project, 0).json()
    assert first["revision"] == 1 and first["updated_by"] == "ankana"

    # Alex opened revision 1 and saves: fine.
    theirs = _put(client, project, 1, [_event(), _event("b", 2.0)], headers=ALEX)
    assert theirs.status_code == 200 and theirs.json()["revision"] == 2

    # Ankana still has revision 1 open: refused, with who saved and the current revision.
    stale = _put(client, project, 1, [])
    assert stale.status_code == 409
    error = stale.json()["error"]
    assert error["code"] == "ANNOTATION_CONFLICT" and "alex" in error["message"]
    assert error["details"]["revision"] == 2 and error["details"]["updated_by"] == "alex"
    loaded = client.get(f"/api/projects/{project}/annotations", params={"key": KEY}).json()
    assert loaded["event_count"] == 2 and loaded["revision"] == 2  # Alex's work is intact

    # "Keep mine": save again on top of the revision the conflict reported.
    assert _put(client, project, 2, []).json()["revision"] == 3

    # A "first save" over someone else's work is a conflict too.
    assert _put(client, project, 0, headers=ALEX).status_code == 409


def test_saving_after_someone_cleared_is_a_conflict(client, project):
    _put(client, project, 0)
    client.delete(f"/api/projects/{project}/annotations", params={"key": KEY}, headers=ALEX)
    stale = _put(client, project, 1)
    assert stale.status_code == 409 and "cleared" in stale.json()["error"]["message"]
    restarted = _put(client, project, 0)
    assert restarted.status_code == 200 and restarted.json()["revision"] == 1


def test_activity_and_presence(client, project):
    client.put(f"/api/projects/{project}/presence", json={"key": KEY}, headers=ALEX)
    mine = client.put(f"/api/projects/{project}/presence", json={"key": "clips/serve_003.mov"}).json()
    assert mine["me"] == "user-1"
    who = {p["name"]: p["video_key"] for p in mine["presence"]}
    assert who == {"alex": KEY, "ankana": "clips/serve_003.mov"}

    _put(client, project, 0, headers=ALEX)
    activity = client.get(f"/api/projects/{project}/activity").json()
    assert activity["videos"][KEY]["status"] == "in_progress"
    assert activity["videos"][KEY]["annotated_by"] == "alex" and activity["videos"][KEY]["revision"] == 1

    # Leaving the workspace (key null) removes you from the list.
    client.put(f"/api/projects/{project}/presence", json={"key": None}, headers=ALEX)
    names = [p["name"] for p in client.get(f"/api/projects/{project}/activity").json()["presence"]]
    assert names == ["ankana"]

    queue = {v["key"]: v for v in client.get(f"/api/projects/{project}/videos").json()["videos"]}
    assert queue[KEY]["annotated_by"] == "alex"
