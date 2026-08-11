import logging
import shutil
import sqlite3
import sys
import zipfile
from datetime import datetime
from pathlib import Path

from app.config import BACKEND_DIR, settings
from app.database import DATABASE_PATH

BACKUPS_DIR = BACKEND_DIR / "backups"
UPLOADS_DIR = BACKEND_DIR / "uploads"
logger = logging.getLogger(__name__)


def _size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def _backup_sqlite(destination: Path) -> None:
    if not DATABASE_PATH.is_file():
        raise FileNotFoundError(f"No existe la base SQLite: {DATABASE_PATH}")
    with sqlite3.connect(DATABASE_PATH) as source, sqlite3.connect(destination) as target:
        source.backup(target)
    with sqlite3.connect(destination) as check:
        if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("La copia SQLite no superó la comprobación de integridad.")


def _backup_uploads(destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("uploads/", "")
        if UPLOADS_DIR.is_dir():
            for item in UPLOADS_DIR.rglob("*"):
                if item.is_file():
                    archive.write(item, Path("uploads") / item.relative_to(UPLOADS_DIR))


def _apply_retention(current: Path) -> None:
    backups = sorted((item for item in BACKUPS_DIR.iterdir() if item.is_dir() and not item.name.startswith(".")), key=lambda item: item.stat().st_mtime, reverse=True)
    for old_backup in backups[settings.backup_retention:]:
        if old_backup != current:
            shutil.rmtree(old_backup)


def create_backup() -> Path:
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    final_dir = BACKUPS_DIR / stamp
    if final_dir.exists():
        final_dir = BACKUPS_DIR / f"{stamp}_{datetime.now().microsecond:06d}"
    try:
        final_dir.mkdir()
        _backup_sqlite(final_dir / "proyectos.db")
        _backup_uploads(final_dir / "uploads.zip")
        _apply_retention(final_dir)
        logger.info("Backup completado en %s", final_dir)
        return final_dir
    except Exception:
        shutil.rmtree(final_dir, ignore_errors=True)
        raise


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        backup_dir = create_backup()
    except Exception as error:
        print(f"Error de backup: {error}", file=sys.stderr)
        return 1
    print("Backup completado")
    print(f"Base: {backup_dir / 'proyectos.db'}")
    print(f"Fotografías: {backup_dir / 'uploads.zip'}")
    print(f"Fecha: {datetime.now().isoformat(timespec='seconds')}")
    print(f"Tamaño total: {_size(backup_dir)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
