from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProjectBase(BaseModel):
    nombre_proyecto: str = Field(min_length=1, max_length=300)
    provincia: str | None = None
    distrito: str | None = None
    comunidad: str | None = None
    estado: str | None = None
    fecha_inicio: str | None = None
    presupuesto: float | None = Field(default=None, ge=0)
    beneficiarios: int | None = Field(default=None, ge=0)
    descripcion: str | None = None
    latitud: float | None = Field(default=None, ge=-90, le=90)
    longitud: float | None = Field(default=None, ge=-180, le=180)


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    nombre_proyecto: str | None = Field(default=None, min_length=1, max_length=300)
    provincia: str | None = None
    distrito: str | None = None
    comunidad: str | None = None
    estado: str | None = None
    fecha_inicio: str | None = None
    presupuesto: float | None = Field(default=None, ge=0)
    beneficiarios: int | None = Field(default=None, ge=0)
    descripcion: str | None = None
    latitud: float | None = Field(default=None, ge=-90, le=90)
    longitud: float | None = Field(default=None, ge=-180, le=180)


class ProjectPhotoResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    url: str
    original_name: str
    mime_type: str
    size_bytes: int
    sort_order: int
    is_primary: bool
    created_at: datetime


class ProjectPhotoUpdate(BaseModel):
    is_primary: bool | None = None
    sort_order: int | None = Field(default=None, ge=0)


class ProjectResponse(ProjectBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    activo: bool
    created_at: datetime
    updated_at: datetime
    photos: list[ProjectPhotoResponse] = Field(default_factory=list)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=500)


class AdminResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: AdminResponse
