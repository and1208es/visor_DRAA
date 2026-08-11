import logging
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")
logger = logging.getLogger(__name__)


def _integer(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        logger.warning("%s no es un entero válido; se usará %s", name, default)
        return default


def _boolean(name: str, default: bool) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


def _list(name: str, default: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in os.getenv(name, default).split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    environment: str
    secret_key: str | None
    access_token_expire_minutes: int
    allowed_origins: tuple[str, ...]
    allowed_hosts: tuple[str, ...]
    max_login_attempts: int
    login_window_minutes: int
    max_upload_mb: int
    enable_docs: bool
    backup_retention: int

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}

    def validate(self) -> None:
        if self.is_production and not self.secret_key:
            raise RuntimeError("DRAA_SECRET_KEY es obligatoria en producción.")
        if self.secret_key and len(self.secret_key.encode("utf-8")) < 32:
            logger.warning("DRAA_SECRET_KEY es demasiado corta; use al menos 32 bytes de entropía.")
        if "*" in self.allowed_origins:
            raise RuntimeError("DRAA_ALLOWED_ORIGINS no puede contener '*' cuando CORS usa credenciales.")


settings = Settings(
    environment=os.getenv("DRAA_ENV", "development"),
    secret_key=os.getenv("DRAA_SECRET_KEY") or None,
    access_token_expire_minutes=_integer("ACCESS_TOKEN_EXPIRE_MINUTES", 480),
    allowed_origins=_list("DRAA_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"),
    allowed_hosts=_list("DRAA_ALLOWED_HOSTS", "localhost,127.0.0.1"),
    max_login_attempts=_integer("MAX_LOGIN_ATTEMPTS", 5),
    login_window_minutes=_integer("LOGIN_WINDOW_MINUTES", 10),
    max_upload_mb=_integer("MAX_UPLOAD_MB", 8),
    enable_docs=_boolean("DRAA_ENABLE_DOCS", True),
    backup_retention=_integer("BACKUP_RETENTION", 7),
)
settings.validate()


def require_secret_key() -> str:
    if not settings.secret_key:
        raise RuntimeError("La autenticación no está configurada: defina DRAA_SECRET_KEY.")
    return settings.secret_key
