import json
import posixpath

from fastapi import APIRouter, Depends, Query

from .. import __version__, s3_service
from ..config import get_settings
from ..deps import get_store
from ..errors import S3Error
from ..models import ExportResult, VideoAnnotation, utcnow
from ..storage import ProjectStore

router = APIRouter(prefix="/api/projects/{project_id}", tags=["export"])


def _video_entry(ann: VideoAnnotation) -> dict:
    return {
        "video_filename": ann.video_filename,
        "s3_key": ann.video_key,
        "s3_uri": ann.s3_uri,
        "streaming_url": ann.streaming_url,
        "streaming_url_expires_at": ann.streaming_url_expires_at,
        "status": ann.status,
        "duration_seconds": ann.duration_seconds,
        "fps": ann.fps,
        "event_count": len(ann.events),
        "annotated_at": ann.updated_at,
        "labels": ann.labels,
        "events": [
            {
                "id": ev.id,
                "timestamp": ev.timestamp,
                "time": ev.time,
                "frame": ev.frame,
                "event_name": ev.event_name,
                "checkboxes": ev.checkboxes,
                "attributes": ev.attributes,
                "note": ev.note,
            }
            for ev in ann.events
        ],
    }


@router.post("/export", response_model=ExportResult)
def export_project(
    project_id: str,
    include_unannotated: bool = Query(True),
    store: ProjectStore = Depends(get_store),
):
    project = store.get(project_id)
    stored, warnings = store.iter_annotations(project_id)
    prefix = project.storage.normalized_prefix
    # Export what the queue shows: this bucket and folder. Anything else stays on disk untouched.
    annotations = {
        a.video_key: a
        for a in stored
        if a.bucket in (None, project.storage.bucket) and a.video_key.startswith(prefix)
    }
    if skipped := len(stored) - len(annotations):
        warnings.append(
            f"{skipped} annotated video{'s' if skipped != 1 else ''} outside the current bucket/folder "
            "were not exported (their files are still in app_data)."
        )
    field_labels = {f.key: f.label for f in project.label_schema.fields}

    bucket_keys: list[str] = []
    if include_unannotated and project.storage.is_configured:
        try:
            objects, truncated = s3_service.list_videos(project.storage, get_settings().max_list_keys)
            bucket_keys = [o.key for o in objects]
            if truncated:
                warnings.append("Bucket listing was truncated; some unannotated videos are not listed.")
        except S3Error as exc:
            warnings.append(f"Could not list the bucket ({exc.message}); exported annotated videos only.")

    videos = [_video_entry(annotations[k]) for k in sorted(annotations, key=str.lower)]
    for key in bucket_keys:
        if key in annotations:
            continue
        videos.append(
            {
                "video_filename": posixpath.basename(key),
                "s3_key": key,
                "s3_uri": f"s3://{project.storage.bucket}/{key}",
                "streaming_url": None,
                "streaming_url_expires_at": None,
                "status": "not_started",
                "duration_seconds": None,
                "fps": project.settings.fps,
                "event_count": 0,
                "annotated_at": None,
                "labels": {},
                "events": [],
            }
        )
    videos.sort(key=lambda v: v["s3_key"].lower())

    event_count = sum(v["event_count"] for v in videos)
    data = {
        "format": "lemon/v1",
        "generator": f"lemon {__version__}",
        "exported_at": utcnow(),
        "project": {
            "id": project.id,
            "name": project.name,
            "description": project.description,
            "bucket": project.storage.bucket,
            "region": project.storage.region,
            "prefix": project.storage.normalized_prefix,
            "fps": project.settings.fps,
        },
        "label_schema": {
            "event_types": project.label_schema.event_types,
            "fields": [f.model_dump() for f in project.label_schema.fields],
            "field_labels": field_labels,
        },
        "summary": {
            "total_videos": len(videos),
            "completed": sum(1 for v in videos if v["status"] == "completed"),
            "in_progress": sum(1 for v in videos if v["status"] == "in_progress"),
            "not_started": sum(1 for v in videos if v["status"] == "not_started"),
            "total_events": event_count,
        },
        "videos": videos,
    }

    path = store.write_export(project, data)
    # Round-trip through the file so the browser download matches what was written to disk.
    return ExportResult(
        filename=path.name,
        path=str(path),
        video_count=len(videos),
        event_count=event_count,
        warnings=warnings,
        data=json.loads(path.read_text(encoding="utf-8")),
    )
