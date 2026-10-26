from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# The only containers the queue picks up from the bucket (matched case-insensitively).
VIDEO_EXTENSIONS = (".mp4", ".mov")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Label schema
# --------------------------------------------------------------------------- #

# checkbox: one true/false flag          select: single value from a dropdown
# choices:  a visible list of options (single, or multiple when `multiple`)   text: free text
FieldType = Literal["checkbox", "select", "choices", "text"]


class SchemaField(BaseModel):
    """One attribute that is recorded alongside every event."""

    key: str = Field(pattern=r"^[a-z0-9][a-z0-9_]*$", max_length=64)
    label: str = Field(min_length=1, max_length=80)
    type: FieldType
    options: list[str] = Field(default_factory=list)
    default: bool | str | None = None
    multiple: bool = Field(False, description="choices only: allow several options at once")
    required: bool = Field(False, description="must be filled in before an event can be captured")
    placeholder: str = Field("", max_length=200, description="text only")
    # "video": one answer per video, saved with it (Label Studio's default for a control).
    # "event": recorded with every captured timestamp (Label Studio's perRegion="true").
    scope: Literal["video", "event"] = "event"

    @model_validator(mode="after")
    def _check(self) -> "SchemaField":
        self.label = self.label.strip()
        self.options = _dedupe([o.strip() for o in self.options if o.strip()])
        if self.type in ("select", "choices"):
            if not self.options:
                kind = "Dropdown" if self.type == "select" else "Choices"
                raise ValueError(f'{kind} "{self.label}" needs at least one option')
            # A default must be one of the options; multi-select groups start empty.
            if self.multiple or self.default not in self.options:
                self.default = None
        elif self.type == "checkbox":
            self.options = []
            self.default = bool(self.default)
            self.required = False
        else:
            self.options = []
            self.default = self.default if isinstance(self.default, str) else ""
        if self.type != "choices":
            self.multiple = False
        if self.type != "text":
            self.placeholder = ""
        return self


class LabelSchema(BaseModel):
    event_types: list[str] = Field(default_factory=list)
    fields: list[SchemaField] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self) -> "LabelSchema":
        self.event_types = [t.strip() for t in self.event_types if t.strip()]
        lowered = [t.lower() for t in self.event_types]
        if len(set(lowered)) != len(lowered):
            raise ValueError("Event types must be unique")
        keys = [f.key for f in self.fields]
        if len(set(keys)) != len(keys):
            raise ValueError("Attribute keys must be unique")
        labels = [f.label.lower() for f in self.fields]
        if len(set(labels)) != len(labels):
            raise ValueError("Attribute labels must be unique")
        return self


# --------------------------------------------------------------------------- #
# Project
# --------------------------------------------------------------------------- #


class StorageConfig(BaseModel):
    """S3 connection settings as persisted in project.json.

    Empty access keys mean "use the default AWS credential chain"
    (env vars, ~/.aws/credentials, SSO, instance role...)."""

    access_key_id: str = ""
    secret_access_key: str = ""
    session_token: str = ""
    region: str = "us-east-1"
    bucket: str = ""
    prefix: str = ""
    endpoint_url: str = ""

    @property
    def is_configured(self) -> bool:
        return bool(self.bucket)

    @property
    def normalized_prefix(self) -> str:
        """The prefix as a folder: "videos/2024" -> "videos/2024/" so sibling folders such as
        "videos/2024-old/" are not swept in. Empty means the whole bucket."""
        prefix = self.prefix.strip().strip("/")
        return f"{prefix}/" if prefix else ""


class StoragePublic(BaseModel):
    """Storage settings as returned to the browser (secrets masked)."""

    access_key_id: str
    has_secret_access_key: bool
    has_session_token: bool
    region: str
    bucket: str
    prefix: str
    endpoint_url: str
    is_configured: bool

    @classmethod
    def from_config(cls, cfg: StorageConfig) -> "StoragePublic":
        return cls(
            access_key_id=cfg.access_key_id,
            has_secret_access_key=bool(cfg.secret_access_key),
            has_session_token=bool(cfg.session_token),
            region=cfg.region,
            bucket=cfg.bucket,
            prefix=cfg.prefix,
            endpoint_url=cfg.endpoint_url,
            is_configured=cfg.is_configured,
        )


class StorageUpdate(BaseModel):
    """Partial update. For secrets: `None` keeps the saved value, `""` clears it."""

    access_key_id: str | None = None
    secret_access_key: str | None = None
    session_token: str | None = None
    region: str | None = None
    bucket: str | None = None
    prefix: str | None = None
    endpoint_url: str | None = None

    # AWS keys never contain whitespace, so a stray space or newline from pasting is always a mistake.
    @field_validator("access_key_id", "secret_access_key", "session_token", "region", "bucket", "prefix", "endpoint_url")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v

    def apply_to(self, cfg: StorageConfig) -> StorageConfig:
        data = cfg.model_dump()
        for name, value in self.model_dump(exclude_unset=True).items():
            if value is None:
                continue
            data[name] = value
        if not data["region"]:
            data["region"] = "us-east-1"
        return StorageConfig(**data)


class ProjectSettings(BaseModel):
    fps: float = Field(30, gt=0, le=240)
    skip_seconds: float = Field(5, gt=0, le=600)
    url_expiry_seconds: int = Field(3600, ge=300, le=43200)


class SyncInfo(BaseModel):
    """Result of the latest bucket listing (a "sync")."""

    video_count: int
    synced_at: datetime
    # Videos uploaded since the previous sync; None on the first sync of a bucket/folder.
    new_count: int | None = None
    total_bytes: int | None = None
    truncated: bool = False


