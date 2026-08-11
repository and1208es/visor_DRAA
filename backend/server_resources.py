import os
import platform
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

import psutil

from app.config import BACKEND_DIR
from app.database import DATABASE_PATH

PROJECT_DIR = BACKEND_DIR.parent
DIST_DIR = PROJECT_DIR / "dist"
UPLOADS_DIR = BACKEND_DIR / "uploads"
BACKUPS_DIR = BACKEND_DIR / "backups"
REPORTS_DIR = BACKEND_DIR / "reports"
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MB = 1024 * 1024


def mb(value: int | float) -> float:
    return float(value) / MB


def format_mb(value: int | float) -> str:
    return f"{mb(value):,.2f} MB"


def files_under(directory: Path):
    if not directory.is_dir():
        return []
    return [item for item in directory.rglob("*") if item.is_file()]


def directory_size(directory: Path) -> int:
    return sum(item.stat().st_size for item in files_under(directory))


def frontend_stats() -> dict[str, int]:
    files = files_under(DIST_DIR)
    js = sum(item.stat().st_size for item in files if item.suffix.lower() == ".js")
    css = sum(item.stat().st_size for item in files if item.suffix.lower() == ".css")
    total = sum(item.stat().st_size for item in files)
    return {"files": len(files), "total": total, "js": js, "css": css, "other": total - js - css}


def backend_processes() -> list[dict[str, float | int]]:
    candidates = []
    for process in psutil.process_iter(["pid", "name", "cmdline", "memory_info", "num_threads"]):
        try:
            command = " ".join(process.info.get("cmdline") or []).lower()
            name = (process.info.get("name") or "").lower()
            if "python" not in name or "uvicorn" not in command or "app.main" not in command:
                continue
            process.cpu_percent(None)
            candidates.append(process)
        except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
    if candidates:
        time.sleep(0.2)
    result = []
    for process in candidates:
        try:
            result.append({
                "pid": process.pid,
                "ram": process.memory_info().rss,
                "cpu": process.cpu_percent(None),
                "threads": process.num_threads(),
            })
        except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
    return result


