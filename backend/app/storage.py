"""Local JSON persistence under ./app_data.

Layout:
    app_data/
      projects/<project_id>/
        project.json                 project config, credentials, label schema
        annotations/_index.json      fast status lookup (self-healing cache of the files below)
        annotations/<video>.json     one human-readable file per video
        exports/<name>_<ts>.json     full project exports
      .trash/                        deleted projects / cleared annotations are moved here, never erased

Concurrency: every read and write of a project's files happens under that project's lock. On
Windows a file cannot be replaced while another handle has it open, so unlocked readers would
make writers fail.
"""

import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
import threading
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError as PydanticValidationError

from .errors import NotFoundError, StorageError, ValidationError
from .models import (
    IndexEntry,
    ProgressStats,
    Project,
    VideoAnnotation,
    utcnow,
)

log = logging.getLogger(__name__)

PROJECT_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,80}")
INDEX_FILE = "_index.json"

# Short enough that <data_dir>/.trash/<project>/cleared-annotations/<name> stays under Windows'
# 260-character path limit for ordinary install locations. The hash keeps names unique.
READABLE_NAME_LEN = 40
_WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(10)), *(f"lpt{i}" for i in range(10))}


def slugify(value: str, max_len: int = 40) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:max_len].strip("-") or "project"


def video_file_name(key: str) -> str:
    """Readable, collision-free filename for an arbitrary S3 key (used for newly saved videos;
    existing files keep their name and are found through the index)."""
    readable = re.sub(r"[^A-Za-z0-9._-]+", "_", key)[-READABLE_NAME_LEN:].strip("._-") or "video"
    if readable.split(".")[0].lower() in _WINDOWS_RESERVED:
        readable = f"_{readable}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
    return f"{readable}-{digest}.json"


def timestamp() -> str:
    """Filename-safe UTC timestamp with milliseconds."""
    return utcnow().strftime("%Y%m%d-%H%M%S-%f")[:-3]


def unique_path(path: Path) -> Path:
    candidate, n = path, 2
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}-{n}{path.suffix}")
        n += 1
    return candidate


def _json_default(obj: Any) -> Any:
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Not JSON serializable: {type(obj)!r}")


def _retry_on_lock(action, attempts: int = 12) -> None:
    """Windows refuses to replace/move a file that another process (antivirus, indexer, editor)
    briefly holds open. Retry with backoff for ~3 seconds before giving up."""
    for attempt in range(attempts):
        try:
            action()
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(min(0.05 * 2**attempt, 0.5))


def write_json_atomic(path: Path, data: Any, *, create_dirs: bool = False) -> None:
    """Write via temp file + rename so a crash never leaves a half-written file.

    Directories are only created when `create_dirs` is set, so a write can never resurrect the
    folder of a project that was deleted meanwhile."""
    if create_dirs:
        path.parent.mkdir(parents=True, exist_ok=True)
    elif not path.parent.is_dir():
        raise StorageError(f"Folder {path.parent} no longer exists.", code="LOCAL_DIR_MISSING")
    payload = json.dumps(data, indent=2, ensure_ascii=False, default=_json_default)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(payload)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        _retry_on_lock(lambda: os.replace(tmp, path))
    except OSError as exc:
        raise StorageError(
            f"Could not write {path.name}: {exc.strerror or exc}",
            hint=f"Check that {path.parent} is writable and the file isn't open in another program.",
        ) from exc
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def move_to(src: Path, dest: Path) -> None:
    """Atomic rename within app_data (same volume). Never falls back to copy-then-delete, which
    could leave a half-moved folder if a file is open."""
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        _retry_on_lock(lambda: os.replace(src, dest))
    except OSError as exc:
        raise StorageError(
            f"Could not move {src.name}: {exc.strerror or exc}",
            hint="Close any program that has files in this project open, then try again.",
        ) from exc


