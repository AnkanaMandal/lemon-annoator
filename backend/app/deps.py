from functools import lru_cache

from .config import get_settings
from .db import Database
from .models import Project, ProjectPublic, StoragePublic
from .storage import ProjectStore


@lru_cache
def get_store() -> ProjectStore:
    settings = get_settings()
    return ProjectStore(Database(settings.database_url, settings.db_schema))


def to_public(project: Project, store: ProjectStore) -> ProjectPublic:
    return ProjectPublic(
        id=project.id,
        name=project.name,
        description=project.description,
        created_at=project.created_at,
        updated_at=project.updated_at,
        storage=StoragePublic.from_config(project.storage),
        label_schema=project.label_schema,
        settings=project.settings,
        last_sync=project.last_sync,
        stats=store.stats(project.id),
    )
