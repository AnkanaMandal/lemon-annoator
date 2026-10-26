"""Persistence in Postgres (Supabase). Tables are created by db.py:

    projects     one row per project; `data` holds the full Project (settings, credentials, schema)
    annotations  one row per annotated video; `data` holds the VideoAnnotation, `revision` counts saves
    presence     which video each signed-in user has open (heartbeats)
    exports      every export that was written

Nothing is erased: deleting a project or clearing a video's annotations sets `deleted_at`, so the
rows can be restored by clearing it again.

Concurrency: `lock(project_id)` runs a transaction holding a per-project advisory lock, so
read-modify-write sequences (by different users or requests) never interleave.
"""

import json
import logging
import re
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Any

from psycopg.types.json import Jsonb
from pydantic import ValidationError as PydanticValidationError

from .db import Database
from .errors import ConflictError, NotFoundError, StorageError, ValidationError
from .models import (
    IndexEntry,
    Presence,
    ProgressStats,
    Project,
    VideoAnnotation,
    utcnow,
)

log = logging.getLogger(__name__)

PROJECT_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")
# A user counts as present on a video for this long after their last heartbeat.
PRESENCE_TTL = timedelta(seconds=90)


def slugify(value: str, max_len: int = 40) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:max_len].strip("-") or "project"


def timestamp() -> str:
    """Filename-safe UTC timestamp with milliseconds."""
    return utcnow().strftime("%Y%m%d-%H%M%S-%f")[:-3]


def json_default(obj: Any) -> Any:
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Not JSON serializable: {type(obj)!r}")


def _jsonb(data: Any) -> Jsonb:
    return Jsonb(data, dumps=lambda obj: json.dumps(obj, default=json_default))


