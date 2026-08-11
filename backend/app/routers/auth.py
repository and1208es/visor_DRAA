import logging
from collections import defaultdict, deque
from threading import Lock
from time import monotonic

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import settings
from ..database import get_db
from ..security import create_access_token, get_current_admin, verify_password

router = APIRouter(prefix="/api/auth", tags=["autenticación"])
logger = logging.getLogger(__name__)
failed_attempts: dict[str, deque[float]] = defaultdict(deque)
attempts_lock = Lock()


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _prune_and_check(ip: str) -> bool:
    cutoff = monotonic() - settings.login_window_minutes * 60
    with attempts_lock:
        attempts = failed_attempts[ip]
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if not attempts:
            failed_attempts.pop(ip, None)
            return False
        return len(attempts) >= settings.max_login_attempts


def _record_failure(ip: str) -> None:
    with attempts_lock:
        failed_attempts[ip].append(monotonic())


def _clear_failures(ip: str) -> None:
    with attempts_lock:
        failed_attempts.pop(ip, None)


@router.post("/login", response_model=schemas.TokenResponse)
def login(payload: schemas.LoginRequest, request: Request, db: Session = Depends(get_db)):
    ip = _client_ip(request)
    if _prune_and_check(ip):
        logger.warning("Login bloqueado por límite de intentos para IP %s", ip)
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Demasiados intentos. Inténtalo nuevamente más tarde.")
    user = db.scalar(select(models.User).where(models.User.username == payload.username))
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        _record_failure(ip)
        logger.warning("Login fallido para usuario %s desde IP %s", payload.username, ip)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Usuario o contraseña incorrectos")
    _clear_failures(ip)
    logger.info("Login correcto para usuario %s desde IP %s", user.username, ip)
    return {"access_token": create_access_token(user), "token_type": "bearer", "user": user}


@router.get("/me", response_model=schemas.AdminResponse)
def current_admin(admin: models.User = Depends(get_current_admin)):
    return admin