def read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except json.JSONDecodeError as exc:
        raise StorageError(
            f"{path.name} is not valid JSON (line {exc.lineno}, column {exc.colno}).",
            code="LOCAL_FILE_CORRUPT",
            hint=f"Fix or remove the file: {path}",
        ) from exc
    except OSError as exc:
        raise StorageError(f"Could not read {path.name}: {exc.strerror or exc}") from exc


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.projects_dir = root / "projects"
        self.trash_dir = root / ".trash"
        self._locks: defaultdict[str, threading.RLock] = defaultdict(threading.RLock)
        self._locks_guard = threading.Lock()
        try:
            self.projects_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise StorageError(f"Cannot create data directory {root}: {exc}") from exc

    # ----------------------------------------------------------------- utils
    def lock(self, project_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks[project_id]

    def _project_dir(self, project_id: str) -> Path:
        if not PROJECT_ID_RE.fullmatch(project_id):
            raise NotFoundError(f"Project '{project_id}' not found")
        return self.projects_dir / project_id

    def _require_project(self, project_id: str) -> Path:
        path = self._project_dir(project_id)
        if not (path / "project.json").is_file():
            raise NotFoundError(f"Project '{project_id}' not found")
        return path

    def _annotations_dir(self, project_id: str) -> Path:
        ann_dir = self._require_project(project_id) / "annotations"
        ann_dir.mkdir(exist_ok=True)
        return ann_dir

    # -------------------------------------------------------------- projects
    def list_projects(self) -> list[Project]:
        projects = []
        for child in sorted(self.projects_dir.iterdir()):
            if not child.is_dir() or not (child / "project.json").exists():
                continue
            try:
                projects.append(self.get(child.name))
            except Exception as exc:  # one bad file must not hide every project
                log.warning("Skipping project %s: %s", child.name, exc)
        projects.sort(key=lambda p: p.updated_at, reverse=True)
        return projects

    def get(self, project_id: str) -> Project:
        with self.lock(project_id):
            path = self._require_project(project_id) / "project.json"
            raw = read_json(path)
        try:
            return Project.model_validate(raw)
        except PydanticValidationError as exc:
            raise StorageError(
                f"project.json for '{project_id}' has invalid content.",
                code="LOCAL_FILE_CORRUPT",
                hint=str(exc.errors()[0].get("msg")) if exc.errors() else None,
            ) from exc

    def create(self, name: str, description: str = "") -> Project:
        base = slugify(name)
        for _ in range(10):
            project_id = f"{base}-{secrets.token_hex(3)}"
            if not (self.projects_dir / project_id).exists():
                break
        else:  # pragma: no cover
            raise StorageError("Could not allocate a project id")
        project = Project(id=project_id, name=name.strip(), description=description.strip())
        with self.lock(project_id):
            project_dir = self.projects_dir / project_id
            (project_dir / "annotations").mkdir(parents=True, exist_ok=True)
            write_json_atomic(project_dir / "project.json", project.model_dump(mode="json"))
        return project

    def save(self, project: Project, touch: bool = True) -> Project:
        if touch:
            project.updated_at = utcnow()
        with self.lock(project.id):
            path = self._require_project(project.id) / "project.json"
            write_json_atomic(path, project.model_dump(mode="json"))
        return project

    def delete(self, project_id: str) -> Path:
        with self.lock(project_id):
            src = self._require_project(project_id)
            dest = unique_path(self.trash_dir / f"{project_id}_{timestamp()}")
            move_to(src, dest)
        return dest

    # ----------------------------------------------------------- annotations
    def annotation_path(self, project_id: str, key: str, index: dict[str, IndexEntry] | None = None) -> Path:
        """Where this video's annotations live: the indexed file if there is one (older files use a
        longer naming scheme), otherwise the standard name."""
        with self.lock(project_id):
            ann_dir = self._annotations_dir(project_id)
            entry = (index if index is not None else self.load_index(project_id)).get(key)
            if entry and (ann_dir / entry.file).is_file():
                return ann_dir / entry.file
            return ann_dir / video_file_name(key)

    def get_annotation(self, project_id: str, key: str) -> VideoAnnotation | None:
        with self.lock(project_id):
            path = self.annotation_path(project_id, key)
            if not path.exists():
                return None
            raw = read_json(path)
        try:
            return VideoAnnotation.model_validate(raw)
        except PydanticValidationError as exc:
            raise StorageError(
                f"Annotation file for '{key}' has invalid content.",
                code="LOCAL_FILE_CORRUPT",
                hint=f"Fix or remove {path}",
            ) from exc

    def quarantine_annotation(self, project_id: str, key: str) -> Path | None:
        """Move an unreadable annotation file to the trash so the video can be saved again."""
        with self.lock(project_id):
            src = self.annotation_path(project_id, key)
            if not src.exists():
                return None
            dest = unique_path(self.trash_dir / project_id / "corrupt-annotations" / f"{src.stem}_{timestamp()}.json")
            move_to(src, dest)
            log.warning("Moved unreadable annotation %s to %s", src.name, dest)
            return dest

    def clear_annotation(self, project_id: str, key: str) -> Path | None:
        """Remove a video's saved annotations. The file is moved to app_data/.trash, never erased.
        Returns where it went, or None if nothing was saved."""
        with self.lock(project_id):
            index = self.load_index(project_id)
            src = self.annotation_path(project_id, key, index)
            dest = None
            if src.exists():
                dest = unique_path(
                    self.trash_dir / project_id / "cleared-annotations" / f"{src.stem}_{timestamp()}.json"
                )
                move_to(src, dest)
            if index.pop(key, None) is not None or dest:
                self._write_index(project_id, index)
        return dest

    def save_annotation(self, project_id: str, annotation: VideoAnnotation) -> VideoAnnotation:
        if not annotation.video_key:
            raise ValidationError("video_key is required")
        with self.lock(project_id):
            index = self.load_index(project_id)
            path = self.annotation_path(project_id, annotation.video_key, index)
            write_json_atomic(path, annotation.model_dump(mode="json"))
            index[annotation.video_key] = IndexEntry(
                status=annotation.status,
                event_count=len(annotation.events),
                updated_at=annotation.updated_at,
                file=path.name,
                bucket=annotation.bucket,
            )
            self._write_index(project_id, index)
        return annotation

    def load_index(self, project_id: str) -> dict[str, IndexEntry]:
        """Status of every annotated video. Rebuilt from the files whenever it is missing, corrupt
        or out of sync with them (e.g. a file restored from .trash, or an interrupted save)."""
        with self.lock(project_id):
            ann_dir = self._annotations_dir(project_id)
            path = ann_dir / INDEX_FILE
            if path.exists():
                try:
                    raw = read_json(path)
                    index = {k: IndexEntry.model_validate(v) for k, v in raw.items()}
                    on_disk = {
                        e.name
                        for e in os.scandir(ann_dir)
                        if e.is_file() and e.name.endswith(".json") and e.name != INDEX_FILE and not e.name.startswith(".")
                    }
                    if on_disk == {entry.file for entry in index.values()}:
                        return index
                    log.info("Index for %s is out of sync with its files; rebuilding", project_id)
                except (StorageError, PydanticValidationError, AttributeError) as exc:
                    log.warning("Rebuilding corrupt index for %s: %s", project_id, exc)
            return self._rebuild_index(project_id)

    def _rebuild_index(self, project_id: str) -> dict[str, IndexEntry]:
        ann_dir = self._annotations_dir(project_id)
        index: dict[str, IndexEntry] = {}
        for file in sorted(ann_dir.glob("*.json")):
            if file.name == INDEX_FILE or file.name.startswith("."):
                continue
            try:
                ann = VideoAnnotation.model_validate(read_json(file))
            except Exception as exc:
                log.warning("Ignoring unreadable annotation %s: %s", file.name, exc)
                continue
            index[ann.video_key] = IndexEntry(
                status=ann.status,
                event_count=len(ann.events),
                updated_at=ann.updated_at,
                file=file.name,
                bucket=ann.bucket,
            )
        self._write_index(project_id, index)
        return index

    def _write_index(self, project_id: str, index: dict[str, IndexEntry]) -> None:
        data = {k: v.model_dump(mode="json") for k, v in sorted(index.items())}
        write_json_atomic(self._annotations_dir(project_id) / INDEX_FILE, data)

    def iter_annotations(self, project_id: str) -> tuple[list[VideoAnnotation], list[str]]:
        """All readable annotations, plus a warning for each file that could not be read."""
        out: list[VideoAnnotation] = []
        warnings: list[str] = []
        with self.lock(project_id):
            for key in self.load_index(project_id):
                try:
                    ann = self.get_annotation(project_id, key)
                except StorageError as exc:
                    warnings.append(f"Skipped {key}: {exc.message}")
                    continue
                if ann:
                    out.append(ann)
        return out, warnings

    def stats(self, project: Project) -> ProgressStats:
        """Progress of what the queue shows: the current bucket and folder. Annotations left from an
        earlier folder stay on disk but are not counted against this folder's videos."""
        stats = ProgressStats()
        try:
            index = self.load_index(project.id)
        except (StorageError, NotFoundError):
            return stats
        prefix = project.storage.normalized_prefix
        for key, entry in index.items():
            if entry.status in ("completed", "in_progress"):
                stats.all_annotated += 1
            if entry.bucket not in (None, project.storage.bucket) or not key.startswith(prefix):
                continue
            if entry.status == "completed":
                stats.completed += 1
            elif entry.status == "in_progress":
                stats.in_progress += 1
            stats.total_events += entry.event_count
        return stats

    # --------------------------------------------------------------- exports
    def write_export(self, project: Project, data: dict) -> Path:
        with self.lock(project.id):
            exports = self._require_project(project.id) / "exports"
            path = unique_path(exports / f"{slugify(project.name)}_{timestamp()}.json")
            write_json_atomic(path, data, create_dirs=True)
        return path
