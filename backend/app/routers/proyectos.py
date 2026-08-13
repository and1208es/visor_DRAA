import logging

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..security import get_current_admin

router = APIRouter(prefix="/api/proyectos", tags=["proyectos"])
logger = logging.getLogger(__name__)


def get_active_project(project_id: int, db: Session) -> models.Project:
    project = db.scalar(
        select(models.Project).where(
            models.Project.id == project_id,
            models.Project.activo.is_(True),
        )
    )
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proyecto no encontrado")
    return project


def commit_or_500(db: Session) -> None:
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No fue posible guardar los cambios del proyecto",
        ) from error


@router.get("", response_model=list[schemas.ProjectResponse])
def list_projects(db: Session = Depends(get_db)):
    return db.scalars(
        select(models.Project)
        .where(models.Project.activo.is_(True))
        .order_by(models.Project.id)
    ).all()


@router.get("/{project_id}", response_model=schemas.ProjectResponse)
def get_project(project_id: int, db: Session = Depends(get_db)):
    return get_active_project(project_id, db)


@router.post("", response_model=schemas.ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(payload: schemas.ProjectCreate, db: Session = Depends(get_db), _admin: models.User = Depends(get_current_admin)):
    values = payload.model_dump()
    latitude, longitude = values.get("latitud"), values.get("longitud")
    project = models.Project(**values)
    if latitude is not None and longitude is not None:
        project.locations.append(models.ProjectLocation(latitude=latitude, longitude=longitude, sort_order=0))
    db.add(project)
    commit_or_500(db)
    db.refresh(project)
    logger.info("Proyecto %s creado por administrador %s", project.id, _admin.username)
    return project


@router.patch("/{project_id}", response_model=schemas.ProjectResponse)
def update_project(project_id: int, payload: schemas.ProjectUpdate, db: Session = Depends(get_db), _admin: models.User = Depends(get_current_admin)):
    project = get_active_project(project_id, db)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    if "latitud" in payload.model_fields_set or "longitud" in payload.model_fields_set:
        if project.latitud is not None and project.longitud is not None:
            if project.locations:
                project.locations[0].latitude = project.latitud
                project.locations[0].longitude = project.longitud
            else:
                project.locations.append(models.ProjectLocation(latitude=project.latitud, longitude=project.longitud, sort_order=0))
    commit_or_500(db)
    db.refresh(project)
    logger.info("Proyecto %s editado por administrador %s", project.id, _admin.username)
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: int, db: Session = Depends(get_db), _admin: models.User = Depends(get_current_admin)):
    project = get_active_project(project_id, db)
    project.activo = False
    commit_or_500(db)
    logger.info("Proyecto %s desactivado por administrador %s", project.id, _admin.username)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
