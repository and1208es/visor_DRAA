import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

from app.config import BACKEND_DIR
from app.database import DATABASE_PATH
from backup import create_backup

UPLOADS_DIR = BACKEND_DIR / "uploads"


def _validate_zip(archive: zipfile.ZipFile, target: Path) -> None:
    root = target.resolve()
    for member in archive.infolist():
        destination = (target / member.filename).resolve()
        if destination != root and root not in destination.parents:
            raise RuntimeError("uploads.zip contiene una ruta insegura.")


def restore(folder: Path) -> None:
    source_db = folder / "proyectos.db"
    source_uploads = folder / "uploads.zip"
    if not source_db.is_file():
        raise FileNotFoundError(f"Falta {source_db}")
    if not source_uploads.is_file():
        raise FileNotFoundError(f"Falta {source_uploads}")
    with sqlite3.connect(source_db) as check:
        if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("La base del backup no es válida.")
    preventative = create_backup()
    print(f"Backup preventivo creado: {preventative}")
    with tempfile.TemporaryDirectory(dir=BACKEND_DIR) as temporary:
        extraction = Path(temporary)
        with zipfile.ZipFile(source_uploads) as archive:
            _validate_zip(archive, extraction)
            archive.extractall(extraction)
        restored_uploads = extraction / "uploads"
        if not restored_uploads.is_dir():
            raise RuntimeError("uploads.zip no contiene la carpeta uploads/.")
        DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(source_db) as source, sqlite3.connect(DATABASE_PATH) as target:
            source.backup(target)
        if UPLOADS_DIR.exists():
            shutil.rmtree(UPLOADS_DIR)
        shutil.copytree(restored_uploads, UPLOADS_DIR)


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: python restore_backup.py <carpeta-backup>", file=sys.stderr)
        return 2
    folder = Path(sys.argv[1]).expanduser().resolve()
    try:
        if not (folder / "proyectos.db").is_file():
            raise FileNotFoundError(f"Falta {folder / 'proyectos.db'}")
        if not (folder / "uploads.zip").is_file():
            raise FileNotFoundError(f"Falta {folder / 'uploads.zip'}")
        answer = input(f"Se restaurará {folder}. Escribe RESTAURAR para continuar: ")
        if answer != "RESTAURAR":
            print("Restauración cancelada.")
            return 1
        restore(folder)
    except Exception as error:
        print(f"Error de restauración: {error}", file=sys.stderr)
        return 1
    print("Restauración completada.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
