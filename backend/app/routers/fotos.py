from io import BytesIO
import logging
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import settings
from ..database import get_db
from ..security import get_current_admin

# TODO SECURITY: proteger subida, modificación y borrado con autenticación y autorización antes del despliegue público.
router = APIRouter(prefix="/api/proyectos/{project_id}/fotos", tags=["fotografías"])
logger = logging.getLogger(__name__)
BACKEND_DIR = Path(__file__).resolve().parents[2]
UPLOADS_DIR = (BACKEND_DIR / "uploads").resolve()
PROJECT_UPLOADS_DIR = (UPLOADS_DIR / "proyectos").resolve()
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}
MAX_FILE_SIZE = settings.max_upload_mb * 1024 * 1024
MAX_PHOTOS = 8
MAX_IMAGE_SIDE = 1600
MAX_IMAGE_PIXELS = 40_000_000


def active_project(project_id: int, db: Session) -> models.Project:
    project = db.scalar(select(models.Project).where(models.Project.id == project_id, models.Project.activo.is_(True)))
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proyecto no encontrado")
    return project


def project_directory(project_id: int) -> Path:
    directory = (PROJECT_UPLOADS_DIR / str(project_id)).resolve()
    if PROJECT_UPLOADS_DIR not in directory.parents:
        raise HTTPException(status_code=400, detail="Ruta de almacenamiento inválida")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def photo_path(photo: models.ProjectPhoto) -> Path:
    path = (UPLOADS_DIR / photo.file_path).resolve()
    if UPLOADS_DIR not in path.parents:
        raise HTTPException(status_code=400, detail="Ruta de fotografía inválida")
    return path


def optimize_image(content: bytes, mime_type: str) -> bytes:
    if mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=422, detail="Formato no admitido. Usa JPG, PNG o WebP.")
    if not content:
        raise HTTPException(status_code=422, detail="La fotografía está vacía.")
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=422, detail=f"La fotografía supera el tamaño máximo de {settings.max_upload_mb} MB.")
    try:
        with Image.open(BytesIO(content)) as source:
            if source.format not in ALLOWED_IMAGE_FORMATS:
                raise HTTPException(status_code=422, detail="El contenido del archivo no es una imagen admitida.")
            if source.width <= 0 or source.height <= 0 or source.width * source.height > MAX_IMAGE_PIXELS:
                raise HTTPException(status_code=422, detail="Las dimensiones de la fotografía son demasiado grandes.")
            image = ImageOps.exif_transpose(source)
            image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "transparency" in image.info else "RGB")
            output = BytesIO()
            image.save(output, format="WEBP", quality=83, method=6)
            return output.getvalue()
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail="El archivo no contiene una imagen válida.") from error


def commit_or_storage_error(db: Session) -> None:
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=500, detail="No fue posible guardar los metadatos de las fotografías.") from error


@router.get("", response_model=list[schemas.ProjectPhotoResponse])
def list_photos(project_id: int, db: Session = Depends(get_db)):
    active_project(project_id, db)
    return db.scalars(select(models.ProjectPhoto).where(models.ProjectPhoto.project_id == project_id).order_by(models.ProjectPhoto.sort_order, models.ProjectPhoto.id)).all()


@router.post("", response_model=list[schemas.ProjectPhotoResponse], status_code=status.HTTP_201_CREATED)
async def upload_photos(project_id: int, files: list[UploadFile] = File(...), db: Session = Depends(get_db), _admin: models.User = Depends(get_current_admin)):
    active_project(project_id, db)
    current_count = db.scalar(select(func.count(models.ProjectPhoto.id)).where(models.ProjectPhoto.project_id == project_id)) or 0
    if not files:
        raise HTTPException(status_code=422, detail="Selecciona al menos una fotografía.")
    if current_count + len(files) > MAX_PHOTOS:
        raise HTTPException(status_code=422, detail=f"El proyecto admite como máximo {MAX_PHOTOS} fotografías.")
    next_order = db.scalar(select(func.max(models.ProjectPhoto.sort_order)).where(models.ProjectPhoto.project_id == project_id))
    next_order = 0 if next_order is None else next_order + 1
    directory = project_directory(project_id)
    created_records: list[models.ProjectPhoto] = []
    created_paths: list[Path] = []
    try:
        for index, upload in enumerate(files):
            content = await upload.read(MAX_FILE_SIZE + 1)
            optimized = optimize_image(content, upload.content_type or "")
            filename = f"photo_{uuid4().hex}.webp"
            target = (directory / filename).resolve()
            if directory not in target.parents:
                raise HTTPException(status_code=400, detail="Nombre de archivo inválido")
            target.write_bytes(optimized)
            logger.info("Fotografía guardada: %s", target)
            created_paths.append(target)
            record = models.ProjectPhoto(
                project_id=project_id, filename=filename, file_path=f"proyectos/{project_id}/{filename}",
                original_name=Path(upload.filename or "imagen").name[:300], mime_type="image/webp",
                size_bytes=len(optimized), sort_order=next_order + index, is_primary=current_count == 0 and index == 0,
            )
            db.add(record)
            created_records.append(record)
        commit_or_storage_error(db)
        for record in created_records:
            db.refresh(record)
        logger.info("%s fotografía(s) añadida(s) al proyecto %s", len(created_records), project_id)
        return created_records
    except Exception:
        db.rollback()
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise
    finally:
        for upload in files:
            await upload.close()


@router.patch("/{photo_id}", response_model=schemas.ProjectPhotoResponse)
def update_photo(project_id: int, photo_id: int, payload: schemas.ProjectPhotoUpdate, db: Session = Depends(get_db), _admin: models.User = Depends(get_current_admin)):
    active_project(project_id, db)
    photo = db.scalar(select(models.ProjectPhoto).where(models.ProjectPhoto.id == photo_id, models.ProjectPhoto.project_id == project_id))
    if photo is None:
        raise HTTPException(status_code=404, detail="Fotografía no encontrada")
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("is_primary") is True:
        db.execute(update(models.ProjectPhoto).where(models.ProjectPhoto.project_id == project_id).values(is_primary=False))
    for field, value in changes.items():
        setattr(photo, field, value)
    commit_or_storage_error(db)
    db.refresh(photo)
    return photo


@router.delete("/{photo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_photo(project_id: int, photo_id: int, db: Session = Depends(get_db), _admin: models.User = Depends(get_current_admin)):
    active_project(project_id, db)
    photo = db.scalar(select(models.ProjectPhoto).where(models.ProjectPhoto.id == photo_id, models.ProjectPhoto.project_id == project_id))
    if photo is None:
        raise HTTPException(status_code=404, detail="Fotografía no encontrada")
    path = photo_path(photo)
    backup = path.read_bytes() if path.is_file() else None
    was_primary = photo.is_primary
    try:
        path.unlink(missing_ok=True)
    except OSError as error:
        raise HTTPException(status_code=500, detail="No fue posible eliminar el archivo de la fotografía.") from error
    db.delete(photo)
    db.flush()
    if was_primary:
        replacement = db.scalar(select(models.ProjectPhoto).where(models.ProjectPhoto.project_id == project_id).order_by(models.ProjectPhoto.sort_order, models.ProjectPhoto.id))
        if replacement:
            replacement.is_primary = True
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        if backup is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(backup)
        raise HTTPException(status_code=500, detail="No fue posible eliminar los metadatos de la fotografía.") from error
    logger.info("Fotografía %s eliminada del proyecto %s", photo_id, project_id)
