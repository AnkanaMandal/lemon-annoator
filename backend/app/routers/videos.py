import logging
import math
import posixpath
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query

from .. import s3_service
from ..auth import User, current_user
from ..config import get_settings
from ..deps import get_store
from ..errors import AppError, S3Error, StorageError, ValidationError
from ..models import (
    AnnotationSave,
    ClearResult,
    PresenceUpdate,
    Project,
    ProjectActivity,
    SchemaField,
    StreamUrl,
    SyncInfo,
    VideoActivity,
    VideoAnnotation,
    VideoDetails,
    VideoItem,
    VideoList,
    utcnow,
)
from ..storage import ProjectStore

router = APIRouter(prefix="/api/projects/{project_id}", tags=["videos"])
log = logging.getLogger(__name__)


def require_video_key(project: Project, key: str, *, inside_prefix: bool = True) -> None:
    """Only presign / annotate .mp4 and .mov objects inside this project's folder."""
    if not s3_service.is_video_key(key):
        raise ValidationError("Only .mp4 and .mov videos are supported.", code="UNSUPPORTED_VIDEO")
    prefix = project.storage.normalized_prefix
    if inside_prefix and prefix and not key.startswith(prefix):
        raise ValidationError(f"{key!r} is outside this project's folder ({prefix}).", code="KEY_OUTSIDE_PREFIX")


def belongs_to(entry_bucket: str | None, project: Project) -> bool:
    """Annotations saved before buckets were recorded (None) belong to the current bucket."""
    return entry_bucket in (None, project.storage.bucket)


@router.get("/videos", response_model=VideoList)
def list_videos(project_id: str, store: ProjectStore = Depends(get_store)):
    """The video queue. Every listing is a sync: it reads the bucket and records the result."""
    return sync_videos(project_id, store)


@router.post("/sync", response_model=VideoList)
def sync_storage(project_id: str, store: ProjectStore = Depends(get_store)):
    """Re-read the bucket now (the "Sync storage" button)."""
    return sync_videos(project_id, store)


def sync_videos(project_id: str, store: ProjectStore) -> VideoList:
    project = store.get(project_id)
    objects, truncated = s3_service.list_videos(project.storage, get_settings().max_list_keys)
    index = {k: e for k, e in store.load_index(project_id).items() if belongs_to(e.bucket, project)}

    videos: list[VideoItem] = []
    seen: set[str] = set()
    for obj in objects:
        seen.add(obj.key)
        entry = index.get(obj.key)
        videos.append(
            VideoItem(
                key=obj.key,
                filename=posixpath.basename(obj.key),
                size=obj.size,
                last_modified=obj.last_modified,
                status=entry.status if entry else "not_started",
                event_count=entry.event_count if entry else 0,
                annotated_at=entry.updated_at if entry else None,
                annotated_by=entry.updated_by if entry else None,
            )
        )
    # Never silently hide work: surface annotations whose video isn't in the listing. When the
    # listing was truncated we can't tell whether they still exist, so don't call them missing.
    for key, entry in index.items():
        if key in seen or not key.startswith(project.storage.normalized_prefix):
            continue
        videos.append(
            VideoItem(
                key=key,
                filename=posixpath.basename(key),
                status=entry.status,
                event_count=entry.event_count,
                annotated_at=entry.updated_at,
                annotated_by=entry.updated_by,
                missing=not truncated,
            )
        )

    # "New" = uploaded after the previous sync, judged by S3's own LastModified time, so no list
    # of previously seen keys has to be stored.
    previous = project.last_sync
    sync = SyncInfo(
        video_count=len(objects),
        synced_at=utcnow(),
        new_count=sum(1 for o in objects if o.last_modified > previous.synced_at) if previous else None,
        total_bytes=sum(o.size for o in objects),
        truncated=truncated,
    )
    try:
        with store.lock(project_id):
            fresh = store.get(project_id)
            fresh.last_sync = sync
            store.save(fresh, touch=False)
    except AppError as exc:  # recording the sync must never fail the listing itself
        log.warning("Could not record sync for %s: %s", project_id, exc)

    return VideoList(
        videos=videos,
        truncated=truncated,
        bucket=project.storage.bucket,
        prefix=project.storage.normalized_prefix,
        sync=sync,
    )