def sqlite_stats() -> dict[str, int | None]:
    size = DATABASE_PATH.stat().st_size if DATABASE_PATH.is_file() else 0
    result = {"size": size, "projects": None, "active_projects": None, "photos": None}
    if not DATABASE_PATH.is_file():
        return result
    connection = sqlite3.connect(f"file:{DATABASE_PATH.as_posix()}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "proyectos" in tables:
            result["projects"] = connection.execute("SELECT COUNT(*) FROM proyectos").fetchone()[0]
            result["active_projects"] = connection.execute("SELECT COUNT(*) FROM proyectos WHERE activo = 1").fetchone()[0]
        if "project_photos" in tables:
            result["photos"] = connection.execute("SELECT COUNT(*) FROM project_photos").fetchone()[0]
    finally:
        connection.close()
    return result


def photo_stats() -> dict[str, int | float]:
    photos = [item for item in files_under(UPLOADS_DIR) if item.suffix.lower() in PHOTO_EXTENSIONS]
    sizes = [item.stat().st_size for item in photos]
    total = sum(sizes)
    return {"count": len(photos), "total": total, "average": total / len(photos) if photos else 0, "largest": max(sizes, default=0)}


def backup_stats() -> dict[str, int]:
    backups = [item for item in BACKUPS_DIR.iterdir() if item.is_dir()] if BACKUPS_DIR.is_dir() else []
    return {"count": len(backups), "total": directory_size(BACKUPS_DIR)}


def build_report() -> str:
    measured_at = datetime.now()
    virtual_memory = psutil.virtual_memory()
    processes = backend_processes()
    frontend = frontend_stats()
    database = sqlite_stats()
    photos = photo_stats()
    backups = backup_stats()
    backend_ram = sum(int(item["ram"]) for item in processes)
    backend_cpu = sum(float(item["cpu"]) for item in processes)
    main_data = frontend["total"] + int(database["size"]) + int(photos["total"])
    total_with_backups = main_data + backups["total"]
    lines = [
        "=" * 60,
        "        DIAGNÓSTICO DE RECURSOS - VISOR_DRAA",
        "=" * 60,
        f"Fecha: {measured_at.isoformat(sep=' ', timespec='seconds')}",
        "",
        "EQUIPO",
        f"Sistema operativo: {platform.system()} {platform.release()} ({platform.machine()})",
        f"Python: {platform.python_version()}",
        f"CPUs lógicas: {os.cpu_count() or 'No disponible'}",
        f"RAM total: {format_mb(virtual_memory.total)}",
        f"RAM disponible: {format_mb(virtual_memory.available)}",
        "",
        "CONSUMO MEDIDO - BACKEND",
    ]
    if processes:
        for item in processes:
            lines.append(f"PID {item['pid']}: RAM {format_mb(item['ram'])} | CPU {item['cpu']:.1f}% | Threads {item['threads']}")
        lines.extend([f"Total procesos: {len(processes)}", f"RAM observada del backend: {format_mb(backend_ram)}", f"CPU total observada: {backend_cpu:.1f}%"])
    else:
        lines.extend(["FastAPI/Uvicorn: no se detectó un proceso activo relacionado con app.main.", "RAM observada del backend: no disponible sin un proceso activo."])
    lines.extend([
        "",
        "FRONTEND COMPILADO",
        f"Frontend compilado: {format_mb(frontend['total'])}",
        f"Archivos: {frontend['files']} | JS: {format_mb(frontend['js'])} | CSS: {format_mb(frontend['css'])} | Otros: {format_mb(frontend['other'])}",
        "El frontend compilado se sirve como archivos estáticos y no requiere un proceso Node/Vite permanente en producción.",
        "",
        "DATOS",
        f"Base SQLite: {format_mb(database['size'])}",
        f"Proyectos: {database['projects'] if database['projects'] is not None else 'No disponible'}",
        f"Proyectos activos: {database['active_projects'] if database['active_projects'] is not None else 'No disponible'}",
        f"Fotografías registradas en SQLite: {database['photos'] if database['photos'] is not None else 'No disponible'}",
        f"Fotografías físicas: {photos['count']}",
        f"Tamaño fotografías: {format_mb(photos['total'])}",
        f"Promedio por fotografía: {format_mb(photos['average']) if photos['count'] else 'No disponible (no existen fotografías)'}",
        f"Fotografía más grande: {format_mb(photos['largest']) if photos['count'] else 'No disponible'}",
        f"Backups: {backups['count']} | Espacio separado: {format_mb(backups['total'])}",
        "",
        "RESUMEN VISOR_DRAA",
        f"Frontend dist        {format_mb(frontend['total'])}",
        f"SQLite               {format_mb(database['size'])}",
        f"Fotografías          {format_mb(photos['total'])}",
        f"Backups              {format_mb(backups['total'])}",
        "--------------------------------",
        f"Datos principales    {format_mb(main_data)}",
        f"Total con backups    {format_mb(total_with_backups)}",
        "No se contabilizan .venv, node_modules ni .git.",
        "",
        "PROYECCIÓN DE ALMACENAMIENTO (NO ES CONSUMO ACTUAL)",
    ])
    if photos["count"]:
        for projects in (100, 500, 1000):
            projected_photos = photos["average"] * projects * 3
            projected_main = frontend["total"] + int(database["size"]) + projected_photos
            projected_with_backups = projected_main + 7 * (int(database["size"]) + projected_photos)
            lines.append(f"{projects} proyectos × 3 fotos: fotografías ≈ {format_mb(projected_photos)} | datos ≈ {format_mb(projected_main)} | con 7 backups ≈ {format_mb(projected_with_backups)}")
        lines.append("Las estimaciones usan exclusivamente el promedio real de las fotografías actuales; no estiman crecimiento de SQLite.")
    else:
        lines.append("No se generan proyecciones: todavía no existen fotografías para obtener un promedio real.")
    lines.extend(["", "ESTIMACIÓN PARA SERVIDOR"])
    if backend_ram:
        lines.append(f"RAM orientativa para la aplicación con 50% de margen: {format_mb(backend_ram * 1.5)}.")
    else:
        lines.append("RAM orientativa: no calculable hasta medir FastAPI/Uvicorn en ejecución.")
    lines.extend([
        "La medición local no representa exactamente la carga de producción.",
        "La capacidad final debe añadir margen para logs y sistema operativo; no se cuantifican porque no hay mediciones disponibles.",
        "=" * 60,
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    report = build_report()
    print(report, end="")
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    destination = REPORTS_DIR / f"server_resources_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    destination.write_text(report, encoding="utf-8")
    print(f"Informe guardado: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