class ProjectStore:
    def __init__(self, db: Database) -> None:
        self.db = db
        self.projects = db.table("projects")
        self.annotations = db.table("annotations")
        self.presence = db.table("presence")
        self.exports = db.table("exports")

    # ----------------------------------------------------------------- utils
    @contextmanager
    def lock(self, project_id: str) -> Iterator[None]:
        with self.db.transaction() as conn:
            conn.execute("select pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"lemon:{project_id}",))
            yield

    def _require_project(self, project_id: str) -> None:
        if not PROJECT_ID_RE.fullmatch(project_id):
            raise NotFoundError(f"Project '{project_id}' not found")
        with self.db.transaction() as conn:
            row = conn.execute(
                f"select 1 from {self.projects} where id = %s and deleted_at is null", (project_id,)
            ).fetchone()
        if not row:
            raise NotFoundError(f"Project '{project_id}' not found")

    # -------------------------------------------------------------- projects
    def list_projects(self) -> list[Project]:
        with self.db.transaction() as conn:
            rows = conn.execute(
                f"select id, data from {self.projects} where deleted_at is null order by updated_at desc"
            ).fetchall()
        projects = []
        for row in rows:
            try:
                projects.append(Project.model_validate(row["data"]))
            except PydanticValidationError as exc:  # one bad row must not hide every project
                log.warning("Skipping project %s: %s", row["id"], exc)
        return projects

    def get(self, project_id: str) -> Project:
        if not PROJECT_ID_RE.fullmatch(project_id):
            raise NotFoundError(f"Project '{project_id}' not found")
        with self.db.transaction() as conn:
            row = conn.execute(
                f"select data from {self.projects} where id = %s and deleted_at is null", (project_id,)
            ).fetchone()
        if not row:
            raise NotFoundError(f"Project '{project_id}' not found")
        try:
            return Project.model_validate(row["data"])
        except PydanticValidationError as exc:
            raise StorageError(
                f"The stored settings of project '{project_id}' are invalid.",
                code="LOCAL_FILE_CORRUPT",
                hint=str(exc.errors()[0].get("msg")) if exc.errors() else None,
            ) from exc

    def create(self, name: str, description: str = "") -> Project:
        base = slugify(name)
        with self.db.transaction() as conn:
            for _ in range(10):
                project = Project(id=f"{base}-{secrets.token_hex(3)}", name=name.strip(), description=description.strip())
                inserted = conn.execute(
                    f"insert into {self.projects} (id, data, created_at, updated_at) values (%s, %s, %s, %s) "
                    "on conflict (id) do nothing returning id",
                    (project.id, _jsonb(project.model_dump(mode="json")), project.created_at, project.updated_at),
                ).fetchone()
                if inserted:
                    return project
        raise StorageError("Could not allocate a project id")  # pragma: no cover

    def save(self, project: Project, touch: bool = True) -> Project:
        if touch:
            project.updated_at = utcnow()
        with self.db.transaction() as conn:
            cur = conn.execute(
                f"update {self.projects} set data = %s, updated_at = %s where id = %s and deleted_at is null",
                (_jsonb(project.model_dump(mode="json")), project.updated_at, project.id),
            )
        if cur.rowcount == 0:
            raise NotFoundError(f"Project '{project.id}' not found")
        return project

    def delete(self, project_id: str) -> datetime:
        if not PROJECT_ID_RE.fullmatch(project_id):
            raise NotFoundError(f"Project '{project_id}' not found")
        now = utcnow()
        with self.lock(project_id), self.db.transaction() as conn:
            cur = conn.execute(
                f"update {self.projects} set deleted_at = %s where id = %s and deleted_at is null", (now, project_id)
            )
        if cur.rowcount == 0:
            raise NotFoundError(f"Project '{project_id}' not found")
        return now

    # ----------------------------------------------------------- annotations
    def _to_annotation(self, row: dict, key: str) -> VideoAnnotation:
        try:
            ann = VideoAnnotation.model_validate(row["data"])
        except PydanticValidationError as exc:
            raise StorageError(
                f"The saved annotations for '{key}' are invalid.",
                code="LOCAL_FILE_CORRUPT",
                hint="Clear this video's annotations to start again (the old row is kept).",
            ) from exc
        ann.revision = row["revision"]
        ann.updated_by = row["updated_by"]
        return ann

    def get_annotation(self, project_id: str, key: str) -> VideoAnnotation | None:
        self._require_project(project_id)
        with self.db.transaction() as conn:
            row = conn.execute(
                f"select data, revision, updated_by from {self.annotations} "
                "where project_id = %s and video_key = %s and deleted_at is null",
                (project_id, key),
            ).fetchone()
        return self._to_annotation(row, key) if row else None

    def _retire(self, project_id: str, key: str, by: str | None) -> bool:
        """Mark the live row of a video as deleted (it stays in the table)."""
        with self.lock(project_id), self.db.transaction() as conn:
            cur = conn.execute(
                f"update {self.annotations} set deleted_at = %s, deleted_by = %s "
                "where project_id = %s and video_key = %s and deleted_at is null",
                (utcnow(), by, project_id, key),
            )
        return cur.rowcount > 0

    def quarantine_annotation(self, project_id: str, key: str) -> bool:
        """Set an unreadable annotation aside so the video can be saved again."""
        retired = self._retire(project_id, key, "lemon:unreadable")
        if retired:
            log.warning("Set aside unreadable annotations for %s in %s", key, project_id)
        return retired

    def clear_annotation(self, project_id: str, key: str, by: str | None = None) -> bool:
        """Remove a video's saved annotations (the row is kept, marked deleted). False if none."""
        self._require_project(project_id)
        return self._retire(project_id, key, by)

    def save_annotation(
        self,
        project_id: str,
        annotation: VideoAnnotation,
        *,
        base_revision: int | None = None,
        user: str | None = None,
    ) -> VideoAnnotation:
        if not annotation.video_key:
            raise ValidationError("video_key is required")
        key = annotation.video_key
        data = _jsonb(annotation.model_dump(mode="json", exclude={"revision", "updated_by"}))
        with self.lock(project_id), self.db.transaction() as conn:
            self._require_project(project_id)
            current = conn.execute(
                f"select id, revision, updated_by, updated_at from {self.annotations} "
                "where project_id = %s and video_key = %s and deleted_at is null",
                (project_id, key),
            ).fetchone()
            if base_revision is not None and (current["revision"] if current else 0) != base_revision:
                raise self._conflict(current)
            values = (annotation.bucket, annotation.status, len(annotation.events), data, annotation.updated_at, user)
            if current:
                row = conn.execute(
                    f"update {self.annotations} set bucket = %s, status = %s, event_count = %s, data = %s, "
                    "updated_at = %s, updated_by = %s, revision = revision + 1 where id = %s returning revision",
                    (*values, current["id"]),
                ).fetchone()
            else:
                row = conn.execute(
                    f"insert into {self.annotations} "
                    "(project_id, video_key, bucket, status, event_count, data, updated_at, updated_by) "
                    "values (%s, %s, %s, %s, %s, %s, %s, %s) returning revision",
                    (project_id, key, *values),
                ).fetchone()
        annotation.revision = row["revision"]
        annotation.updated_by = user
        return annotation

    @staticmethod
    def _conflict(current: dict | None) -> ConflictError:
        if current is None:
            return ConflictError(
                "This video's annotations were cleared after you opened it.",
                code="ANNOTATION_CONFLICT",
                hint="Reload to start from the cleared state, or keep your version to save it again.",
                details={"revision": 0, "updated_by": None, "updated_at": None},
            )
        who = current["updated_by"] or "Someone else"
        return ConflictError(
            f"{who} saved this video after you opened it.",
            code="ANNOTATION_CONFLICT",
            hint="Load their version, or keep yours and overwrite it.",
            details={
                "revision": current["revision"],
                "updated_by": current["updated_by"],
                "updated_at": current["updated_at"].isoformat(),
            },
        )

    def load_index(self, project_id: str) -> dict[str, IndexEntry]:
        """Status of every annotated video in the project."""
        self._require_project(project_id)
        with self.db.transaction() as conn:
            rows = conn.execute(
                f"select video_key, status, event_count, updated_at, bucket, revision, updated_by "
                f"from {self.annotations} where project_id = %s and deleted_at is null",
                (project_id,),
            ).fetchall()
        return {r["video_key"]: IndexEntry(**{k: v for k, v in r.items() if k != "video_key"}) for r in rows}

    def iter_annotations(self, project_id: str) -> tuple[list[VideoAnnotation], list[str]]:
        """All readable annotations, plus a warning for each one that could not be read."""
        self._require_project(project_id)
        with self.db.transaction() as conn:
            rows = conn.execute(
                f"select video_key, data, revision, updated_by from {self.annotations} "
                "where project_id = %s and deleted_at is null order by video_key",
                (project_id,),
            ).fetchall()
        out: list[VideoAnnotation] = []
        warnings: list[str] = []
        for row in rows:
            try:
                out.append(self._to_annotation(row, row["video_key"]))
            except StorageError as exc:
                warnings.append(f"Skipped {row['video_key']}: {exc.message}")
        return out, warnings

    def stats(self, project: Project) -> ProgressStats:
        """Progress of what the queue shows: the current bucket and folder. Annotations left from an
        earlier folder stay saved but are not counted against this folder's videos (all_annotated
        counts them: everything that deleting the project removes)."""
        with self.db.transaction() as conn:
            row = conn.execute(
                "select count(*) filter (where status in ('completed', 'in_progress')) as all_annotated, "
                "count(*) filter (where here and status = 'completed') as completed, "
                "count(*) filter (where here and status = 'in_progress') as in_progress, "
                "coalesce(sum(event_count) filter (where here), 0) as total_events "
                "from (select status, event_count, (bucket is null or bucket = %s) and starts_with(video_key, %s) "
                f"as here from {self.annotations} where project_id = %s and deleted_at is null) as a",
                (project.storage.bucket, project.storage.normalized_prefix, project.id),
            ).fetchone()
        return ProgressStats(**row)

    # -------------------------------------------------------------- presence
    def touch_presence(self, project_id: str, user_id: str, name: str, key: str | None) -> None:
        self._require_project(project_id)
        with self.db.transaction() as conn:
            conn.execute(
                f"insert into {self.presence} (project_id, user_id, user_name, video_key, seen_at) "
                "values (%s, %s, %s, %s, %s) on conflict (project_id, user_id) do update set "
                "user_name = excluded.user_name, video_key = excluded.video_key, seen_at = excluded.seen_at",
                (project_id, user_id, name, key, utcnow()),
            )

    def list_presence(self, project_id: str) -> list[Presence]:
        with self.db.transaction() as conn:
            rows = conn.execute(
                f"select user_id, user_name as name, video_key, seen_at from {self.presence} "
                "where project_id = %s and seen_at > %s and video_key is not null order by user_name",
                (project_id, utcnow() - PRESENCE_TTL),
            ).fetchall()
        return [Presence(**r) for r in rows]

    # --------------------------------------------------------------- exports
    def write_export(self, project: Project, data: dict, user: str | None = None) -> tuple[int, str]:
        filename = f"{slugify(project.name)}_{timestamp()}.json"
        with self.db.transaction() as conn:
            self._require_project(project.id)
            row = conn.execute(
                f"insert into {self.exports} (project_id, filename, created_at, created_by, data) "
                "values (%s, %s, %s, %s, %s) returning id",
                (project.id, filename, utcnow(), user, _jsonb(data)),
            ).fetchone()
        return row["id"], filename
