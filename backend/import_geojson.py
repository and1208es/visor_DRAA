import json
import os
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent
GEOJSON_PATH = BACKEND_DIR.parent / "public" / "data" / "proyectos.geojson"

# La URL SQLite del backend es relativa; fijar el cwd permite ejecutar este archivo
# de forma predecible incluso si se invoca desde otro directorio.
os.chdir(BACKEND_DIR)

from sqlalchemy import select  # noqa: E402
from sqlalchemy.exc import SQLAlchemyError  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models import Project  # noqa: E402


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def to_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip().replace("S/", "").replace(" ", "")
        if not value:
            return None
        if "," in value and "." in value:
            value = value.replace(",", "")
        elif "," in value:
            value = value.replace(",", ".")
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_int(value: Any) -> int | None:
    number = to_float(value)
    if number is None:
        return None
    try:
        return int(number)
    except (OverflowError, ValueError):
        return None


def normalize_key_part(value: Any) -> str:
    text = clean_text(value) or ""
    text = unicodedata.normalize("NFD", text)
    text = "".join(character for character in text if unicodedata.category(character) != "Mn")
    return " ".join(text.casefold().split())


def duplicate_key(nombre: Any, provincia: Any, distrito: Any) -> tuple[str, str, str]:
    return (
        normalize_key_part(nombre),
        normalize_key_part(provincia),
        normalize_key_part(distrito),
    )


def read_geojson() -> dict[str, Any]:
    if not GEOJSON_PATH.is_file():
        raise FileNotFoundError(f"No existe el archivo GeoJSON: {GEOJSON_PATH}")
    try:
        with GEOJSON_PATH.open("r", encoding="utf-8-sig") as source:
            data = json.load(source)
    except json.JSONDecodeError as error:
        raise ValueError(f"El archivo no contiene JSON válido: {error}") from error
    if data.get("type") != "FeatureCollection":
        raise ValueError("El GeoJSON debe tener type='FeatureCollection'")
    if not isinstance(data.get("features"), list):
        raise ValueError("El campo features del GeoJSON debe ser una lista")
    return data


def point_coordinates(geometry: Any) -> tuple[float | None, float | None]:
    if not isinstance(geometry, dict) or geometry.get("type") != "Point":
        return None, None
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return None, None
    longitude = to_float(coordinates[0])
    latitude = to_float(coordinates[1])
    if latitude is not None and not -90 <= latitude <= 90:
        latitude = None
    if longitude is not None and not -180 <= longitude <= 180:
        longitude = None
    return latitude, longitude


def import_projects() -> int:
    try:
        data = read_geojson()
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    features = data["features"]
    geometry_types = Counter(
        feature.get("geometry", {}).get("type", "Sin geometría")
        if isinstance(feature, dict) and isinstance(feature.get("geometry"), dict)
        else "Sin geometría"
        for feature in features
    )
    inserted = 0
    skipped = 0
    errors = 0
    db = SessionLocal()
    try:
        Base.metadata.create_all(bind=engine)
        existing = db.scalars(select(Project)).all()
        known_keys = {
            duplicate_key(item.nombre_proyecto, item.provincia, item.distrito)
            for item in existing
        }

        for index, feature in enumerate(features, start=1):
            try:
                if not isinstance(feature, dict):
                    raise ValueError("la feature no es un objeto")
                properties = feature.get("properties") or {}
                if not isinstance(properties, dict):
                    raise ValueError("properties no es un objeto")

                nombre = clean_text(properties.get("nombre_proyecto"))
                if not nombre:
                    raise ValueError("nombre_proyecto es obligatorio")
                provincia = clean_text(properties.get("provincia"))
                distrito = clean_text(properties.get("distrito"))
                key = duplicate_key(nombre, provincia, distrito)
                if key in known_keys:
                    skipped += 1
                    print(f"Omitido por duplicado: {nombre}")
                    continue

                latitude, longitude = point_coordinates(feature.get("geometry"))
                db.add(Project(
                    nombre_proyecto=nombre,
                    provincia=provincia,
                    distrito=distrito,
                    comunidad=clean_text(properties.get("comunidad")),
                    estado=clean_text(properties.get("estado")),
                    fecha_inicio=clean_text(properties.get("fecha_inicio")),
                    presupuesto=to_float(properties.get("presupuesto")),
                    beneficiarios=to_int(properties.get("beneficiarios")),
                    descripcion=clean_text(properties.get("descripcion")),
                    latitud=latitude,
                    longitud=longitude,
                    activo=True,
                ))
                known_keys.add(key)
                inserted += 1
            except (TypeError, ValueError) as error:
                errors += 1
                print(f"Error en feature {index}: {error}", file=sys.stderr)

        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        print(f"Error grave de base de datos; se revirtió la importación: {error}", file=sys.stderr)
        return 1
    finally:
        db.close()

    geometry_summary = ", ".join(f"{name}: {count}" for name, count in sorted(geometry_types.items()))
    print("\nImportación completada")
    print(f"Total GeoJSON: {len(features)}")
    print(f"Geometrías: {geometry_summary}")
    print(f"Insertados: {inserted}")
    print(f"Omitidos por duplicado: {skipped}")
    print(f"Errores: {errors}")
    return 0


if __name__ == "__main__":
    raise SystemExit(import_projects())