class Project(BaseModel):
    """The full contents of app_data/projects/<id>/project.json."""

    version: int = 1
    id: str
    name: str
    description: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    storage: StorageConfig = Field(default_factory=StorageConfig)
    label_schema: LabelSchema = Field(default_factory=LabelSchema)
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    last_sync: SyncInfo | None = None


class ProgressStats(BaseModel):
    # completed / in_progress / total_events cover the current bucket and folder (what the queue shows).
    completed: int = 0
    in_progress: int = 0
    total_events: int = 0
    # Annotated videos in every folder and bucket: everything that deleting the project moves to the trash.
    all_annotated: int = 0


class ProjectPublic(BaseModel):
    id: str
    name: str
    description: str
    created_at: datetime
    updated_at: datetime
    storage: StoragePublic
    label_schema: LabelSchema
    settings: ProjectSettings
    last_sync: SyncInfo | None
    stats: ProgressStats


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field("", max_length=500)


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = Field(None, max_length=500)
    storage: StorageUpdate | None = None
    label_schema: LabelSchema | None = None
    settings: ProjectSettings | None = None


# --------------------------------------------------------------------------- #
# Videos & annotations
# --------------------------------------------------------------------------- #

VideoStatus = Literal["not_started", "in_progress", "completed"]


class AnnotationEvent(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=64)
    timestamp: float = Field(ge=0, description="Seconds from the start of the video")
    time: str = Field("", description="Human readable HH:MM:SS.mmm")
    frame: int | None = Field(None, ge=0)
    event_name: str | None = None
    checkboxes: dict[str, bool] = Field(default_factory=dict)
    # Dropdown / single choice / text -> str | None; multiple choice -> list of selected options.
    attributes: dict[str, str | list[str] | None] = Field(default_factory=dict)
    note: str = Field("", max_length=2000)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class VideoAnnotation(BaseModel):
    """The contents of app_data/projects/<id>/annotations/<video>.json."""

    version: int = 1
    video_key: str
    video_filename: str
    bucket: str | None = Field(None, description="Bucket the video was annotated from")
    s3_uri: str
    streaming_url: str | None = None
    streaming_url_expires_at: datetime | None = None
    status: VideoStatus = "in_progress"
    duration_seconds: float | None = None
    fps: float | None = None
    event_count: int = 0
    events: list[AnnotationEvent] = Field(default_factory=list)
    # Answers for whole-video fields: checkbox -> bool, others -> str | list[str] | None.
    labels: dict[str, bool | str | list[str] | None] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    # Set from the database row, not stored in `data`: how many times it was saved, and by whom.
    revision: int = 0
    updated_by: str | None = None


class AnnotationSave(BaseModel):
    # The revision this save is based on (0: none saved yet). If someone else saved since, the save is
    # refused with a conflict instead of overwriting their work. Omit to save unconditionally.
    base_revision: int | None = Field(None, ge=0)
    status: Literal["in_progress", "completed"] = "in_progress"
    events: list[AnnotationEvent] = Field(default_factory=list, max_length=20_000)
    labels: dict[str, bool | str | list[str] | None] = Field(default_factory=dict)
    streaming_url: str | None = None
    streaming_url_expires_at: datetime | None = None
    duration_seconds: float | None = Field(None, ge=0)


class IndexEntry(BaseModel):
    status: VideoStatus
    event_count: int
    updated_at: datetime
    bucket: str | None = None
    revision: int = 1
    updated_by: str | None = None


class VideoItem(BaseModel):
    key: str
    filename: str
    size: int | None = None
    last_modified: datetime | None = None
    status: VideoStatus = "not_started"
    event_count: int = 0
    annotated_at: datetime | None = None
    annotated_by: str | None = None
    missing: bool = Field(False, description="Annotated but no longer in the bucket")


class VideoList(BaseModel):
    videos: list[VideoItem]
    truncated: bool
    bucket: str
    prefix: str
    sync: SyncInfo


class StreamUrl(BaseModel):
    key: str
    url: str
    expires_at: datetime


class VideoDetails(BaseModel):
    key: str
    filename: str
    folder: str
    extension: str
    bucket: str
    region: str
    s3_uri: str
    console_url: str | None = Field(None, description="AWS console link (only for real AWS)")
    # From S3 (None when the object could not be read)
    size: int | None = None
    content_type: str | None = None
    last_modified: datetime | None = None
    etag: str | None = None
    storage_class: str | None = None
    user_metadata: dict[str, str] = Field(default_factory=dict)
    s3_error: str | None = None
    # Local annotation state
    status: VideoStatus = "not_started"
    event_count: int = 0
    annotated_at: datetime | None = None
    annotated_by: str | None = None
    streaming_url: str | None = None
    duration_seconds: float | None = None


class ClearResult(BaseModel):
    key: str
    cleared: bool


class Presence(BaseModel):
    user_id: str
    name: str
    video_key: str | None
    seen_at: datetime


class PresenceUpdate(BaseModel):
    key: str | None = None


class VideoActivity(BaseModel):
    status: VideoStatus
    event_count: int
    annotated_at: datetime
    annotated_by: str | None
    revision: int


class ProjectActivity(BaseModel):
    """What changed since the queue was listed: saved status per video, and who is on which video."""

    me: str
    videos: dict[str, VideoActivity]
    presence: list[Presence]


class ConnectionTestResult(BaseModel):
    ok: bool
    bucket: str
    region: str
    prefix: str
    video_count: int
    sample_keys: list[str]
    truncated: bool


class ExportResult(BaseModel):
    filename: str
    export_id: int
    video_count: int
    event_count: int
    warnings: list[str]
    data: dict


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for item in items:
        if item.lower() not in seen:
            seen.add(item.lower())
            out.append(item)
    return out