@router.get("/videos/stream-url", response_model=StreamUrl)
def stream_url(
    project_id: str,
    key: str = Query(..., min_length=1),
    verify: bool = Query(True, description="HEAD the object first for a precise error"),
    store: ProjectStore = Depends(get_store),
):
    project = store.get(project_id)
    require_video_key(project, key)
    if verify:
        s3_service.head_video(project.storage, key)
    url, expires_at = s3_service.presign(project.storage, key, project.settings.url_expiry_seconds)
    return StreamUrl(key=key, url=url, expires_at=expires_at)


@router.get("/videos/details", response_model=VideoDetails)
def video_details(project_id: str, key: str = Query(..., min_length=1), store: ProjectStore = Depends(get_store)):
    """Everything known about one video: S3 object metadata plus local annotation state.
    S3 failures are reported inline so local details still show for videos gone from the bucket."""
    project = store.get(project_id)
    require_video_key(project, key)
    cfg = project.storage
    folder, filename = posixpath.split(key)
    details = VideoDetails(
        key=key,
        filename=filename,
        folder=f"{folder}/" if folder else "",
        extension=posixpath.splitext(filename)[1].lower(),
        bucket=cfg.bucket,
        region=cfg.region,
        s3_uri=f"s3://{cfg.bucket}/{key}",
        console_url=None
        if cfg.endpoint_url
        else f"https://s3.console.aws.amazon.com/s3/object/{quote(cfg.bucket)}?region={cfg.region}&prefix={quote(key)}",
    )
    try:
        head = s3_service.head_video(cfg, key)
        details.size = head.get("ContentLength")
        details.content_type = head.get("ContentType")
        details.last_modified = head.get("LastModified")
        details.etag = (head.get("ETag") or "").strip('"') or None
        details.storage_class = head.get("StorageClass") or "STANDARD"
        details.user_metadata = head.get("Metadata") or {}
    except S3Error as exc:
        details.s3_error = exc.message

    annotation = store.get_annotation(project_id, key)
    if annotation:
        details.status = annotation.status
        details.event_count = len(annotation.events)
        details.annotated_at = annotation.updated_at
        details.annotated_by = annotation.updated_by
        details.streaming_url = annotation.streaming_url
        details.duration_seconds = annotation.duration_seconds
    return details


@router.delete("/annotations", response_model=ClearResult)
def clear_annotation(
    project_id: str,
    key: str = Query(..., min_length=1),
    store: ProjectStore = Depends(get_store),
    user: User = Depends(current_user),
):
    """Clear a video's saved annotations (the row is kept in the database, marked deleted)."""
    project = store.get(project_id)
    # Clearing only touches saved annotations, so keys outside the current folder are fine.
    require_video_key(project, key, inside_prefix=False)
    return ClearResult(key=key, cleared=store.clear_annotation(project_id, key, user.name))


@router.get("/annotations", response_model=VideoAnnotation | None)
def get_annotation(project_id: str, key: str = Query(..., min_length=1), store: ProjectStore = Depends(get_store)):
    store.get(project_id)
    return store.get_annotation(project_id, key)


