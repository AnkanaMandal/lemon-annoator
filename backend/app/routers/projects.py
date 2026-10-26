from fastapi import APIRouter, Depends, status

from .. import s3_service
from ..config import get_settings
from ..deps import get_store, to_public
from ..errors import ConflictError
from ..models import (
    ConnectionTestResult,
    ProjectCreate,
    ProjectPublic,
    ProjectUpdate,
    StorageUpdate,
)
from ..storage import ProjectStore

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectPublic])
def list_projects(store: ProjectStore = Depends(get_store)):
    return [to_public(p, store) for p in store.list_projects()]


@router.post("", response_model=ProjectPublic, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate, store: ProjectStore = Depends(get_store)):
    return to_public(store.create(body.name, body.description), store)


@router.get("/{project_id}", response_model=ProjectPublic)
def get_project(project_id: str, store: ProjectStore = Depends(get_store)):
    return to_public(store.get(project_id), store)


@router.patch("/{project_id}", response_model=ProjectPublic)
def update_project(project_id: str, body: ProjectUpdate, store: ProjectStore = Depends(get_store)):
    with store.lock(project_id):
        project = store.get(project_id)
        if body.name is not None:
            project.name = body.name.strip()
        if body.description is not None:
            project.description = body.description.strip()
        if body.storage is not None:
            before = (project.storage.bucket, project.storage.normalized_prefix)
            new_storage = body.storage.apply_to(project.storage)
            # Annotations are stored per S3 key; mixing two buckets in one project would attach
            # one bucket's labels to same-named videos in the other.
            if project.storage.bucket and new_storage.bucket != project.storage.bucket:
                annotated = sum(1 for e in store.load_index(project_id).values() if e.bucket in (None, project.storage.bucket))
                if annotated:
                    raise ConflictError(
                        f'This project already has {annotated} annotated video{"s" if annotated != 1 else ""} '
                        f'from bucket "{project.storage.bucket}".',
                        code="BUCKET_HAS_ANNOTATIONS",
                        hint="Create a new project for a different bucket (or clear those annotations first).",
                    )
            project.storage = new_storage
            if before != (project.storage.bucket, project.storage.normalized_prefix):
                project.last_sync = None
        if body.label_schema is not None:
            project.label_schema = body.label_schema
        if body.settings is not None:
            project.settings = body.settings
        store.save(project)
    return to_public(project, store)


@router.delete("/{project_id}", status_code=status.HTTP_200_OK)
def delete_project(project_id: str, store: ProjectStore = Depends(get_store)):
    """Marks the project deleted; its rows stay in the database and can be restored."""
    deleted_at = store.delete(project_id)
    return {"ok": True, "deleted_at": deleted_at}


@router.post("/{project_id}/storage/test", response_model=ConnectionTestResult)
def test_storage(
    project_id: str,
    body: StorageUpdate | None = None,
    store: ProjectStore = Depends(get_store),
):
    """Test the saved settings, or unsaved edits merged over them when a body is sent."""
    project = store.get(project_id)
    cfg = body.apply_to(project.storage) if body else project.storage
    return s3_service.test_connection(cfg, get_settings().max_list_keys)
