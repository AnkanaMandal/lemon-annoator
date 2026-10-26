import logging
from contextlib import asynccontextmanager

import psycopg
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg_pool import PoolTimeout

from . import __version__
from .auth import current_user
from .config import get_settings
from .deps import get_store
from .errors import AppError
from .routers import export, projects, videos

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("lemon")

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Connect and create the tables at startup, so a bad LEMON_DATABASE_URL fails the deploy loudly.
    store = get_store()
    log.info("Database ready (schema %s)", store.db.schema)
    if not settings.supabase_url and not settings.supabase_jwt_secret:
        log.warning("LEMON_SUPABASE_URL is not set: every signed-in request will be refused.")
    yield
    store.db.close()


app = FastAPI(title="Lemon API", version=__version__, lifespan=lifespan)

# The browser calls the API directly (from the Vercel app) with a bearer token; no cookies are used.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AppError)
async def app_error_handler(_: Request, exc: AppError):
    if exc.status_code >= 500:
        log.error("%s: %s", exc.code, exc.message)
    return JSONResponse(status_code=exc.status_code, content={"error": exc.to_dict()})


@app.exception_handler(psycopg.OperationalError)
@app.exception_handler(PoolTimeout)
async def database_error_handler(_: Request, exc: Exception):
    log.error("Database unavailable: %s", exc)
    return JSONResponse(
        status_code=503,
        content={"error": {"code": "DATABASE_UNAVAILABLE", "message": "The database is not reachable right now.",
                           "hint": "Try again in a moment. If it persists, check that the Supabase project is "
                                   "not paused.", "details": {}}},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError):
    errors = exc.errors()
    first = errors[0] if errors else {}
    location = ".".join(str(p) for p in first.get("loc", []) if p != "body")
    message = first.get("msg", "Invalid request").removeprefix("Value error, ")
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": f"{location}: {message}" if location else message,
                "hint": None,
                "details": {"errors": [{"loc": e.get("loc"), "msg": e.get("msg")} for e in errors]},
            }
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_: Request, exc: Exception):
    log.exception("Unhandled error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": str(exc) or "Internal server error",
                           "hint": "See the API logs for the stack trace.", "details": {}}},
    )


@app.get("/api/health")
def health():
    """Public (no sign-in): used by Render's health check and by scripts/dev.mjs."""
    return {"ok": True, "app": "lemon", "version": __version__}


signed_in = [Depends(current_user)]
app.include_router(projects.router, dependencies=signed_in)
app.include_router(videos.router, dependencies=signed_in)
app.include_router(export.router, dependencies=signed_in)
