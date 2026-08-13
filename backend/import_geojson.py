"""Importación limpia: un proyecto lógico y múltiples ubicaciones."""

import asyncio
import json
import shutil
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

from sqlalchemy import func, select, text

BACKEND_DIR = Path(__file__).resolve().parent
GEOJSON_PATH = BACKEND_DIR.parent / "public" / "data" / "proyectos.geojson"
PROJECT_UPLOADS_DIR = BACKEND_DIR / "uploads" / "proyectos"

from app.database import SessionLocal  # noqa: E402
from app.models import Project, ProjectLocation, ProjectPhoto, User  # noqa: E402
from backup import create_backup  # noqa: E402


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def optional_number(value: Any, field: str, *, integer: bool = False) -> float | int | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field} no es un número válido")
    candidate = value
    if isinstance(candidate, str):
        candidate = candidate.strip().replace("S/", "").replace(" ", "")
        if "," in candidate and "." in candidate:
            candidate = candidate.replace(",", "")
        elif "," in candidate:
            candidate = candidate.replace(",", ".")
    try:
        number = float(candidate)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} no es un número válido: {value!r}") from error
    if integer:
        if not number.is_integer():
            raise ValueError(f"{field} debe ser entero")
        return int(number)
    return number


def point_coordinates(geometry: Any, number: int) -> tuple[float, float]:
    if not isinstance(geometry, dict) or geometry.get("type") != "Point":
        raise ValueError(f"feature {number}: la geometría debe ser Point")
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, (list, tuple)) or len(coordinates) < 2:
        raise ValueError(f"feature {number}: Point requiere longitud y latitud")
    longitude = optional_number(coordinates[0], "longitud")
    latitude = optional_number(coordinates[1], "latitud")
    if longitude is None or not -180 <= longitude <= 180:
        raise ValueError(f"feature {number}: longitud fuera de rango")
    if latitude is None or not -90 <= latitude <= 90:
        raise ValueError(f"feature {number}: latitud fuera de rango")
    return float(latitude), float(longitude)


def normalize_status(value: Any) -> str | None:
    status = clean_text(value)
    if status is None:
        return None
    return {"planificado": "Planificado", "en ejecucion": "En ejecución", "en ejecución": "En ejecución", "finalizado": "Finalizado"}.get(status.casefold(), status)


def load_and_validate_geojson() -> tuple[int, list[dict[str, Any]], list[str]]:
    if not GEOJSON_PATH.is_file():
        raise FileNotFoundError(f"No existe el archivo GeoJSON: {GEOJSON_PATH}")
    try:
        with GEOJSON_PATH.open("r", encoding="utf-8-sig") as source:
            data = json.load(source, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"constante JSON no válida: {value}")))
    except json.JSONDecodeError as error:
        raise ValueError(f"El archivo no contiene JSON válido: {error}") from error
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise ValueError("El GeoJSON debe tener type='FeatureCollection'")
    features = data.get("features")
    if not isinstance(features, list) or not features:
        raise ValueError("El GeoJSON debe contener al menos una feature")

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for number, feature in enumerate(features, start=1):
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError(f"feature {number}: debe ser de tipo Feature")
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            raise ValueError(f"feature {number}: properties debe ser un objeto")
        project_key = clean_text(properties.get("id_proyecto") or properties.get("id_proy"))
        if not project_key:
            raise ValueError(f"feature {number}: falta id_proyecto/id_proy")
        name = clean_text(properties.get("nombre_proyecto") or properties.get("proyecto"))
        if not name:
            raise ValueError(f"feature {number}: falta el nombre del proyecto")
        latitude, longitude = point_coordinates(feature.get("geometry"), number)
        groups[project_key].append({"properties": properties, "latitude": latitude, "longitude": longitude})

    projects: list[dict[str, Any]] = []
    warnings: list[str] = []
    general_fields = {
        "nombre_proyecto": ("nombre_proyecto", "proyecto"), "provincia": ("provincia",), "distrito": ("distrito",),
        "comunidad": ("comunidad",), "estado": ("estado",), "fecha_inicio": ("fecha_inicio", "fecha_inic"),
        "presupuesto": ("presupuesto", "presupuest"), "beneficiarios": ("beneficiarios", "beneficiar"),
        "descripcion": ("descripcion", "descripcio"),
    }
    for project_key, records in groups.items():
        first = records[0]["properties"]
        values: dict[str, Any] = {"id_proyecto": project_key}
        for target, candidates in general_fields.items():
            raw_values = [next((record["properties"].get(name) for name in candidates if record["properties"].get(name) is not None), None) for record in records]
            distinct = {str(value).strip() for value in raw_values if value is not None and str(value).strip()}
            if len(distinct) > 1:
                warnings.append(f"{project_key}: valores contradictorios en {target}: {sorted(distinct)!r}")
            raw = next((first.get(name) for name in candidates if first.get(name) is not None), None)
            if target == "presupuesto": values[target] = optional_number(raw, target)
            elif target == "beneficiarios": values[target] = optional_number(raw, target, integer=True)
            elif target == "estado": values[target] = normalize_status(raw)
            else: values[target] = clean_text(raw)
        if not values["nombre_proyecto"]:
            raise ValueError(f"{project_key}: el primer registro no tiene nombre")
        values["latitud"] = records[0]["latitude"]
        values["longitud"] = records[0]["longitude"]
        values["activo"] = True
        values["locations"] = [(record["latitude"], record["longitude"]) for record in records]
        projects.append(values)
    return len(features), projects, warnings


