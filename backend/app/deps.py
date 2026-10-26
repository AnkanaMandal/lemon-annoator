from functools import lru_cache

from .config import get_settings
from .models import Project, ProjectPublic, StoragePublic
from .storage import ProjectStore


@lru_cache
def get_store() -> ProjectStore:
    return ProjectStore(get_settings().data_dir)


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
        stats=store.stats(project),
    )