@router.put("/annotations", response_model=VideoAnnotation)
def save_annotation(
    project_id: str,
    body: AnnotationSave,
    key: str = Query(..., min_length=1),
    store: ProjectStore = Depends(get_store),
    user: User = Depends(current_user),
):
    project = store.get(project_id)
    require_video_key(project, key)
    schema = project.label_schema
    fps = project.settings.fps
    event_fields = [f for f in schema.fields if f.scope == "event"]
    video_fields = [f for f in schema.fields if f.scope == "video"]
    checkbox_fields = [f for f in event_fields if f.type == "checkbox"]
    other_fields = [f for f in event_fields if f.type != "checkbox"]
    now = utcnow()

    # Whole-video answers: every checkbox explicit, unknown keys kept (schema edits never lose data).
    labels = {
        **body.labels,
        **{
            f.key: bool(body.labels.get(f.key, f.default))
            if f.type == "checkbox"
            else normalize_value(f, body.labels.get(f.key, f.default or None))  # type: ignore[arg-type]
            for f in video_fields
        },
    }

    base_revision = body.base_revision
    with store.lock(project_id):
        try:
            existing = store.get_annotation(project_id, key)
        except StorageError as exc:
            if exc.code != "LOCAL_FILE_CORRUPT":
                raise
            store.quarantine_annotation(project_id, key)  # unreadable: keep a copy, start fresh
            existing = None
            base_revision = None  # nothing left to conflict with
        # Frames saved under a different FPS setting are recomputed from their timestamps.
        refresh_frames = bool(existing and existing.fps and existing.fps != fps)

        events = []
        for ev in sorted(body.events, key=lambda e: (e.timestamp, e.id)):
            # Every checkbox is written explicitly as true/false, even if never touched. Values for
            # keys that are no longer in the schema are kept, so editing the schema never loses data.
            checkboxes = {
                **ev.checkboxes,
                **{f.key: bool(ev.checkboxes.get(f.key, f.default)) for f in checkbox_fields},
            }
            attributes = {
                **ev.attributes,
                **{f.key: normalize_value(f, ev.attributes.get(f.key, f.default or None)) for f in other_fields},
            }
            frame = ev.frame if ev.frame is not None and not refresh_frames else frame_at(ev.timestamp, fps)
            events.append(
                ev.model_copy(
                    update={
                        "timestamp": round(ev.timestamp, 3),
                        "time": format_timestamp(ev.timestamp),
                        "frame": frame,
                        "checkboxes": checkboxes,
                        "attributes": attributes,
                        "created_at": ev.created_at or now,
                        "updated_at": now,
                    }
                )
            )

        annotation = VideoAnnotation(
            video_key=key,
            video_filename=posixpath.basename(key),
            bucket=project.storage.bucket,
            s3_uri=f"s3://{project.storage.bucket}/{key}",
            streaming_url=body.streaming_url or (existing.streaming_url if existing else None),
            streaming_url_expires_at=body.streaming_url_expires_at
            or (existing.streaming_url_expires_at if existing else None),
            status=body.status,
            duration_seconds=body.duration_seconds or (existing.duration_seconds if existing else None),
            fps=fps,
            event_count=len(events),
            events=events,
            labels=labels,
            created_at=existing.created_at if existing else now,
            updated_at=now,
        )
        return store.save_annotation(project_id, annotation, base_revision=base_revision, user=user.name)


def activity(project_id: str, store: ProjectStore, user: User) -> ProjectActivity:
    project = store.get(project_id)
    index = store.load_index(project_id)
    return ProjectActivity(
        me=user.id,
        videos={
            key: VideoActivity(
                status=e.status,
                event_count=e.event_count,
                annotated_at=e.updated_at,
                annotated_by=e.updated_by,
                revision=e.revision,
            )
            for key, e in index.items()
            if belongs_to(e.bucket, project)
        },
        presence=store.list_presence(project_id),
    )


@router.get("/activity", response_model=ProjectActivity)
def get_activity(project_id: str, store: ProjectStore = Depends(get_store), user: User = Depends(current_user)):
    """Cheap refresh for the queue (no S3 listing): saved status per video and who is on which video."""
    return activity(project_id, store, user)


@router.put("/presence", response_model=ProjectActivity)
def update_presence(
    project_id: str,
    body: PresenceUpdate,
    store: ProjectStore = Depends(get_store),
    user: User = Depends(current_user),
):
    """Heartbeat: "I have this video open" (key null: none). Returns the latest activity."""
    store.touch_presence(project_id, user.id, user.name, body.key)
    return activity(project_id, store, user)


def normalize_value(field: SchemaField, value: str | list[str] | None) -> str | list[str] | None:
    """Multiple-choice fields are always a list (possibly empty); everything else a string or None.
    A list with several values under a single-value field is kept as-is rather than truncated,
    so switching a field from multiple to single never drops answers."""
    if field.type == "choices" and field.multiple:
        if value is None or value == "":
            return []
        return [value] if isinstance(value, str) else list(value)
    if isinstance(value, list):
        if len(value) > 1:
            return value
        return value[0] if value else None
    return value if value != "" else None


def frame_at(seconds: float, fps: float) -> int:
    """Same rule as the player: the frame being shown at this time (tolerant of float error)."""
    return math.floor(seconds * fps + 1e-6)


def format_timestamp(seconds: float) -> str:
    ms_total = int(round(seconds * 1000))
    hours, rem = divmod(ms_total, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"