def stage_old_photos() -> tuple[Path, int]:
    PROJECT_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="import_geojson_", dir=BACKEND_DIR / "uploads"))
    count = 0
    try:
        for item in PROJECT_UPLOADS_DIR.iterdir():
            if item.name == ".gitkeep":
                continue
            count += 1 if item.is_file() else sum(child.is_file() for child in item.rglob("*"))
            shutil.move(str(item), staging / item.name)
        (PROJECT_UPLOADS_DIR / ".gitkeep").touch(exist_ok=True)
        return staging, count
    except Exception:
        restore_staged_photos(staging)
        raise


def restore_staged_photos(staging: Path) -> None:
    for item in staging.iterdir():
        shutil.move(str(item), PROJECT_UPLOADS_DIR / item.name)
    staging.rmdir()


def rebuild_project_tables(db) -> None:
    connection = db.connection()
    db.execute(text("DROP TABLE IF EXISTS project_photos"))
    db.execute(text("DROP TABLE IF EXISTS project_locations"))
    db.execute(text("DROP TABLE IF EXISTS proyectos"))
    Project.__table__.create(bind=connection)
    ProjectLocation.__table__.create(bind=connection)
    ProjectPhoto.__table__.create(bind=connection)


def verify_api(expected: dict[str, int]) -> None:
    from app.main import app

    async def request() -> tuple[int, bytes]:
        messages: list[dict[str, Any]] = []
        sent = False
        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": b"", "more_body": False}
            return {"type": "http.disconnect"}
        async def send(message): messages.append(message)
        scope = {"type":"http", "asgi":{"version":"3.0"}, "http_version":"1.1", "method":"GET", "scheme":"http", "path":"/api/proyectos", "raw_path":b"/api/proyectos", "query_string":b"", "headers":[(b"host", b"localhost")], "client":("127.0.0.1", 0), "server":("localhost", 80), "root_path":""}
        await app(scope, receive, send)
        status = next(item["status"] for item in messages if item["type"] == "http.response.start")
        body = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
        return status, body

    status, body = asyncio.run(request())
    payload = json.loads(body)
    if status != 200 or not isinstance(payload, list) or len(payload) != len(expected):
        raise RuntimeError("GET /api/proyectos no devolvió la cantidad esperada")
    actual = {item["id_proyecto"]: len(item["locations"]) for item in payload}
    if actual != expected:
        raise RuntimeError(f"Ubicaciones de API incorrectas: {actual!r}")


def import_projects() -> int:
    try:
        feature_count, projects, warnings = load_and_validate_geojson()
    except (OSError, ValueError) as error:
        print(f"Error de validación: {error}", file=sys.stderr)
        return 1
    for warning in warnings:
        print(f"Advertencia: {warning}", file=sys.stderr)
    answer = input("Se reemplazarán todos los proyectos, ubicaciones y fotografías.\n¿Desea continuar? (SI/NO) ")
    if answer.strip() != "SI":
        print("Importación cancelada. SQLite no fue modificado.")
        return 0
    try:
        backup_dir = create_backup()
    except Exception as error:
        print(f"Error de backup; importación abortada: {error}", file=sys.stderr)
        return 1
    print(f"Backup completado: {backup_dir}")

    db = SessionLocal()
    staging = None
    physical_photos = 0
    expected_locations = {project["id_proyecto"]: len(project["locations"]) for project in projects}
    try:
        users_before = db.scalar(select(func.count()).select_from(User)) or 0
        staging, physical_photos = stage_old_photos()
        rebuild_project_tables(db)
        for values in projects:
            locations = values["locations"]
            project = Project(**{key: value for key, value in values.items() if key != "locations"})
            project.locations = [ProjectLocation(latitude=latitude, longitude=longitude, sort_order=index) for index, (latitude, longitude) in enumerate(locations)]
            db.add(project)
        db.flush()
        project_count = db.scalar(select(func.count()).select_from(Project)) or 0
        location_count = db.scalar(select(func.count()).select_from(ProjectLocation)) or 0
        users_after = db.scalar(select(func.count()).select_from(User)) or 0
        if project_count != len(projects) or location_count != feature_count or users_after != users_before:
            raise RuntimeError("las cantidades de control no coinciden")
        db.commit()
    except Exception as error:
        db.rollback()
        if staging is not None:
            try: restore_staged_photos(staging)
            except Exception as restore_error: print(f"Error restaurando fotografías: {restore_error}", file=sys.stderr)
        print(f"Error; se revirtió la importación: {error}", file=sys.stderr)
        return 1
    finally:
        db.close()

    assert staging is not None
    shutil.rmtree(staging)
    try:
        verify_api(expected_locations)
    except Exception as error:
        print(f"Error de comprobación de API: {error}", file=sys.stderr)
        return 1
    print("\nImportación completada.")
    print(f"Features GeoJSON: {feature_count}")
    print(f"Proyectos únicos: {len(projects)}")
    print(f"Ubicaciones importadas: {feature_count}")
    print(f"Fotografías anteriores eliminadas: {physical_photos}")
    print("Errores: 0")
    return 0


if __name__ == "__main__":
    raise SystemExit(import_projects())
