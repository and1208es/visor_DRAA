import getpass
import os
from pathlib import Path

from sqlalchemy import select

BACKEND_DIR = Path(__file__).resolve().parent
os.chdir(BACKEND_DIR)

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models import User  # noqa: E402
from app.security import hash_password  # noqa: E402


def ask_password() -> str:
    while True:
        password = getpass.getpass("Contraseña: ")
        confirmation = getpass.getpass("Confirmar contraseña: ")
        if len(password) < 10:
            print("La contraseña debe tener al menos 10 caracteres.")
        elif password != confirmation:
            print("Las contraseñas no coinciden.")
        else:
            return password


def main() -> None:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        existing = db.scalar(select(User).order_by(User.id))
        if existing:
            print(f"Ya existe el administrador: {existing.username} ({existing.full_name})")
            answer = input("¿Deseas actualizar su contraseña? [s/N]: ").strip().lower()
            if answer not in {"s", "si", "sí", "y", "yes"}:
                print("No se realizaron cambios.")
                return
            existing.password_hash = hash_password(ask_password())
            existing.is_active = True
            db.commit()
            print("Contraseña del administrador actualizada correctamente.")
            return

        username = input("Usuario: ").strip()
        full_name = input("Nombre completo: ").strip()
        if not username or not full_name:
            print("Usuario y nombre completo son obligatorios.")
            return
        db.add(User(username=username, full_name=full_name, password_hash=hash_password(ask_password()), is_active=True))
        db.commit()
        print("Administrador creado correctamente.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
